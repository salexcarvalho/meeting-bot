import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// Migração aditiva da F6 e as travas da tabela ai_usage_logs (specs/004-uso-custo/data-model.md).
describe.skipIf(!enabled)("ai_usage_logs: migração e restrições (Postgres)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;

  const insert = (over: Record<string, unknown> = {}) => {
    const row = {
      user_id: null,
      meeting_id: null,
      category: "llm",
      purpose: "ata",
      provider: "openrouter",
      audio_seconds: null,
      input_tokens: 10,
      cost_usd: 0.1,
      success: true,
      error_code: null,
      label: null,
      ...over,
    };
    return h.pool.query(
      `INSERT INTO ai_usage_logs (user_id, meeting_id, category, purpose, provider, audio_seconds, input_tokens, cost_usd, success, error_code, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [row.user_id, row.meeting_id, row.category, row.purpose, row.provider, row.audio_seconds, row.input_tokens, row.cost_usd, row.success, row.error_code, row.label],
    );
  };

  beforeAll(async () => {
    h = await startHarness([["us-schema", "USER", null]]);
  });
  afterAll(async () => {
    await h.stop();
  });

  it("a migração roda de novo sem erro e sem mexer nos dados (idempotente)", async () => {
    const { migrate } = await import("../../src/schema");
    const before = await insert();
    await migrate(h.pool);
    await migrate(h.pool);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM ai_usage_logs WHERE id = $1`, [before.rows[0].id]);
    expect(rows[0].n).toBe(1);
  });

  it("recusa falha sem código, valores negativos, finalidade fora do enum e código de erro livre", async () => {
    await expect(insert({ success: false, error_code: null })).rejects.toThrow();
    await expect(insert({ input_tokens: -1 })).rejects.toThrow();
    await expect(insert({ cost_usd: -0.01 })).rejects.toThrow();
    await expect(insert({ purpose: "qualquer" })).rejects.toThrow();
    await expect(insert({ success: false, error_code: "Not logged in" })).rejects.toThrow();
    await expect(insert({ label: "x".repeat(81) })).rejects.toThrow();
    await expect(insert({ success: false, error_code: "http_402" })).resolves.toBeTruthy();
    await expect(insert({ success: false, error_code: "timeout" })).resolves.toBeTruthy();
  });

  it("categoria e finalidade têm de combinar; minutos de áudio só em ASR", async () => {
    await expect(insert({ category: "llm", purpose: "asr_final" })).rejects.toThrow();
    await expect(insert({ category: "asr", purpose: "ata", audio_seconds: 10 })).rejects.toThrow();
    await expect(insert({ category: "llm", audio_seconds: 10 })).rejects.toThrow();
    await expect(insert({ category: "asr", purpose: "asr_final", provider: "deepgram", audio_seconds: 61.5 })).resolves.toBeTruthy();
  });

  it("excluir reunião e usuário preserva o consumo (vínculos viram nulos)", async () => {
    const owner = h.ids["us-schema"];
    const meetingId = await h.seedMeeting("us-schema", { title: "Reunião que vai sumir" });
    const { rows } = await insert({ user_id: owner, meeting_id: meetingId, label: "preservado" });
    await h.pool.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);
    let row = (await h.pool.query(`SELECT user_id, meeting_id FROM ai_usage_logs WHERE id = $1`, [rows[0].id])).rows[0];
    expect(row).toEqual({ user_id: owner, meeting_id: null });

    const { rows: tmp } = await h.pool.query(
      `INSERT INTO users (username, password_hash) VALUES ('us-temporario', 'x') RETURNING id`,
    );
    const second = await insert({ user_id: tmp[0].id, label: "do usuário removido" });
    await h.pool.query(`DELETE FROM users WHERE id = $1`, [tmp[0].id]);
    row = (await h.pool.query(`SELECT user_id FROM ai_usage_logs WHERE id = $1`, [second.rows[0].id])).rows[0];
    expect(row.user_id).toBeNull();
  });

  it("índices esperados existem, inclusive o único do histórico incorporado", async () => {
    const { rows } = await h.pool.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('ai_usage_logs', 'audit_log')`);
    const names = rows.map((r) => r.indexname);
    for (const name of ["idx_usage_user_at", "idx_usage_at", "idx_usage_meeting", "uq_usage_audit_log", "idx_audit_target"]) {
      expect(names).toContain(name);
    }
  });
});
