import type { LlmChoice, ProcessingStep } from "@meeting-bot/contracts";
import { EXTERNAL_ASR_ID, providerLabel, transcribeFileExternal } from "./asr/openrouter";
import { runTranscriptionJob, type JobChannelResult, type JobFile } from "./asr/workerClient";
import { config } from "./config";
import { getMeeting, listAudio, markDone, setMeetingStatus } from "./db";
import { applyCallNames, labelUndiarized, markSegmentModeSpeakers } from "./meetings/applyCallNames";
import { markDirty } from "./search/dirty";
import { automaticProvider, generationLabel } from "./llm";
import { hub } from "./live/hub";
import { countFinalSegments, defaultSpeaker, EvidenceRemapper, NewSegment, replaceWithFinal } from "./repo/transcripts";
import { classifyError } from "./usage/errorCode";
import { recordUsage } from "./usage/recorder";

/** all = transcrição final + análise; analysis = só a análise (ata); adrs = só os ADRs */
export type ProcessStep = "all" | "analysis" | "adrs";

export interface ProcessOptions {
  /** provedor escolhido na interface; sem ele, LLM_GENERATION_PROVIDER (automaticProvider) */
  llm?: LlmChoice;
  /** passo adrs: só a decisão arquitetural indicada */
  itemId?: string;
}

type Report = (step: ProcessingStep, progress?: number) => void;
export interface AdrRunSummary {
  generated: number;
  skipped: number;
  failed: number;
}

// Ganchos preenchidos pelos módulos do agente (US4), sem import circular.
type PostAnalysis = (meetingId: string, report: Report, provider: LlmChoice) => Promise<void>;
type AdrGeneration = (meetingId: string, report: Report, provider: LlmChoice, itemId?: string) => Promise<AdrRunSummary>;
let postAnalysis: PostAnalysis = async () => {};
let adrGeneration: AdrGeneration = async () => ({ generated: 0, skipped: 0, failed: 0 });
let evidenceRemapper: EvidenceRemapper | undefined;
let promptFor: (meetingId: string) => Promise<string | undefined> = async () => undefined;
let beforeFinalPass: (meetingId: string) => Promise<void> = async () => {};

export function setPostAnalysis(fn: PostAnalysis): void {
  postAnalysis = fn;
}

export function setAdrGeneration(fn: AdrGeneration): void {
  adrGeneration = fn;
}

export function setEvidenceRemapper(fn: EvidenceRemapper): void {
  evidenceRemapper = fn;
}

export function setBeforeFinalPass(fn: (meetingId: string) => Promise<void>): void {
  beforeFinalPass = fn;
}

export function setGlossaryProvider(fn: (meetingId: string) => Promise<string | undefined>): void {
  promptFor = fn;
}

// Fila sequencial: a GPU atende um processamento pós-reunião por vez.
let chain: Promise<void> = Promise.resolve();
const pending = new Set<string>();
let current: string | null = null;

export function isProcessing(meetingId: string): boolean {
  return pending.has(meetingId);
}

export function queueState(): { pending: number; current: string | null } {
  return { pending: pending.size, current };
}

function report(meetingId: string, step: ProcessingStep | null, progress?: number): void {
  hub.publishToMeeting(meetingId, { type: "processing", meetingId, step, progress });
}

function adrSummary(r: AdrRunSummary): string {
  const parts = [`${r.generated} ADR${r.generated === 1 ? "" : "s"} gerado${r.generated === 1 ? "" : "s"}`];
  if (r.skipped) parts.push(`${r.skipped} mantido${r.skipped === 1 ? "" : "s"} (aprovado, rejeitado ou editado)`);
  if (r.failed) parts.push(`${r.failed} com resposta inválida`);
  return `${parts.join(", ")}.`;
}

export function enqueueProcessing(meetingId: string, step: ProcessStep = "all", opts: ProcessOptions = {}): boolean {
  if (pending.has(meetingId)) return false;
  pending.add(meetingId);
  // Gerar só os ADRs não mexe no status da reunião (ela continua concluída).
  const onlyAdrs = step === "adrs";
  const queued = onlyAdrs ? Promise.resolve() : setMeetingStatus(meetingId, "queued").catch(console.error);
  let finalEvent: { error?: string; done?: string } = {};
  if (onlyAdrs) report(meetingId, "adrs", 0);
  chain = chain
    .then(() => queued)
    .then(async () => {
      current = meetingId;
      const resolve = () => providerFor(meetingId, opts.llm);
      if (onlyAdrs) {
        const provider = await resolve();
        const result = await adrGeneration(meetingId, (s, p) => report(meetingId, s, p), provider, opts.itemId);
        await markDirty(meetingId);
        finalEvent = { done: adrSummary(result) };
      } else {
        await processMeeting(meetingId, step, resolve);
        finalEvent = { done: "Ata gerada." };
      }
    })
    .catch(async (err) => {
      console.error(`[pipeline ${meetingId}] falhou:`, err);
      const message = `Falha no processamento: ${(err as Error).message}`;
      finalEvent = { error: message };
      if (!onlyAdrs) await setMeetingStatus(meetingId, "error", message).catch(console.error);
    })
    .finally(() => {
      pending.delete(meetingId);
      current = null;
      hub.publishToMeeting(meetingId, { type: "processing", meetingId, step: null, ...finalEvent });
    });
  return true;
}

async function providerFor(meetingId: string, requested: LlmChoice | undefined): Promise<LlmChoice> {
  if (requested) return requested;
  const meeting = await getMeeting(meetingId);
  return automaticProvider(meeting?.created_by ?? null, {
    waitMs: config.subscriptionWaitMs,
    onWait: (reason) => {
      console.warn(`[pipeline ${meetingId}] aguardando ${config.generationProvider}: ${reason}`);
      report(meetingId, "aguardando_assinatura", 0);
    },
  });
}

/** Passe final no Whisper local: uma linha de uso por passe (minutos de áudio e tempo de parede). */
async function runLocalFinalPass(
  meetingId: string,
  files: JobFile[],
  run: () => Promise<JobChannelResult[]>,
): Promise<JobChannelResult[]> {
  const started = Date.now();
  const record = (success: boolean, error: unknown, seconds: number) =>
    recordUsage({
      category: "asr",
      purpose: "asr_final",
      provider: "whisper",
      model: null,
      meetingId,
      inputTokens: null,
      outputTokens: null,
      audioSeconds: seconds,
      costUsd: null,
      durationMs: Date.now() - started,
      computeMs: null,
      attempts: 1,
      success,
      errorCode: success ? null : classifyError(error),
      label: `${files.length} canal(is)`,
    });
  try {
    const results = await run();
    record(true, null, results.reduce((sum, r) => sum + r.duration, 0));
    return results;
  } catch (err) {
    record(false, err, 0);
    throw err;
  }
}

/** Sem diarização, nomeia cada segmento pela linha do tempo da chamada (spec 006); falha aqui nunca derruba o passe final. */
async function nameFromCall(meetingId: string, segments: NewSegment[]): Promise<{ segments: NewSegment[]; names: string[] }> {
  if (!config.botSpeakerNames) return { segments, names: [] };
  try {
    return await labelUndiarized(meetingId, segments);
  } catch (err) {
    console.error(`[pipeline ${meetingId}] nomes da chamada por segmento:`, err);
    return { segments, names: [] };
  }
}

/** Casa os "Speaker N" do passe final com os nomes da chamada; falha só vai para o log. */
async function applyNamesFromCall(meetingId: string, segmentModeNames: string[]): Promise<void> {
  if (!config.botSpeakerNames) return;
  try {
    await markSegmentModeSpeakers(meetingId, segmentModeNames);
    await applyCallNames(meetingId);
  } catch (err) {
    console.error(`[pipeline ${meetingId}] nomes da chamada:`, err);
  }
}

/** O provedor é escolhido depois da transcrição: a espera pela assinatura não segura o passe final. */
async function processMeeting(
  meetingId: string,
  step: ProcessStep,
  resolveProvider: () => Promise<LlmChoice>,
): Promise<void> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;

  if (step === "all" || (await countFinalSegments(meetingId)) === 0) {
    const audio = (await listAudio(meetingId)).filter((a) => a.format !== "pcm_s16le_16k");
    if (!audio.length) throw new Error("Reunião sem áudio gravado.");
    await setMeetingStatus(meetingId, "transcribing");
    // A análise ao vivo fecha sobre os segmentos `live` antes de eles serem substituídos.
    report(meetingId, "analisando", 0);
    await beforeFinalPass(meetingId).catch((err) => console.error(`[pipeline ${meetingId}] agente ao vivo:`, err));
    report(meetingId, "transcrevendo", 0);

    const files: JobFile[] = audio.map((a) => ({ path: a.path, channel: a.channel, diarize: a.channel !== "mic" }));
    const external = (meeting.asr_provider ?? config.asrProvider) === EXTERNAL_ASR_ID;
    const started = Date.now();
    let results: JobChannelResult[];
    if (external) {
      // ASR externo de teste (Constituição 1.1.0): só no passe final/upload, por escolha explícita.
      results = [];
      for (const [i, file] of files.entries()) {
        results.push(
          await transcribeFileExternal(meetingId, file, { language: config.transcriptionLanguage }, (p) =>
            report(meetingId, "transcrevendo", (i + p) / files.length),
          ),
        );
      }
    } else {
      results = await runLocalFinalPass(meetingId, files, async () =>
        runTranscriptionJob(
          files,
          { language: config.transcriptionLanguage, prompt: await promptFor(meetingId) },
          (workerStep, progress) =>
            report(meetingId, workerStep === "diarizando" ? "diarizando" : "transcrevendo", progress),
        ),
      );
    }

    const segments: NewSegment[] = results
      .flatMap((r) =>
        r.segments.map((s) => ({
          channel: r.channel,
          speaker: defaultSpeaker(r.channel, s.speaker),
          text: s.text,
          start: s.start,
          end: s.end,
        })),
      )
      .sort((a, b) => a.start - b.start);
    const named = await nameFromCall(meetingId, segments);
    await replaceWithFinal(meetingId, named.segments, evidenceRemapper, external ? providerLabel() : "worker-gpu");
    await applyNamesFromCall(meetingId, named.names);
    hub.publishToMeeting(meetingId, { type: "transcript_replaced", meetingId });
    console.log(
      `[pipeline ${meetingId}] ${segments.length} segmentos via ${external ? providerLabel() : "worker-gpu"} (${results.map((r) => `${r.channel}${r.diarized ? "+falantes" : ""}`).join(", ")}) em ${Math.round((Date.now() - started) / 1000)}s`,
    );
    if (segments.length === 0) {
      throw new Error("Nenhuma fala reconhecida no áudio. Confira o áudio gravado na página da reunião.");
    }
  }

  // generating_ata com transcrição final: um reinício retoma só a análise (e a espera).
  await setMeetingStatus(meetingId, "generating_ata");
  const provider = await resolveProvider();
  report(meetingId, "analisando", 0);
  console.log(`[pipeline ${meetingId}] análise fora da máquina: ${generationLabel(provider)}`);
  await postAnalysis(meetingId, (s, p) => report(meetingId, s, p), provider);
  await markDone(meetingId);
  // reunião concluída: entra na fila de indexação da busca (nunca lança)
  await markDirty(meetingId);
}
