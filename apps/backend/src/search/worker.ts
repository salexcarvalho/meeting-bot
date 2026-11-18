import { config } from "../config";
import { pool } from "../db";
import { liveBusy, semanticState, vectorInstalled } from "./gate";
import {
  embedPending,
  finishEmbedding,
  finishText,
  finishTextOnly,
  indexMeetingText,
  publishState,
  recordFailure,
  type EmbedOptions,
} from "./indexer";

// Worker em segundo plano: uma reunião por vez, guiado por `search_index_state` (fila durável).
// Ordem: a alteração mais recente primeiro (reunião nova passa na frente do backfill) e, no empate,
// a reunião mais recente. Embeddings esperam a gravação/chamada terminar; o texto não espera.

const TICK_MS = 5_000;

interface Job {
  meetingId: string;
  /** estado antes de assumir: `pending` roda texto e vetores; `text_ready` só os vetores */
  previous: "pending" | "text_ready";
  dirtyAt: string;
}

const CLAIM_SQL = `
  WITH next AS (
    SELECT q.meeting_id, q.status AS previous
      FROM search_index_state q
      JOIN meetings m ON m.id = q.meeting_id AND m.status = 'done'
     WHERE ((q.status = 'pending' AND q.dirty_at <= now() - make_interval(secs => $1::int))
            OR (q.status = 'text_ready' AND $2::boolean))
       AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
     ORDER BY q.dirty_at DESC, COALESCE(m.started_at, m.scheduled_start, m.created_at) DESC
     LIMIT 1
     FOR UPDATE OF q SKIP LOCKED
  )
  UPDATE search_index_state s SET status = 'indexing', updated_at = now()
    FROM next WHERE s.meeting_id = next.meeting_id
  RETURNING s.meeting_id, next.previous, s.dirty_at::text AS dirty_at`;

/** Vetores podem ser calculados agora? Semântica ligada, pgvector, modelo no Ollama e nenhuma reunião ao vivo. */
async function vectorsAllowed(): Promise<boolean> {
  if (config.search.semantic === "off" || !(await vectorInstalled())) return false;
  if (await liveBusy()) return false;
  return (await semanticState()).available;
}

export async function recoverInterrupted(): Promise<number> {
  const { rowCount } = await pool.query(`UPDATE search_index_state SET status = 'pending', updated_at = now() WHERE status = 'indexing'`);
  return rowCount ?? 0;
}

async function claim(allowVectors: boolean): Promise<Job | null> {
  const { rows } = await pool.query(CLAIM_SQL, [config.search.indexDebounceSeconds, allowVectors]);
  if (!rows[0]) return null;
  return { meetingId: rows[0].meeting_id, previous: rows[0].previous, dirtyAt: rows[0].dirty_at };
}

async function runVectors(job: Job): Promise<void> {
  const options: EmbedOptions = { paused: liveBusy };
  const progress = await embedPending(job.meetingId, options);
  await finishEmbedding(job.meetingId, job.dirtyAt, progress);
}

async function processJob(job: Job): Promise<void> {
  let phase: "text" | "vectors" = "text";
  try {
    if (job.previous === "pending") {
      const text = await indexMeetingText(job.meetingId);
      if (!text) return;
      if (!(await finishText(job.meetingId, text.dirtyAt, text.chunks))) return;
    }
    phase = "vectors";
    if (await vectorsAllowed()) await runVectors(job);
    else await finishTextOnly(job.meetingId, job.dirtyAt);
  } catch (err) {
    console.error(`[busca] indexação da reunião ${job.meetingId} falhou na fase ${phase}: ${(err as Error).name}`);
    await recordFailure(job.meetingId, err, phase).catch((e) => console.error(`[busca] falha ao registrar o erro: ${(e as Error).name}`));
  } finally {
    await publishState(job.meetingId).catch(() => undefined);
  }
}

/** Faz no máximo um trabalho; devolve se havia algo a fazer. Exportado para os testes. */
export async function tick(): Promise<boolean> {
  if (!config.search.enabled) return false;
  const job = await claim(await vectorsAllowed());
  if (!job) return false;
  await processJob(job);
  return true;
}

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> = Promise.resolve();
let stopped = true;

function schedule(delay: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    running = tick()
      .then((worked) => schedule(worked ? 0 : TICK_MS))
      .catch((err) => {
        console.error(`[busca] erro no worker: ${(err as Error).name}`);
        schedule(TICK_MS);
      });
  }, delay);
}

/** Retoma o que ficou `indexing` e começa o ciclo, sem travar o boot (o primeiro tick roda depois). */
export function startSearchWorker(): void {
  if (!config.search.enabled || !stopped) return;
  stopped = false;
  void recoverInterrupted()
    .then((n) => {
      if (n) console.warn(`[busca] ${n} indexação(ões) interrompida(s) recolocada(s) na fila`);
    })
    .catch((err) => console.error(`[busca] falha ao recuperar a fila: ${(err as Error).name}`))
    .finally(() => schedule(TICK_MS));
}

export async function stopSearchWorker(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  await running.catch(() => undefined);
}
