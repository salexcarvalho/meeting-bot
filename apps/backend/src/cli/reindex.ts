import { pool } from "../db";
import { migrate } from "../schema";

// Uso administrativo local: npm run search:reindex [-- <id da reunião>]
// Recoloca na fila de indexação todas as reuniões concluídas (ou uma). Só mexe em `search_index_state`
// (ids e estados); não lê nem imprime conteúdo de reunião. O worker do backend faz o trabalho.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const meetingId = process.argv[2];
  if (meetingId !== undefined && !UUID.test(meetingId)) throw new Error("Informe o id da reunião (uuid) ou nada para todas.");
  await migrate(pool);
  const { rowCount } = await pool.query(
    `INSERT INTO search_index_state (meeting_id, status)
     SELECT m.id, 'pending' FROM meetings m WHERE m.status = 'done' AND ($1::uuid IS NULL OR m.id = $1::uuid)
     ON CONFLICT (meeting_id) DO UPDATE
        SET status = 'pending', dirty_at = now(), attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()`,
    [meetingId ?? null],
  );
  process.stdout.write(`${rowCount ?? 0} reunião(ões) na fila de indexação.\n`);
}

main()
  .catch((err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
