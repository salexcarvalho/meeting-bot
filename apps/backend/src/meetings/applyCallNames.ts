import { USER_SPEAKER_LABEL, type ApplyCallNamesResult } from "@meeting-bot/contracts";
import { config } from "../config";
import { pool } from "../db";
import { getSegments, type NewSegment } from "../repo/transcripts";
import {
  listActivity,
  readTimelineMeta,
  writeTimelineMeta,
  type SpeakerTimelineMeta,
} from "../repo/speakerActivity";
import { audit } from "../security/audit";
import { matchSpeakers, nameSegments, type MatchInterval, type MatchSegment } from "./speakerNames";

// Aplica os nomes lidos na chamada aos falantes da reunião (spec 006). Nunca lança para o pipeline:
// quem chama decide o que fazer com a falha. Nomes nunca vão para log nem auditoria, só contadores.

const LOW_CORRELATION = "low_correlation";

export interface ApplyOutcome extends ApplyCallNamesResult {
  status: SpeakerTimelineMeta["status"] | "none";
}

/** A leitura pode ser usada para nomear? Reprovada pela saúde (parcial/indisponível) ou desligada, não. */
export function usableForNaming(meta: SpeakerTimelineMeta | null): boolean {
  if (!meta) return true;
  if (meta.status === "ok") return true;
  return meta.status === "partial" && meta.reason === LOW_CORRELATION;
}

function toMatchSegments(rows: { speaker: string | null; start: number; end: number }[]): MatchSegment[] {
  return rows.map((r) => ({ label: r.speaker, start: r.start, end: r.end }));
}

async function loadInterval(meetingId: string): Promise<MatchInterval[]> {
  return (await listActivity(meetingId)).map((r) => ({ key: r.key, name: r.name, start: r.start, end: r.end }));
}

/** Estado da leitura depois do casamento: reprovado pela correlação com o áudio = parcial; aprovado limpa essa marca. */
function nextMeta(meta: SpeakerTimelineMeta | null, valid: boolean, skewMs: number, undecided: Record<string, string>): SpeakerTimelineMeta {
  const next: SpeakerTimelineMeta = { ...(meta ?? { people: 0, intervals: 0 }), status: valid ? "ok" : "partial", skewMs, undecided };
  if (valid) delete next.reason;
  else next.reason = LOW_CORRELATION;
  return next;
}

/**
 * Casa cada "Speaker N" do passe final com o nome da chamada e grava em `meeting_speakers` com origem
 * "call" e confiança. Nome manual nunca é sobrescrito; rótulo sem decisão e antes automático volta ao padrão.
 */
export async function applyCallNames(meetingId: string): Promise<ApplyOutcome> {
  const meta = await readTimelineMeta(meetingId);
  if (!usableForNaming(meta)) return { applied: 0, skipped: 0, status: meta?.status ?? "none" };
  const intervals = await loadInterval(meetingId);
  if (!intervals.length) return { applied: 0, skipped: 0, status: meta?.status ?? "none" };

  const segments = toMatchSegments(await getSegments(meetingId));
  const result = matchSpeakers(segments, intervals, { defaultSkewMs: config.botSpeakerSkewMs });
  await writeTimelineMeta(meetingId, nextMeta(meta, result.valid, result.skewMs, result.undecided));

  let applied = 0;
  let skipped = 0;
  if (result.valid) {
    for (const [label, decision] of result.names) {
      const { rowCount } = await pool.query(
        `UPDATE meeting_speakers SET display_name = $3, name_source = 'call', name_confidence = $4
          WHERE meeting_id = $1 AND label = $2 AND label <> $5 AND name_source IS DISTINCT FROM 'manual'`,
        [meetingId, label, decision.name, decision.confidence, USER_SPEAKER_LABEL],
      );
      if (rowCount) applied++;
      else skipped++;
    }
    // O que a chamada nomeou antes e agora não tem evidência volta ao rótulo (nunca o manual).
    await pool.query(
      `UPDATE meeting_speakers SET display_name = label, name_source = NULL, name_confidence = NULL
        WHERE meeting_id = $1 AND name_source = 'call' AND NOT (label = ANY($2))`,
      [meetingId, [...result.names.keys()]],
    );
  }
  const status = result.valid ? "ok" : "partial";
  audit("speaker_names_applied", { applied, skipped, status });
  return { applied, skipped, status };
}

/**
 * Modo por segmento (passe final sem diarização): segmentos do canal `mixed` sem rótulo recebem o nome de
 * quem mais falou neles. Devolve os segmentos (rotulados ou como vieram) e os nomes criados.
 */
export async function labelUndiarized(
  meetingId: string,
  segments: NewSegment[],
): Promise<{ segments: NewSegment[]; names: string[] }> {
  const candidates = segments.flatMap((s, i) => (s.speaker === null && s.channel === "mixed" ? [i] : []));
  if (!candidates.length) return { segments, names: [] };
  const meta = await readTimelineMeta(meetingId);
  if (!usableForNaming(meta)) return { segments, names: [] };
  const intervals = await loadInterval(meetingId);
  if (!intervals.length) return { segments, names: [] };

  const match = nameSegments(
    segments.map((s) => ({ label: s.speaker, start: s.start, end: s.end })),
    candidates,
    intervals,
    { defaultSkewMs: config.botSpeakerSkewMs },
  );
  if (!match.valid) {
    await writeTimelineMeta(meetingId, nextMeta(meta, false, match.skewMs, {}));
    return { segments, names: [] };
  }
  const labelled = segments.map((s, i) => (match.names.has(i) ? { ...s, speaker: match.names.get(i) ?? null } : s));
  return { segments: labelled, names: [...new Set(match.names.values())] };
}

/** Marca como "da chamada" os falantes criados pelo modo por segmento (o rótulo é o próprio nome). */
export async function markSegmentModeSpeakers(meetingId: string, names: string[]): Promise<number> {
  if (!names.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE meeting_speakers SET name_source = 'call'
      WHERE meeting_id = $1 AND label = ANY($2) AND name_source IS NULL`,
    [meetingId, names],
  );
  audit("speaker_names_applied", { applied: rowCount ?? 0, skipped: 0, status: "ok", mode: "segment" });
  return rowCount ?? 0;
}
