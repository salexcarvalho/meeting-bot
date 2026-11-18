import type { PoolClient } from "pg";
import { config } from "../config";
import { pool } from "../db";

// Gatilhos de indexação. A fila é a tabela `search_index_state`: `dirty_at` é o relógio do debounce
// (o worker só pega a reunião quando a última alteração é mais velha que SEARCH_INDEX_DEBOUNCE_SECONDS),
// então edições próximas se juntam e o que estava pendente sobrevive a um reinício.

const MARK_SQL = `
  INSERT INTO search_index_state (meeting_id, status)
  SELECT m.id, 'pending' FROM meetings m WHERE m.id = $1 AND m.status = 'done'
  ON CONFLICT (meeting_id) DO UPDATE
     SET status = 'pending', dirty_at = now(), attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()`;

/**
 * Marca a reunião para reindexação. Só reuniões concluídas entram na fila. Nunca lança: falha de
 * indexação não pode quebrar a ação do usuário nem o pipeline; o erro vai para o log sem conteúdo.
 */
export async function markDirty(meetingId: string): Promise<void> {
  if (!config.search.enabled) return;
  try {
    await pool.query(MARK_SQL, [meetingId]);
  } catch (err) {
    console.error(`[busca] falha ao marcar a reunião ${meetingId} para indexação: ${(err as Error).name}`);
  }
}

/** Renomear ou excluir um projeto muda o trecho de metadados das reuniões dele. */
export async function markProjectDirty(projectId: string): Promise<void> {
  if (!config.search.enabled) return;
  try {
    await pool.query(
      `INSERT INTO search_index_state (meeting_id, status)
       SELECT m.id, 'pending' FROM meetings m WHERE m.project_id = $1 AND m.status = 'done'
       ON CONFLICT (meeting_id) DO UPDATE
          SET status = 'pending', dirty_at = now(), attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()`,
      [projectId],
    );
  } catch (err) {
    console.error(`[busca] falha ao marcar as reuniões do projeto para indexação: ${(err as Error).name}`);
  }
}

/** Dispara sem esperar (para rotas que respondem antes). */
export function markDirtyLater(meetingId: string): void {
  void markDirty(meetingId);
}

/**
 * Passe final/exclusão de transcrição: apaga os trechos de transcrição na MESMA transação da troca
 * (FR-014) e recoloca a reunião na fila, se ela já tinha estado. Quem chama decide o commit.
 */
export async function invalidateTranscript(client: Pick<PoolClient, "query">, meetingId: string): Promise<void> {
  if (!config.search.enabled) return;
  await client.query(`DELETE FROM search_chunks WHERE meeting_id = $1 AND kind = 'transcript'`, [meetingId]);
  await client.query(
    `UPDATE search_index_state
        SET status = 'pending', dirty_at = now(), attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
      WHERE meeting_id = $1`,
    [meetingId],
  );
}
