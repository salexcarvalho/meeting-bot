import { Consolidacao, Extracao } from "@meeting-bot/contracts";
import { config } from "../config";
import { pool } from "../db";
import { generate, generationLabel } from "../llm";
import { hub } from "../live/hub";
import { getSpeakers, speakerNameResolver, type SegmentRow } from "../repo/transcripts";
import { createAiItems, listItems, mergeInto } from "../items/service";
import { validateExtraction } from "./evidence";
import {
  consolidationUser,
  estimateTokens,
  extractionUser,
  formatWindow,
  SYSTEM_CONSOLIDACAO,
  SYSTEM_EXTRACAO,
  type WindowSegment,
} from "./prompts";
import { shouldConsolidate, shouldExtract } from "./triggers";

// Agente arquiteto durante a gravação (US3): extrai itens por janelas e mantém o resumo corrente.

const WINDOW_TOKENS = 2_500;
const CONTEXT_SEGMENTS = 2;
const MAX_CONSOLIDATION_ITEMS = 60;
const RETRY_AFTER_ERROR_MS = 60_000;

async function liveSegmentsAfter(meetingId: string, afterId: number): Promise<SegmentRow[]> {
  const { rows } = await pool.query(
    `SELECT id, channel, pass, speaker, text, start_seconds, end_seconds FROM transcript_segments
     WHERE meeting_id = $1 AND pass = 'live' AND id > $2 ORDER BY id`,
    [meetingId, afterId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    channel: r.channel,
    pass: r.pass,
    speaker: r.speaker,
    text: r.text,
    start: Number(r.start_seconds),
    end: Number(r.end_seconds),
  }));
}

async function contextBefore(meetingId: string, cursor: number): Promise<SegmentRow[]> {
  if (!cursor) return [];
  const { rows } = await pool.query(
    `SELECT id, channel, pass, speaker, text, start_seconds, end_seconds FROM transcript_segments
     WHERE meeting_id = $1 AND pass = 'live' AND id <= $2 ORDER BY id DESC LIMIT $3`,
    [meetingId, cursor, CONTEXT_SEGMENTS],
  );
  return rows.reverse().map((r) => ({
    id: Number(r.id),
    channel: r.channel,
    pass: r.pass,
    speaker: r.speaker,
    text: r.text,
    start: Number(r.start_seconds),
    end: Number(r.end_seconds),
  }));
}

export class LiveAgent {
  private cursor = 0;
  private lastExtractAt = Date.now();
  private lastConsolidateAt = Date.now();
  private extractionsSince = 0;
  private busy: Promise<void> | null = null;
  private retryAt = 0;

  private constructor(readonly meetingId: string) {}

  // Reconstrói o estado a partir de meeting_notes (reinício do backend).
  static async restore(meetingId: string): Promise<LiveAgent> {
    const agent = new LiveAgent(meetingId);
    const { rows } = await pool.query(
      `SELECT kind, text, created_at FROM meeting_notes
       WHERE meeting_id = $1 AND pass = 'live' AND kind IN ('window', 'consolidation')
       ORDER BY created_at DESC`,
      [meetingId],
    );
    const lastWindow = rows.find((r) => r.kind === "window");
    const lastConsolidation = rows.find((r) => r.kind === "consolidation");
    if (lastWindow) {
      agent.lastExtractAt = lastWindow.created_at.getTime();
      const m = /^#(\d+)\s/.exec(lastWindow.text);
      if (m) agent.cursor = Number(m[1]);
    }
    if (lastConsolidation) agent.lastConsolidateAt = lastConsolidation.created_at.getTime();
    agent.extractionsSince = rows.findIndex((r) => r.kind === "consolidation");
    if (agent.extractionsSince < 0) agent.extractionsSince = rows.length;
    return agent;
  }

  get running(): boolean {
    return this.busy !== null;
  }

  tick(): Promise<void> {
    if (this.busy || Date.now() < this.retryAt) return this.busy ?? Promise.resolve();
    this.busy = this.step(false).finally(() => (this.busy = null));
    return this.busy;
  }

  // Fim da gravação: analisa o que faltou e consolida.
  async flush(): Promise<void> {
    if (this.busy) await this.busy;
    this.busy = this.step(true).finally(() => (this.busy = null));
    await this.busy;
  }

  private async step(final: boolean): Promise<void> {
    try {
      for (;;) {
        const pending = await liveSegmentsAfter(this.meetingId, this.cursor);
        const speech = pending.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);
        const due = shouldExtract(
          {
            newSegments: pending.length,
            newSpeechSeconds: speech,
            secondsSinceLastExtract: (Date.now() - this.lastExtractAt) / 1000,
          },
          { minSpeechSeconds: config.liveExtractMinSpeechSeconds, maxIntervalSeconds: config.liveExtractMaxIntervalSeconds },
        );
        if (!pending.length || (!due && !final)) break;
        const consumed = await this.extract(pending);
        if (consumed >= pending.length || !final) break;
      }
      const consolidate =
        (final && this.extractionsSince > 0) ||
        shouldConsolidate(
          {
            secondsSinceLastConsolidate: (Date.now() - this.lastConsolidateAt) / 1000,
            extractionsSince: this.extractionsSince,
          },
          { intervalSeconds: config.liveConsolidateIntervalSeconds },
        );
      if (consolidate) await this.consolidate();
    } catch (err) {
      this.retryAt = Date.now() + RETRY_AFTER_ERROR_MS;
      console.error(`[agente ${this.meetingId}] falha:`, (err as Error).message);
    }
  }

  // Devolve quantos segmentos entraram na janela.
  private async extract(pending: SegmentRow[]): Promise<number> {
    const window: SegmentRow[] = [];
    let tokens = 0;
    for (const s of pending) {
      const t = estimateTokens(s.text) + 6;
      if (window.length && tokens + t > WINDOW_TOKENS) break;
      window.push(s);
      tokens += t;
    }
    const meeting = await pool.query(
      `SELECT m.title, m.live_summary, p.name AS project FROM meetings m
       LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = $1`,
      [this.meetingId],
    );
    const info = meeting.rows[0];
    if (!info) return pending.length;
    const nameOf = speakerNameResolver(await getSpeakers(this.meetingId));
    const toWindow = (s: SegmentRow): WindowSegment => ({ ...s, speakerName: nameOf(s.speaker) });
    const ordered = [...window].sort((a, b) => a.start - b.start || a.id - b.id);
    const { text, map } = formatWindow(ordered.map(toWindow), (await contextBefore(this.meetingId, this.cursor)).map(toWindow));
    const lastId = window[window.length - 1].id;

    let summary = "";
    try {
      const result = await generate("live", {
        system: SYSTEM_EXTRACAO,
        user: extractionUser({ title: info.title, project: info.project, summary: info.live_summary, window: text }),
        schema: Extracao,
        numCtx: 4096,
        label: `extração ao vivo ${this.meetingId.slice(0, 8)}`,
      });
      summary = result.resumo_trecho.trim();
      const valid = validateExtraction(result, map);
      const { created, merged } = await createAiItems(this.meetingId, valid, "live", generationLabel("local"));
      console.log(
        `[agente ${this.meetingId.slice(0, 8)}] janela de ${window.length} segmentos: ${result.itens.length} itens, ${valid.length} válidos, ${created} novos, ${merged} mesclados`,
      );
    } catch (err) {
      // Resposta inválida após a nova tentativa: a janela é descartada (llm-schemas.md).
      if (!/Resposta do LLM inválida/.test((err as Error).message)) throw err;
      console.warn(`[agente ${this.meetingId.slice(0, 8)}] janela descartada: ${(err as Error).message}`);
    }

    // O texto guarda o cursor para a reconstrução no boot.
    await pool.query(
      `INSERT INTO meeting_notes (meeting_id, kind, pass, start_seconds, end_seconds, text)
       VALUES ($1, 'window', 'live', $2, $3, $4)`,
      [this.meetingId, ordered[0].start, ordered[ordered.length - 1].end, `#${lastId} ${summary}`],
    );
    this.cursor = lastId;
    this.lastExtractAt = Date.now();
    this.extractionsSince++;
    return window.length;
  }

  private async consolidate(): Promise<void> {
    const { rows } = await pool.query(
      `SELECT m.title, m.live_summary,
              COALESCE((SELECT created_at FROM meeting_notes WHERE meeting_id = m.id AND kind = 'consolidation'
                        ORDER BY created_at DESC LIMIT 1), 'epoch') AS since
       FROM meetings m WHERE m.id = $1`,
      [this.meetingId],
    );
    const info = rows[0];
    if (!info) return;
    const notes = await pool.query(
      `SELECT text FROM meeting_notes WHERE meeting_id = $1 AND kind = 'window' AND created_at > $2 ORDER BY created_at`,
      [this.meetingId, info.since],
    );
    const windowSummaries = notes.rows.map((r) => String(r.text).replace(/^#\d+\s*/, "")).filter(Boolean);
    const proposed = (await listItems(this.meetingId))
      .filter((i) => i.reviewStatus === "proposto")
      .slice(-MAX_CONSOLIDATION_ITEMS);
    const refs = new Map(proposed.map((item, i) => [`I${i + 1}`, item]));

    const result = await generate("live", {
      system: SYSTEM_CONSOLIDACAO,
      user: consolidationUser({
        title: info.title,
        summary: info.live_summary,
        windowSummaries,
        items: [...refs].map(([ref, item]) => ({ ref, type: item.type, description: item.description })),
      }),
      schema: Consolidacao,
      numCtx: 4096,
      label: `consolidação ${this.meetingId.slice(0, 8)}`,
    });

    const summary = result.resumo.trim().slice(0, 1200);
    const at = new Date();
    if (summary) {
      await pool.query(`UPDATE meetings SET live_summary = $2, live_summary_at = $3 WHERE id = $1`, [
        this.meetingId,
        summary,
        at,
      ]);
      hub.publishToMeeting(this.meetingId, { type: "summary", meetingId: this.meetingId, text: summary, at: at.toISOString() });
    }
    await pool.query(
      `INSERT INTO meeting_notes (meeting_id, kind, pass, text) VALUES ($1, 'consolidation', 'live', $2)`,
      [this.meetingId, summary || "(sem resumo)"],
    );

    let removed = 0;
    for (const group of result.duplicados) {
      const keep = refs.get(group.manter.trim().toUpperCase());
      if (!keep) continue;
      const remove = group.remover
        .map((r) => refs.get(r.trim().toUpperCase()))
        .filter((i): i is NonNullable<typeof i> => Boolean(i) && i!.id !== keep.id && i!.type === keep.type);
      if (remove.length) removed += (await mergeInto(this.meetingId, keep.id, remove.map((i) => i.id))).length;
    }
    this.lastConsolidateAt = Date.now();
    this.extractionsSince = 0;
    console.log(`[agente ${this.meetingId.slice(0, 8)}] consolidação: resumo ${summary.length} chars, ${removed} duplicados`);
  }
}

// ---------- gerenciador ----------

const agents = new Map<string, LiveAgent>();
const TICK_MS = 15_000;
let timer: NodeJS.Timeout | null = null;

async function agentFor(meetingId: string): Promise<LiveAgent> {
  let agent = agents.get(meetingId);
  if (!agent) {
    agent = await LiveAgent.restore(meetingId);
    agents.set(meetingId, agent);
  }
  return agent;
}

async function tickAll(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM meetings WHERE source IN ('ics', 'manual') AND status IN ('recording', 'stopping')`,
    );
    for (const { id } of rows) void (await agentFor(id)).tick();
  } catch (err) {
    console.error("[agente] erro no ciclo:", err);
  }
}

// Chamado pelo pipeline antes do passe final: a análise ao vivo termina sobre os segmentos `live`.
export async function flushLiveAgent(meetingId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM transcript_segments WHERE meeting_id = $1 AND pass = 'live' LIMIT 1`,
    [meetingId],
  );
  if (!rows.length) return;
  const agent = await agentFor(meetingId);
  await agent.flush();
  agents.delete(meetingId);
}

export function startLiveAgents(): void {
  timer ??= setInterval(() => void tickAll(), TICK_MS);
  timer.unref();
}

export function stopLiveAgents(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
