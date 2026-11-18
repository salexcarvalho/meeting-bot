import { config } from "../config";
import { pool } from "../db";
import { audit } from "../security/audit";

// Poda diária dos registros de uso e da auditoria (constituição 2.3.0). Prazo em dias; 0 = guardar sempre.
// Em lotes, com trava no banco para duas instâncias não podarem ao mesmo tempo. Só contagens vão para a auditoria.

export const PRUNE_LOCK_KEY = 727002;
const DEFAULT_BATCH = 5000;
const DAY_MS = 86_400_000;

export type PrunableTable = "ai_usage_logs" | "audit_log";

// Nomes fixos: nunca interpolar entrada de fora aqui.
const DELETE_SQL: Record<PrunableTable, string> = {
  ai_usage_logs: `DELETE FROM ai_usage_logs WHERE id IN (
    SELECT id FROM ai_usage_logs WHERE at < $1 ORDER BY at LIMIT $2)`,
  audit_log: `DELETE FROM audit_log WHERE id IN (
    SELECT id FROM audit_log WHERE at < $1 ORDER BY at LIMIT $2)`,
};

/** Apaga só o que é mais antigo que o prazo; devolve quantas linhas saíram. */
export async function pruneTable(table: PrunableTable, days: number, batchSize = DEFAULT_BATCH, now = Date.now()): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(now - days * DAY_MS);
  let total = 0;
  for (;;) {
    const result = await pool.query(DELETE_SQL[table], [cutoff, batchSize]);
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

/** Uma rodada da poda com a trava de sessão; false se outra instância já está podando. */
export async function runRetention(now = Date.now(), batchSize = DEFAULT_BATCH): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock($1) AS locked`, [PRUNE_LOCK_KEY]);
    if (!rows[0]?.locked) return false;
    try {
      const plan: [PrunableTable, number][] = [
        ["ai_usage_logs", config.usageRetentionDays],
        ["audit_log", config.auditRetentionDays],
      ];
      for (const [table, days] of plan) {
        const deleted = await pruneTable(table, days, batchSize, now);
        if (deleted > 0) audit("retention_pruned", { table, deleted, olderThanDays: days });
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [PRUNE_LOCK_KEY]).catch(() => {});
    }
    return true;
  } finally {
    client.release();
  }
}
