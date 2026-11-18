import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TAG = "retencao-teste";

type Prune = typeof import("../../src/retention/prune");

// Poda por prazo (constituição 2.3.0, FR-020): só o que passou do prazo, 0 desliga, lotes, trava (specs/004, US6).
describe.skipIf(!enabled)("retenção dos registros de uso e da auditoria (Postgres)", () => {
  let pool: Pool;
  let prune: Prune;
  const pools: Pool[] = [];

  async function load(env: Record<string, string> = {}): Promise<Prune> {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const db = await import("../../src/db");
    const { migrate } = await import("../../src/schema");
    await migrate(db.pool);
    pool = db.pool;
    pools.push(db.pool);
    return import("../../src/retention/prune");
  }

  const usage = (at: string, n = 1) =>
    pool.query(
      `INSERT INTO ai_usage_logs (at, category, purpose, provider, success, label)
       SELECT $1::timestamptz, 'llm', 'ata', 'ollama', true, $2 FROM generate_series(1, $3)`,
      [at, TAG, n],
    );
  const audit = (at: string, n = 1) =>
    pool.query(
      `INSERT INTO audit_log (at, kind, detail) SELECT $1::timestamptz, 'auth_login', jsonb_build_object('tag', $2::text) FROM generate_series(1, $3)`,
      [at, TAG, n],
    );
  const countUsage = async () => Number((await pool.query(`SELECT count(*) FROM ai_usage_logs WHERE label = $1`, [TAG])).rows[0].count);
  const countAudit = async () => Number((await pool.query(`SELECT count(*) FROM audit_log WHERE detail->>'tag' = $1`, [TAG])).rows[0].count);
  const reset = async () => {
    await pool.query(`DELETE FROM ai_usage_logs WHERE label = $1`, [TAG]);
    await pool.query(`DELETE FROM audit_log WHERE detail->>'tag' = $1 OR (kind = 'retention_pruned' AND detail->>'olderThanDays' = '365')`, [TAG]);
  };

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    prune = await load();
  });

  afterEach(async () => {
    await reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  });

  // 2001: bem antes de qualquer linha semeada por outros testes, que a poda não pode tocar
  const NOW = Date.parse("2001-06-15T12:00:00Z");
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

  it("só remove o que passou do prazo, nos dois lados do limite", async () => {
    await usage(ago(100), 3);
    await usage(ago(29), 2);
    await usage(ago(31), 4);
    const deleted = await prune.pruneTable("ai_usage_logs", 30, 5000, NOW);
    expect(deleted).toBe(4 + 3);
    expect(await countUsage()).toBe(2);
    const { rows } = await pool.query(`SELECT min(at) AS oldest FROM ai_usage_logs WHERE label = $1`, [TAG]);
    expect(new Date(rows[0].oldest).getTime()).toBe(NOW - 29 * DAY);
  });

  it("auditoria: a recente fica intacta", async () => {
    await audit(ago(400), 2);
    await audit(ago(5), 3);
    expect(await prune.pruneTable("audit_log", 365, 5000, NOW)).toBeGreaterThanOrEqual(2);
    expect(await countAudit()).toBe(3);
  });

  it("prazo 0 (ou inválido) não apaga nada", async () => {
    await usage(ago(5000), 3);
    expect(await prune.pruneTable("ai_usage_logs", 0, 5000, NOW)).toBe(0);
    expect(await prune.pruneTable("ai_usage_logs", -5, 5000, NOW)).toBe(0);
    expect(await prune.pruneTable("ai_usage_logs", Number.NaN, 5000, NOW)).toBe(0);
    expect(await countUsage()).toBe(3);
  });

  it("volume maior que o lote termina e conta tudo", async () => {
    await usage(ago(100), 25);
    expect(await prune.pruneTable("ai_usage_logs", 30, 10, NOW)).toBe(25);
    expect(await countUsage()).toBe(0);
  });

  it("a rodada completa poda as duas tabelas e audita só contagens (sem conteúdo)", async () => {
    const cfg = await load({ USAGE_RETENTION_DAYS: "365", AUDIT_RETENTION_DAYS: "365" });
    await usage("2000-01-01T00:00:00Z", 4);
    await usage(new Date(Date.now() - DAY).toISOString(), 2);
    await audit("2000-01-01T00:00:00Z", 3);
    await audit(new Date(Date.now() - DAY).toISOString(), 1);
    expect(await cfg.runRetention(Date.now())).toBe(true);
    expect(await countUsage()).toBe(2);
    expect(await countAudit()).toBe(1);
    let events: Record<string, unknown>[] = [];
    for (let i = 0; i < 40 && events.length < 2; i++) {
      events = (await pool.query(`SELECT detail FROM audit_log WHERE kind = 'retention_pruned' AND detail->>'olderThanDays' = '365' ORDER BY id`)).rows.map((r) => r.detail);
      await new Promise((r) => setTimeout(r, 25));
    }
    const byTable = Object.fromEntries(events.map((e) => [e.table as string, e]));
    expect(byTable.ai_usage_logs).toMatchObject({ deleted: 4, olderThanDays: 365 });
    expect(Number(byTable.audit_log.deleted)).toBeGreaterThanOrEqual(3);
    expect(Object.keys(byTable.ai_usage_logs).sort()).toEqual(["deleted", "olderThanDays", "table"]);
  });

  it("com prazo 0 configurado a rodada não apaga e não audita", async () => {
    const cfg = await load({ USAGE_RETENTION_DAYS: "0", AUDIT_RETENTION_DAYS: "0" });
    await usage("2000-01-01T00:00:00Z", 3);
    expect(await cfg.runRetention(Date.now())).toBe(true);
    expect(await countUsage()).toBe(3);
  });

  it("duas rodadas ao mesmo tempo não duplicam a poda (trava no banco)", async () => {
    const cfg = await load({ USAGE_RETENTION_DAYS: "365", AUDIT_RETENTION_DAYS: "0" });
    await usage("2000-01-01T00:00:00Z", 30);
    const results = await Promise.all([cfg.runRetention(Date.now(), 7), cfg.runRetention(Date.now(), 7)]);
    expect(results.some(Boolean)).toBe(true);
    expect(await countUsage()).toBe(0);
    // se a segunda esperou a primeira, ela só encontra o que sobrou (nada): o total auditado é exato
    for (let i = 0; i < 40; i++) {
      const { rows } = await pool.query(
        `SELECT COALESCE(sum((detail->>'deleted')::int), 0) AS total FROM audit_log WHERE kind = 'retention_pruned' AND detail->>'table' = 'ai_usage_logs' AND detail->>'olderThanDays' = '365'`,
      );
      if (Number(rows[0].total) >= 30) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const { rows } = await pool.query(
      `SELECT COALESCE(sum((detail->>'deleted')::int), 0) AS total FROM audit_log WHERE kind = 'retention_pruned' AND detail->>'table' = 'ai_usage_logs' AND detail->>'olderThanDays' = '365'`,
    );
    expect(Number(rows[0].total)).toBe(30);
  });
});
