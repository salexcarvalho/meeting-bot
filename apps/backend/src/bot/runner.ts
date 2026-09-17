import { mkdir, stat } from "fs/promises";
import path from "path";
import { Browser, Page } from "playwright";
import { ChildProcessWithoutNullStreams } from "child_process";

import { config } from "../config";
import { markEnded, markStarted, setAudioPath, setMeetingStatus } from "../db";
import { enqueueProcessing } from "../pipeline";
import { createSink, removeSink, startRecording, stopRecording } from "./audio";
import { launchBrowser } from "./browser";
import { drivers } from "./platforms";
import { JoinError } from "./join";
import { activeBots as active, removeBot, setBotStage } from "./state";

export { activeBotCount, isBotActive } from "./state";

export const audioDir = path.join(config.dataDir, "audio");
export const debugDir = path.join(config.dataDir, "debug");

export function screenshotPath(meetingId: string): string {
  return path.join(debugDir, `${meetingId}.png`);
}

export interface BotLaunch {
  displayName: string;
  urlKey: string;
  /** Date.now() de quando o pedido chegou, para medir cada etapa */
  requestedAt: number;
}

export function startBot(meetingId: string, url: string, platform: "meet" | "teams", launch: BotLaunch): void {
  const abort = new AbortController();
  const entry = {
    abort,
    done: Promise.resolve(),
    urlKey: launch.urlKey,
    displayName: launch.displayName,
    requestedAt: launch.requestedAt,
    stage: "preparing" as const,
    stageAt: launch.requestedAt,
  };
  active.set(meetingId, entry);
  entry.done = runBot(meetingId, url, platform, launch.displayName, abort.signal)
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

async function runBot(
  meetingId: string,
  url: string,
  platform: "meet" | "teams",
  displayName: string,
  signal: AbortSignal,
) {
  const driver = drivers[platform];
  const log = (msg: string) => console.log(`[bot ${meetingId}] ${msg}`);
  const sinkName = `mb_${meetingId.replace(/-/g, "").slice(0, 16)}`;
  const audioPath = path.join(audioDir, `${meetingId}.ogg`);

  await mkdir(audioDir, { recursive: true });
  await mkdir(debugDir, { recursive: true });

  let sinkModule: string | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let recorder: ChildProcessWithoutNullStreams | null = null;
  let failure: string | null = null;

  try {
    sinkModule = await createSink(sinkName);
    setBotStage(meetingId, "launching");
    ({ browser, page } = await launchBrowser(sinkName));
    if (signal.aborted) throw new BotError("Cancelado antes de entrar na reunião.");

    log(`entrando (${platform}) como "${displayName}"`);
    setBotStage(meetingId, "opening");
    try {
      await driver.join(
        page,
        url,
        displayName,
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
    const admissionDeadline = Date.now() + config.admissionTimeoutMs;
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
          `Não fui admitido em ${config.admissionTimeoutMs / 60_000} min. Veja o screenshot de debug.`
        );
      }
      if (Date.now() - lastShot > 15_000) {
        await screenshot(page, meetingId);
        lastShot = Date.now();
      }
      await sleep(1000, signal);
    }

    log("na call, gravando");
    setBotStage(meetingId, "in_call");
    recorder = startRecording(sinkName, audioPath);
    await setAudioPath(meetingId, audioPath);
    await markStarted(meetingId);
    await driver.ensureMuted(page);
    await screenshot(page, meetingId);

    const startedAt = Date.now();
    let missingChecks = 0;
    let aloneSince: number | null = null;
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
      if (Date.now() - startedAt > config.maxMeetingMs) {
        log("duração máxima atingida");
        break;
      }

      missingChecks = (await driver.isInCall(page)) ? 0 : missingChecks + 1;
      if (missingChecks >= 2) {
        log("call terminou (controles sumiram)");
        break;
      }

      if (await driver.isAlone(page)) {
        aloneSince ??= Date.now();
        if (Date.now() - aloneSince > config.aloneTimeoutMs) {
          log("sozinho na call, saindo");
          break;
        }
      } else {
        aloneSince = null;
      }
    }
  } catch (err) {
    failure = err instanceof BotError ? err.message : `Erro no bot: ${(err as Error).message}`;
    console.error(`[bot ${meetingId}]`, err);
  } finally {
    if (recorder) await stopRecording(recorder);
    if (page && !page.isClosed()) {
      await leaveCall(page);
    }
    await browser?.close().catch(() => {});
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
