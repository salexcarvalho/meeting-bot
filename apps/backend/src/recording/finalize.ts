import { rename, rm, stat } from "fs/promises";
import { probeDuration, run } from "../asr/ffmpeg";
import { listAudio, pool, setMeetingStatus, upsertAudio } from "../db";
import { hub } from "../live/hub";
import { enqueueProcessing } from "../pipeline";
import { closeIngest, PCM_FORMAT } from "./audioIngest";
import { BYTES_PER_SECOND } from "./chunker";
import { closeLiveSessions } from "./liveSession";
import { dropRuntime } from "./runtime";

const DURATION_TOLERANCE_S = 1;

// PCM do canal → Opus 32 kbps (voz). O PCM só é apagado depois de conferir a duração.
export async function convertChannel(pcm: string): Promise<{ path: string; bytes: number; duration: number }> {
  const out = pcm.replace(/\.pcm$/, ".ogg");
  const partial = `${out}.part`;
  const expected = (await stat(pcm)).size / BYTES_PER_SECOND;
  await run(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", pcm,
      "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
      "-f", "ogg", partial,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const duration = await probeDuration(partial);
  if (Math.abs(duration - expected) > DURATION_TOLERANCE_S) {
    await rm(partial, { force: true });
    throw new Error(`conversão inconsistente (${duration.toFixed(1)}s ≠ ${expected.toFixed(1)}s)`);
  }
  await rename(partial, out);
  await rm(pcm, { force: true });
  return { path: out, bytes: (await stat(out)).size, duration };
}

const finalizing = new Set<string>();

export function isFinalizing(meetingId: string): boolean {
  return finalizing.has(meetingId);
}

export async function finalizeRecording(meetingId: string): Promise<void> {
  if (finalizing.has(meetingId)) return;
  finalizing.add(meetingId);
  try {
    await closeIngest(meetingId);
    closeLiveSessions(meetingId);
    hub.publishToMeeting(meetingId, { type: "processing", meetingId, step: "convertendo" });

    let kept = 0;
    for (const audio of await listAudio(meetingId)) {
      if (audio.format !== PCM_FORMAT) {
        kept++;
        continue;
      }
      const size = await stat(audio.path).then((s) => s.size, () => 0);
      if (size < BYTES_PER_SECOND) {
        // Menos de 1 s: nada útil.
        await rm(audio.path, { force: true });
        await pool.query(`DELETE FROM meeting_audio WHERE meeting_id = $1 AND channel = $2`, [meetingId, audio.channel]);
        continue;
      }
      const converted = await convertChannel(audio.path);
      await upsertAudio(meetingId, audio.channel, {
        path: converted.path,
        format: "ogg_opus",
        bytes: converted.bytes,
        durationSeconds: Math.round(converted.duration * 100) / 100,
      });
      kept++;
    }

    await pool.query(`UPDATE meetings SET ended_at = COALESCE(ended_at, now()) WHERE id = $1`, [meetingId]);
    dropRuntime(meetingId);
    if (!kept) {
      await setMeetingStatus(meetingId, "error", "Nenhum áudio recebido do agente do desktop.");
      hub.publishToMeeting(meetingId, { type: "processing", meetingId, step: null });
      return;
    }
    enqueueProcessing(meetingId);
  } catch (err) {
    console.error(`[finalize ${meetingId}] falhou:`, err);
    await setMeetingStatus(meetingId, "error", `Falha ao salvar o áudio: ${(err as Error).message}`).catch(() => {});
    hub.publishToMeeting(meetingId, { type: "processing", meetingId, step: null });
  } finally {
    finalizing.delete(meetingId);
  }
}
