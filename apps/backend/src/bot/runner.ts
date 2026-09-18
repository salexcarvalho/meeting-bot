import { mkdir, stat } from "fs/promises";
import path from "path";
import { Browser, Page } from "playwright";
import { ChildProcessWithoutNullStreams } from "child_process";

import { config } from "../config";
import { markEnded, markStarted, setAudioPath, setMeetingStatus } from "../db";
import { enqueueProcessing } from "../pipeline";
import { closeLiveSessions, liveSession } from "../recording/liveSession";
import { dropRuntime } from "../recording/runtime";
import { createSink, removeSink, startRecording, stopRecording } from "./audio";
import { launchBrowser } from "./browser";
import { createCameraCard, type CameraCard } from "./card";
import type { BotIdentity } from "./identity";
import { LeaveDecider } from "./leave";
import { drivers } from "./platforms";
import { JoinError, type JoinResult } from "./join";
import { activeBots as active, removeBot, setBotStage } from "./state";

export { activeBotCount, isBotActive } from "./state";

export const audioDir = path.join(config.dataDir, "audio");
export const debugDir = path.join(config.dataDir, "debug");

export function screenshotPath(meetingId: string): string {
  return path.join(debugDir, `${meetingId}.png`);
}

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
  let recorder: ChildProcessWithoutNullStreams | null = null;
  let failure: string | null = null;

  try {
    // Sem ícone cadastrado, a câmera fica desligada (a reunião mostra as iniciais).
    if (config.botCamera && identity.avatarPath) {
      card = await createCameraCard(identity.avatarPath).catch((err) => {
        log(`ícone do agente não virou imagem da câmera; entra sem ela: ${(err as Error).message}`);
        return null;
      });
    }
    sinkModule = await createSink(sinkName);
    setBotStage(meetingId, "launching");
    ({ browser, page } = await launchBrowser(sinkName, card?.file));
    if (signal.aborted) throw new BotError("Cancelado antes de entrar na reunião.");

    log(`entrando (${platform}) como "${identity.name}"${card ? " com o ícone na câmera" : ""}`);
    setBotStage(meetingId, "opening");
    let joined: JoinResult;
    try {
      joined = await driver.join(
        page,
        url,
        { name: identity.name, camera: card !== null },
        {
          timeoutMs: config.botJoinTimeoutMs,
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
    recorder = startRecording(sinkName, audioPath, (pcm) => {
      if (hasSound(pcm)) lastSoundAt = Date.now();
      live?.push(pcm);
    });
    await setAudioPath(meetingId, audioPath);
    await markStarted(meetingId);
    await driver.ensureMuted(page);
    await screenshot(page, meetingId);

    const startedAt = Date.now();
    const decider = new LeaveDecider({
      aloneTimeoutMs: config.aloneTimeoutMs,
      silenceAfterEndMs: config.silenceStopMs,
      silenceNoScheduleMs: config.botSilenceStopMs,
      maxMeetingMs: config.maxMeetingMs,
      stayUntil: launch.stayUntil?.getTime() ?? null,
    });
    let missingChecks = 0;
    let cameraRetries = 0;
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

      // O ícone some se a câmera cair: religa algumas vezes (o aviso de gravação continua no nome).
      if (joined.camera && cameraRetries < CAMERA_RETRIES && (await driver.cameraState(page).catch(() => null)) === "off") {
        cameraRetries++;
        log("câmera desligada na chamada; religando o ícone");
        await driver.setCamera(page, true).catch(() => {});
      }

    }
  } catch (err) {
    failure = err instanceof BotError ? err.message : `Erro no bot: ${(err as Error).message}`;
    console.error(`[bot ${meetingId}]`, err);
  } finally {
    if (recorder) await stopRecording(recorder);
    closeLiveSessions(meetingId);
    dropRuntime(meetingId);
    if (page && !page.isClosed()) {
      await leaveCall(page);
    }
    await browser?.close().catch(() => {});
    await card?.dispose().catch(() => {});
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

async function leaveCall(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /leave call|sair da chamada|^leave\b|^sair\b/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
}
