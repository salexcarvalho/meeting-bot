import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db", () => ({ pool: { query } }));

import { normalizeSample, ownerOfMeeting, recordUsage, resetOwnerCache, type UsageSample } from "../src/usage/recorder";

const flush = () => new Promise((r) => setImmediate(r));

function sample(over: Partial<UsageSample> = {}): UsageSample {
  return {
    category: "llm",
    purpose: "ata",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
    meetingId: null,
    inputTokens: 10,
    outputTokens: 5,
    audioSeconds: null,
    costUsd: 0.01,
    durationMs: 1200,
    computeMs: null,
    attempts: 1,
    success: true,
    errorCode: null,
    label: "narrativa abc",
    ...over,
  };
}

describe("recordUsage", () => {
  beforeEach(() => {
    query.mockReset();
    resetOwnerCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("falha do INSERT não propaga nem lança (a geração do usuário não pode falhar por isso)", async () => {
    query.mockRejectedValue(new Error("banco fora"));
    expect(() => recordUsage(sample())).not.toThrow();
    await flush();
    expect(console.error).toHaveBeenCalled();
  });

  it("não lança nem com o pool quebrado de forma síncrona", () => {
    query.mockImplementation(() => {
      throw new Error("pool destruído");
    });
    expect(() => recordUsage(sample({ meetingId: "11111111-1111-1111-1111-111111111111" }))).not.toThrow();
  });

  it("descarta amostra inválida (finalidade de ASR em chamada de LLM) sem tocar no banco", async () => {
    recordUsage(sample({ purpose: "asr_final" }));
    recordUsage(sample({ provider: "gpt" as never }));
    await flush();
    expect(query).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("grava os números e códigos normalizados (rótulo ≤ 80, tokens inteiros, falha com código)", async () => {
    query.mockResolvedValue({ rows: [] });
    recordUsage(sample({ label: "x".repeat(200), inputTokens: 10.6, success: false, errorCode: "http_402" }));
    await flush();
    const params = query.mock.calls[0][1] as unknown[];
    expect(params).toContain(11);
    expect(params).toContain("http_402");
    expect(params.find((p) => typeof p === "string" && p.startsWith("xxx"))).toHaveLength(80);
  });

  it("dono derivado da reunião, com cache de 60 s; reunião inexistente = sem dono", async () => {
    query.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT created_by") ? { rows: [{ created_by: "dono-1" }] } : { rows: [] },
    );
    const meetingId = "22222222-2222-2222-2222-222222222222";
    expect(await ownerOfMeeting(meetingId)).toBe("dono-1");
    expect(await ownerOfMeeting(meetingId)).toBe("dono-1");
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("SELECT created_by"))).toHaveLength(1);

    resetOwnerCache();
    query.mockResolvedValue({ rows: [] });
    expect(await ownerOfMeeting("33333333-3333-3333-3333-333333333333")).toBeNull();
  });
});

describe("normalizeSample", () => {
  it("falha sem código vira other e sucesso nunca carrega código", () => {
    expect(normalizeSample(sample({ success: false, errorCode: null }))?.errorCode).toBe("other");
    expect(normalizeSample(sample({ success: true, errorCode: "timeout" }))?.errorCode).toBeNull();
  });

  it("minutos de áudio só em ASR; negativos e NaN viram nulo", () => {
    expect(normalizeSample(sample({ audioSeconds: 30 }))?.audioSeconds).toBeNull();
    const asr = normalizeSample(sample({ category: "asr", purpose: "asr_final", provider: "deepgram", audioSeconds: 61.234 }));
    expect(asr?.audioSeconds).toBe(61.23);
    expect(normalizeSample(sample({ inputTokens: -1, outputTokens: Number.NaN, costUsd: -0.1 }))).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });

  it("tentativas ficam entre 1 e o teto do smallint", () => {
    expect(normalizeSample(sample({ attempts: 0 }))?.attempts).toBe(1);
    expect(normalizeSample(sample({ attempts: 99_999 }))?.attempts).toBe(32_767);
  });
});
