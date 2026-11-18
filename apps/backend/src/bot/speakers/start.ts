import type { Page } from "playwright";
import { config } from "../../config";
import { ClockAnchor } from "../../recording/clockAnchor";
import { timelineFor } from "../../recording/speakerTimeline";
import { insertActivity, writeTimelineMeta } from "../../repo/speakerActivity";
import { audit } from "../../security/audit";
import type { PlatformDriver } from "../platforms";
import { createSpeakerCollector, type SpeakerCollector } from "./collector";
import { createDiagnostic } from "./diagnostic";
import { PageProbeHost } from "./probe";
import type { SpeakerProfile } from "./index";

export interface SpeakerReaderOptions {
  page: Page;
  driver: PlatformDriver;
  meetingId: string;
  platform: "meet" | "teams";
  profile: SpeakerProfile;
  /** nome do assistente na chamada (nunca vira falante) */
  assistantName: string;
  anchor: ClockAnchor;
  /** Date.now() do último bloco de áudio com som */
  lastSoundAt: () => number;
  log: (message: string) => void;
}

/**
 * Liga a leitura dos nomes na tela (spec 006). Devolve null quando está desligada ou a plataforma não tem
 * leitor: o bot segue como sempre. Nunca lança.
 */
export function startSpeakerReader(opts: SpeakerReaderOptions): SpeakerCollector | null {
  try {
    const probe = config.botSpeakerNames ? opts.driver.speakerProbe?.(opts.profile) : null;
    if (!probe) return null;
    let checkedAt = Date.now();
    const collector = createSpeakerCollector({
      host: new PageProbeHost(opts.page, probe),
      anchor: opts.anchor,
      timeline: timelineFor(opts.meetingId),
      assistantName: opts.assistantName,
      now: () => performance.now(),
      soundSinceLast: () => {
        const heard = opts.lastSoundAt() > checkedAt;
        checkedAt = Date.now();
        return heard;
      },
      participants: () => opts.driver.participantCount(opts.page),
      persist: (intervals) => insertActivity(opts.meetingId, opts.platform, intervals),
      finish: async (meta) => {
        await writeTimelineMeta(opts.meetingId, meta);
        audit("speaker_timeline_recorded", {
          status: meta.status,
          ...(meta.reason ? { reason: meta.reason } : {}),
          people: meta.people,
          intervals: meta.intervals,
        });
      },
      log: (message) => opts.log(message),
      diagnose: config.botSpeakerDiagnostic ? createDiagnostic(opts.page, opts.meetingId, opts.log) : undefined,
      sourceLabel: opts.platform === "teams" ? `teams:${opts.profile}` : "meet",
    });
    collector.start();
    return collector;
  } catch (err) {
    opts.log(`leitura dos nomes na chamada não iniciou: ${(err as Error).message}`);
    return null;
  }
}
