import type { AdrSugerido, LlmChoice, Narrativa } from "@meeting-bot/contracts";
import { getMeeting, pool } from "../db";
import { createAiItems, listAdrs, listItems, mergeInto, upsertSuggestedAdr } from "../items/service";
import { generate, generationLabel } from "../llm";
import { hub } from "../live/hub";
import { setAdrGeneration, setEvidenceRemapper, setPostAnalysis } from "../pipeline";
import { getSegments, getSpeakers, speakerNameResolver, type EvidenceRemapper } from "../repo/transcripts";
import { runAdrGeneration, runPostAnalysis, type PostAnalysisDeps } from "./postAnalysis";
import { remapEvidence } from "./remap";

// Liga o agente ao pipeline pós-reunião (US4) e às gerações sob demanda.

// Modelos externos têm contexto grande: trechos maiores, menos chamadas e mais coerência.
const EXTERNAL_CHUNK_TOKENS = 12_000;

function depsFor(provider: LlmChoice): PostAnalysisDeps {
  const label = generationLabel(provider);
  return {
    async loadContext(meetingId) {
      const meeting = await getMeeting(meetingId);
      if (!meeting) return null;
      const [segments, speakers] = await Promise.all([getSegments(meetingId), getSpeakers(meetingId)]);
      const nameOf = speakerNameResolver(speakers);
      const labels = [...new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)))];
      const attendees = (Array.isArray(meeting.attendees) ? meeting.attendees : [])
        .map((a) => a.name || a.email || "")
        .filter(Boolean);
      const analysis = meeting.analysis as { resumo_executivo?: unknown } | null;
      return {
        title: meeting.title,
        project: meeting.project_name,
        participants: [...new Set([...labels.map((l) => nameOf(l) ?? l), ...attendees])],
        liveSummary: meeting.live_summary,
        analysisSummary: typeof analysis?.resumo_executivo === "string" ? analysis.resumo_executivo : null,
        segments: segments.map((s) => ({ ...s, speakerName: nameOf(s.speaker) })),
      };
    },
    generate: (req) => generate("post", req, provider),
    chunkTokens: provider === "openrouter" ? EXTERNAL_CHUNK_TOKENS : undefined,
    listItems,
    listAdrs,
    createAiItems: (meetingId, items, origin) => createAiItems(meetingId, items, origin, label),
    mergeInto,
    async resetChunkNotes(meetingId) {
      await pool.query(`DELETE FROM meeting_notes WHERE meeting_id = $1 AND kind = 'chunk'`, [meetingId]);
    },
    async saveChunkNote(meetingId, start, end, text) {
      await pool.query(
        `INSERT INTO meeting_notes (meeting_id, kind, pass, start_seconds, end_seconds, text)
         VALUES ($1, 'chunk', 'final', $2, $3, $4)`,
        [meetingId, start, end, text],
      );
    },
    async saveSummary(meetingId, summary) {
      const at = new Date();
      await pool.query(`UPDATE meetings SET live_summary = $2, live_summary_at = $3 WHERE id = $1`, [meetingId, summary, at]);
      hub.publishToMeeting(meetingId, { type: "summary", meetingId, text: summary, at: at.toISOString() });
    },
    async saveAnalysis(meetingId, analysis: Narrativa) {
      await pool.query(
        `UPDATE meetings SET analysis = $2, analyzed_at = now(), analysis_provider = $3 WHERE id = $1`,
        [meetingId, analysis, label],
      );
    },
    async upsertAdr(meetingId, itemId, adr: AdrSugerido) {
      const saved = await upsertSuggestedAdr(
        meetingId,
        itemId,
        {
          title: adr.titulo,
          context: adr.contexto,
          problem: adr.problema,
          alternatives: adr.alternativas,
          decision: adr.decisao,
          consequences: adr.consequencias,
          risks: adr.riscos,
        },
        label,
      );
      return saved !== null;
    },
  };
}

export const evidenceRemapper: EvidenceRemapper = async (client, meetingId, finals) => {
  const { rows } = await client.query(
    `SELECT e.id, e.item_id, e.segment_id, e.start_seconds, e.end_seconds, e.channel
     FROM item_evidence e JOIN meeting_items i ON i.id = e.item_id
     WHERE i.meeting_id = $1`,
    [meetingId],
  );
  const changed = new Map<string, number>();
  for (const r of rows) {
    const target = remapEvidence(
      { channel: r.channel, start: Number(r.start_seconds), end: Number(r.end_seconds) },
      finals,
    );
    const current = r.segment_id === null ? null : Number(r.segment_id);
    if (target === current) continue;
    await client.query(`UPDATE item_evidence SET segment_id = $2 WHERE id = $1`, [r.id, target]);
    changed.set(r.item_id, (changed.get(r.item_id) ?? 0) + 1);
  }
  for (const [itemId, count] of changed) {
    await client.query(
      `INSERT INTO item_history (item_id, action, before, after) VALUES ($1, 'evidence_remapped', NULL, $2)`,
      [itemId, { evidence: count }],
    );
  }
};

setPostAnalysis((meetingId, report, provider) => runPostAnalysis(meetingId, report, depsFor(provider)));
setAdrGeneration((meetingId, report, provider, itemId) =>
  runAdrGeneration(meetingId, report, depsFor(provider), { itemId }),
);
setEvidenceRemapper(evidenceRemapper);
