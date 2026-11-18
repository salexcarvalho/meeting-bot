import { mkdir, stat } from "fs/promises";
import path from "path";
import { Browser, Page } from "playwright";
import { ChildProcessWithoutNullStreams } from "child_process";

import { config } from "../config";
import { markEnded, markStarted, setAudioPath, setMeetingStatus } from "../db";
import { enqueueProcessing } from "../pipeline";
import { closeLiveSessions, liveSession } from "../recording/liveSession";
import { audit } from "../security/audit";
import { dropRuntime } from "../recording/runtime";
import { ClockAnchor } from "../recording/clockAnchor";
import { dropTimeline } from "../recording/speakerTimeline";
import { markTeamsSessionExpired, MAX_SESSION_BYTES, parseSession, refreshTeamsSession } from "../users/teamsAccount";
import { createSink, removeSink, startRecording, stopRecording } from "./audio";
import { launchBrowser } from "./browser";
import { createBlankCard, createCameraCard, type CameraCard } from "./card";
import { createCameraWatch } from "./cameraWatch";
import type { BotAccount, BotIdentity } from "./identity";
import { LeaveDecider } from "./leave";
import { drivers } from "./platforms";
import { JoinError, type JoinResult } from "./join";
import type { SpeakerCollector } from "./speakers/collector";
import { startSpeakerReader } from "./speakers/start";
import { activeBots as active, removeBot, setBotStage } from "./state";

export { activeBotCount, isBotActive } from "./state";

export const audioDir = path.join(config.dataDir, "audio");
export const debugDir = path.join(config.dataDir, "debug");

export function screenshotPath(meetingId: string): string {
  return path.join(debugDir, `${meetingId}.png`);
}

// Logado, o Teams carrega o app inteiro (36 s medidos; como convidado, ~6 s): 45 s não bastam.
const ACCOUNT_JOIN_TIMEOUT_MS = 120_000;

/** Tentativas de religar a câmera (o ícone) na chamada; depois disso segue sem ela. */
const CAMERA_RETRIES = 3;

export interface BotLaunch {
  identity: BotIdentity;
  urlKey: string;
  /** Date.now() de quando o pedido chegou, para medir cada etapa */
  requestedAt: number;
  /** reunião da agenda: espera a admissão ao menos até aqui (o fim previsto) */
  admitUntil?: Date | null;
  /** reunião da agenda: não sai por estar sozinho antes disto */
  stayUntil?: Date | null;
}

export function startBot(meetingId: string, url: string, platform: "meet" | "teams", launch: BotLaunch): void {
  const abort = new AbortController();
  const entry = {
    abort,
    done: Promise.resolve(),
    urlKey: launch.urlKey,
    displayName: launch.identity.name,
    requestedAt: launch.requestedAt,
    stage: "preparing" as const,
    stageAt: launch.requestedAt,
  };
  active.set(meetingId, entry);
  entry.done = runBot(meetingId, url, platform, launch, abort.signal)
    .catch((err) => console.error(`[bot ${meetingId}] erro inesperado:`, err))
    .finally(() => removeBot(meetingId));
}

export function stopBot(meetingId: string): boolean {
  const bot = active.get(meetingId);
  if (!bot) return false;
  bot.abort.abort();
  return true;
}

export async function stopAllBots(timeoutMs: number): Promise<void> {
  const all = [...active.values()];
  all.forEach((b) => b.abort.abort());
  await Promise.race([
    Promise.all(all.map((b) => b.done)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function screenshot(page: Page, meetingId: string): Promise<void> {
  await page.screenshot({ path: screenshotPath(meetingId) }).catch(() => {});
}

class BotError extends Error {}

// Som na chamada (PCM s16le): amostra esparsa, só para separar silêncio de fala.
const SOUND_RMS = 250;

function hasSound(pcm: Buffer): boolean {
  const samples = pcm.length >> 1;
  if (!samples) return false;
  const step = Math.max(1, Math.floor(samples / 400));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples; i += step) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
    count++;
  }
  return Math.sqrt(sum / count) >= SOUND_RMS;
}

async function runBot(
  meetingId: string,
  url: string,
  platform: "meet" | "teams",
  launch: BotLaunch,
  signal: AbortSignal,
) {
  const { identity } = launch;
  const driver = drivers[platform];
  const log = (msg: string) => console.log(`[bot ${meetingId}] ${msg}`);
  const sinkName = `mb_${meetingId.replace(/-/g, "").slice(0, 16)}`;
  const audioPath = path.join(audioDir, `${meetingId}.ogg`);

  await mkdir(audioDir, { recursive: true });
  await mkdir(debugDir, { recursive: true });

  let sinkModule: string | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let card: CameraCard | null = null;
  let blank: CameraCard | null = null;
  let recorder: ChildProcessWithoutNullStreams | null = null;
  let failure: string | null = null;
  let signedIn = false;
  let speakers: SpeakerCollector | null = null;

  try {
    // Sem ícone cadastrado, a câmera fica desligada (a reunião mostra as iniciais).
    if (config.botCamera && identity.avatarPath) {
      card = await createCameraCard(identity.avatarPath).catch((err) => {
        log(`ícone do agente não virou imagem da câmera; entra sem ela: ${(err as Error).message}`);
        return null;
      });
    }
    // Câmera desligada: mesmo assim a câmera falsa ganha um quadro preto, para o padrão verde do Chromium nunca aparecer se o Teams ligá-la.
    if (!card) {
      blank = await createBlankCard().catch((err) => {
        log(`quadro preto da câmera não gerado: ${(err as Error).message}`);
        return null;
      });
    }
    sinkModule = await createSink(sinkName);
    setBotStage(meetingId, "launching");
    ({ browser, page } = await launchBrowser(sinkName, (card ?? blank)?.file, identity.account?.state));
    if (signal.aborted) throw new BotError("Cancelado antes de entrar na reunião.");

    log(`entrando (${platform}) como "${identity.name}"${identity.account ? " (conta conectada)" : ""}${card ? " com o ícone na câmera" : ""}`);
    setBotStage(meetingId, "opening");
    let joined: JoinResult;
    try {
      joined = await driver.join(
        page,
        url,
        { name: identity.name, camera: card !== null },
        {
          timeoutMs: identity.account ? Math.max(config.botJoinTimeoutMs, ACCOUNT_JOIN_TIMEOUT_MS) : config.botJoinTimeoutMs,
          signal,
          onJoining: () => setBotStage(meetingId, "joining"),
        },
        log,
      );
    } catch (err) {
      console.error(`[bot ${meetingId}] falha ao entrar:`, (err as Error).message);
      if (err instanceof JoinError && err.kind !== "timeout") throw new BotError(err.message);
      if (await driver.isInvalidLink(page)) throw new BotError("Link de reunião inválido ou expirado.");
      if (await driver.isDenied(page)) {
        throw new BotError("A reunião não permite a entrada do bot (convidados bloqueados ou login exigido).");
      }
      throw new BotError(
        `${(err as Error).message} Veja a tela do bot na aba “Áudio e debug”.`
      );
    } finally {
      await screenshot(page, meetingId);
    }

    if (identity.account) {
      if (joined.guestForm) {
        log("a sessão da conta do Teams venceu; entrou como convidado. Conecte a conta de novo em Configurações → Meu agente");
        audit("teams_account_expired", {}, identity.account.userId);
        await markTeamsSessionExpired(identity.account.userId).catch(() => {});
      } else {
        signedIn = true;
        log("entrou com a conta do Teams");
      }
    }

    setBotStage(meetingId, "waiting_admission");
    await setMeetingStatus(meetingId, "waiting_admission");
    log("aguardando admissão");
    const admissionDeadline = Math.max(Date.now() + config.admissionTimeoutMs, launch.admitUntil?.getTime() ?? 0);
    const admissionMinutes = Math.round((admissionDeadline - Date.now()) / 60_000);
    let lastShot = 0;
    while (!(await driver.isInCall(page))) {
      if (signal.aborted) throw new BotError("Cancelado antes de o bot ser admitido na reunião.");
      if (await driver.isDenied(page)) {
        await screenshot(page, meetingId);
        throw new BotError("Entrada recusada pela reunião (ou convidados não são permitidos).");
      }
      if (Date.now() > admissionDeadline) {
        await screenshot(page, meetingId);
        throw new BotError(
          `Não fui admitido em ${admissionMinutes} min. Veja o screenshot de debug.`
        );
      }
      if (Date.now() - lastShot > 15_000) {
        await screenshot(page, meetingId);
        lastShot = Date.now();
      }
      await sleep(1000, signal);
    }

    log(`na call, gravando (câmera ${joined.camera ? "com o ícone" : "desligada"})`);
    setBotStage(meetingId, "in_call");
    const live = config.botLiveTranscription ? liveSession(meetingId, "mixed") : null;
    // O mesmo PCM serve para a transcrição ao vivo e para saber se ainda há som na chamada.
    let lastSoundAt = Date.now();
    // Relógio da linha do tempo dos falantes = relógio do áudio gravado (spec 006).
    const anchor = new ClockAnchor();
    recorder = startRecording(sinkName, audioPath, (pcm) => {
      anchor.observe(pcm.length, performance.now());
      if (hasSound(pcm)) lastSoundAt = Date.now();
      live?.push(pcm);
    });
    await setAudioPath(meetingId, audioPath);
    await markStarted(meetingId);
    await driver.ensureMuted(page);
    await screenshot(page, meetingId);
    // Leitura dos nomes na tela: roda em timers próprios e qualquer falha dela é só log (nunca derruba a gravação).
    speakers = startSpeakerReader({
      page,
      driver,
      meetingId,
      platform,
      profile: signedIn ? "account" : "guest",
      assistantName: identity.name,
      anchor,
      lastSoundAt: () => lastSoundAt,
      log,
    });

    const startedAt = Date.now();
    const decider = new LeaveDecider({
      aloneTimeoutMs: config.aloneTimeoutMs,
      silenceAfterEndMs: config.silenceStopMs,
      silenceNoScheduleMs: config.botSilenceStopMs,
      maxMeetingMs: config.maxMeetingMs,
      stayUntil: launch.stayUntil?.getTime() ?? null,
    });
    let missingChecks = 0;
    const cameraWatch = createCameraWatch({ icon: card !== null, iconOn: joined.camera, retries: CAMERA_RETRIES, log });
    while (true) {
      await sleep(5000, signal);
      if (signal.aborted) {
        log("encerrado manualmente");
        break;
      }
      if (recorder.exitCode !== null) {
        failure = `A gravação parou inesperadamente (ffmpeg saiu com código ${recorder.exitCode}).`;
        break;
      }
      if (page.isClosed()) {
        log("página fechada");
        break;
      }
      missingChecks = (await driver.isInCall(page)) ? 0 : missingChecks + 1;
      if (missingChecks >= 2) {
        log("call terminou (controles sumiram)");
        break;
      }

      const [ended, participants, aloneText] = await Promise.all([
        driver.hasEnded(page).catch(() => false),
        driver.participantCount(page).catch(() => null),
        driver.isAlone(page).catch(() => false),
      ]);
      const leave = decider.check({ now: Date.now(), startedAt, ended, participants, aloneText, lastSoundAt });
      if (leave) {
        log(`saindo: ${leave}`);
        break;
      }

      await cameraWatch.check(driver, page);
    }
  } catch (err) {
    failure = err instanceof BotError ? err.message : `Erro no bot: ${(err as Error).message}`;
    console.error(`[bot ${meetingId}]`, err);
  } finally {
    await stopSpeakers(speakers, log);
    if (recorder) await stopRecording(recorder);
    closeLiveSessions(meetingId);
    dropTimeline(meetingId);
    dropRuntime(meetingId);
    if (signedIn && identity.account && page && !page.isClosed()) await keepSessionFresh(page, identity.account, log);
    if (page && !page.isClosed()) {
      await leaveCall(page);
    }
    await browser?.close().catch(() => {});
    await card?.dispose().catch(() => {});
    await blank?.dispose().catch(() => {});
    if (sinkModule) await removeSink(sinkModule);
    await markEnded(meetingId);
  }

  const hasAudio = recorder !== null && (await stat(audioPath).then((s) => s.size > 0).catch(() => false));
  if (hasAudio) {
    if (failure) log(`${failure} — processando o áudio gravado até aqui`);
    enqueueProcessing(meetingId);
  } else {
    await setMeetingStatus(meetingId, "error", failure ?? "Nenhum áudio foi gravado.");
  }
}

const SPEAKERS_STOP_TIMEOUT_MS = 8000;

// Fecha a leitura dos nomes (intervalos abertos, último lote e resumo) sem nunca atrasar nem derrubar a saída.
async function stopSpeakers(collector: SpeakerCollector | null, log: (msg: string) => void): Promise<void> {
  if (!collector) return;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log("leitura dos nomes: encerramento demorou; seguindo sem esperar");
      resolve();
    }, SPEAKERS_STOP_TIMEOUT_MS);
  });
  try {
    await Promise.race([collector.stop().then(() => undefined), limit]);
  } catch (err) {
    log(`leitura dos nomes: erro ao encerrar (${(err as Error).name})`);
  } finally {
    clearTimeout(timer);
  }
}

// O Teams renova os tokens durante a chamada; guardar a sessão nova evita que ela vença sozinha.
async function keepSessionFresh(page: Page, account: BotAccount, log: (msg: string) => void): Promise<void> {
  try {
    const raw = Buffer.from(JSON.stringify(await page.context().storageState()), "utf8");
    if (raw.length > MAX_SESSION_BYTES) return log("sessão da conta ficou grande demais para renovar; mantida a anterior");
    await refreshTeamsSession(account.userId, parseSession(raw));
  } catch (err) {
    log(`não consegui renovar a sessão da conta: ${(err as Error).message}`);
  }
}

async function leaveCall(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /leave call|sair da chamada|^leave\b|^sair\b/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
}
