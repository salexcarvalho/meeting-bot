import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, Json } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// Incorporação única do histórico do audit_log (formato antigo) ao registro de uso (FR-021, SC-008).
describe.skipIf(!enabled)("incorporação do histórico de envios externos (Postgres)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  const { backfillUsageFromAudit } = await import("../../src/usage/backfill");
  let h: Harness;
  let meeting: string;
  let legacyIds: number[] = [];
  let newFormatId = 0;

  const add = async (kind: string, detail: Json, user: string | null = null): Promise<number> => {
    const { rows } = await h.pool.query(`INSERT INTO audit_log (at, kind, detail, user_id) VALUES ('2026-03-10T12:00:00Z', $1, $2, $3) RETURNING id`, [
      kind,
      detail,
      user ? h.ids[user] : null,
    ]);
    return Number(rows[0].id);
  };
  const imported = async () =>
    (await h.pool.query(`SELECT * FROM ai_usage_logs WHERE audit_log_id = ANY($1::bigint[]) ORDER BY audit_log_id`, [[...legacyIds, newFormatId]])).rows;

  beforeAll(async () => {
    h = await startHarness([["bf-ana", "USER", "Ana"]]);
    meeting = await h.seedMeeting("bf-ana", { title: "Reunião do histórico" });
    legacyIds = [
      await add("external_llm", { meetingId: meeting, label: "extração final abc 1/2", provider: "openrouter", model: "anthropic/claude-sonnet-5", promptTokens: 1500, completionTokens: 300, cost: 0.0421, durationMs: 8000 }),
      await add("external_llm", { meetingId: meeting, label: "narrativa abc", provider: "claude", model: "claude-sonnet-5", promptTokens: 900, completionTokens: 80, cost: null, durationMs: 4000 }),
      await add("external_llm", { meetingId: null, label: "algo desconhecido", model: "m" }),
      await add("external_llm", { meetingId: "não-é-uuid", label: "ADR abc 1/1", provider: "gpt-fora-da-lista", promptTokens: -5, cost: -1 }),
      await add("external_asr", { meetingId: meeting, channel: "remote", seconds: 600, model: "deepgram/nova-3" }),
      await add("external_asr", { meetingId: meeting, channel: "canal-estranho", seconds: 30, model: "deepgram/nova-3" }),
    ];
    // linha já no formato novo (com `purpose`): o registro de uso a gera, então NÃO pode ser incorporada de novo
    newFormatId = await add("external_llm", { meetingId: meeting, label: "narrativa nova", provider: "openrouter", purpose: "ata", success: true, promptTokens: 1, completionTokens: 1 }, "bf-ana");
  });

  afterAll(async () => {
    await h.stop();
  });

  it("incorpora o histórico antigo uma vez, com dono pela reunião, tokens, custo e finalidade deduzida", async () => {
    const first = await backfillUsageFromAudit();
    expect(first).toBeGreaterThanOrEqual(legacyIds.length);
    const rows = await imported();
    expect(rows).toHaveLength(legacyIds.length);
    const byAudit = new Map(rows.map((r) => [Number(r.audit_log_id), r]));
    const [extract, narrative, unknown, weird, asr, asrWeird] = legacyIds.map((id) => byAudit.get(id)!);
    expect(extract).toMatchObject({ user_id: h.ids["bf-ana"], meeting_id: meeting, category: "llm", purpose: "itens", provider: "openrouter", input_tokens: "1500", output_tokens: "300", duration_ms: 8000, source: "audit_backfill", success: true });
    expect(Number(extract.cost_usd)).toBeCloseTo(0.0421, 6);
    expect(narrative).toMatchObject({ purpose: "ata", provider: "claude", cost_usd: null });
    expect(unknown).toMatchObject({ purpose: "outro", user_id: null, meeting_id: null, provider: "openrouter" });
    expect(weird).toMatchObject({ purpose: "adr", provider: "openrouter", meeting_id: null, input_tokens: null, cost_usd: null });
    expect(asr).toMatchObject({ category: "asr", purpose: "asr_final", provider: "deepgram", channel: "remote", user_id: h.ids["bf-ana"] });
    expect(Number(asr.audio_seconds)).toBe(600);
    expect(asrWeird.channel).toBeNull();
  });

  it("rodar de novo não duplica nada (idempotente) e a linha no formato novo nunca é incorporada", async () => {
    const before = await imported();
    const second = await backfillUsageFromAudit();
    const third = await backfillUsageFromAudit();
    expect(second).toBe(0);
    expect(third).toBe(0);
    const after = await imported();
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.some((r) => Number(r.audit_log_id) === newFormatId)).toBe(false);
  });

  it("o histórico incorporado aparece no painel do dono, sem duplicar no mês", async () => {
    const res = await h.call("bf-ana", "GET", "/usage/me?month=2026-03");
    // dono pela reunião: só as linhas com dono entram no painel dele (as sem reunião ficam na instância)
    const owned = (await imported()).filter((r) => r.user_id === h.ids["bf-ana"]).length;
    expect(res.json.totals.calls).toBe(owned);
    expect(res.json.asr.external.audioSeconds).toBe(630);
  });

  it("não traz de volta o que a poda por prazo apagaria (linha mais antiga que o prazo de uso)", async () => {
    const { rows } = await h.pool.query(
      `INSERT INTO audit_log (at, kind, detail) VALUES ('2020-01-01T00:00:00Z', 'external_llm', '{"label":"narrativa velha","provider":"claude"}') RETURNING id`,
    );
    await backfillUsageFromAudit();
    const found = await h.pool.query(`SELECT 1 FROM ai_usage_logs WHERE audit_log_id = $1`, [rows[0].id]);
    expect(found.rowCount).toBe(0);
  });
});
