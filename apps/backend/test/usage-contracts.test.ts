import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AdminUsageReport,
  AuditQuery,
  UsageCallsQuery,
  UsageErrorCode,
  UsagePeriodQuery,
  UsageReport,
  USAGE_PROVIDERS,
  USAGE_PURPOSES,
} from "@meeting-bot/contracts";

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const UUID = "11111111-1111-1111-1111-111111111111";

describe("contratos de uso e auditoria (specs/004-uso-custo)", () => {
  it("período: month ou from/to, nunca os dois", () => {
    expect(ok(UsagePeriodQuery, {})).toBe(true);
    expect(ok(UsagePeriodQuery, { month: "2026-11" })).toBe(true);
    expect(ok(UsagePeriodQuery, { from: "2026-11-01T00:00:00Z", to: "2026-11-10T00:00:00Z" })).toBe(true);
    expect(ok(UsagePeriodQuery, { month: "2026-11", from: "2026-11-01T00:00:00Z", to: "2026-11-10T00:00:00Z" })).toBe(false);
    expect(ok(UsagePeriodQuery, { from: "2026-11-01T00:00:00Z" })).toBe(false);
    expect(ok(UsagePeriodQuery, { month: "2026-00" })).toBe(false);
    expect(ok(UsagePeriodQuery, { month: "2026-1" })).toBe(false);
  });

  it("chamadas: filtros em enum, limite 1–100 e padrão 30", () => {
    expect(UsageCallsQuery.parse({})).toMatchObject({ status: "all", limit: 30 });
    expect(UsageCallsQuery.parse({ limit: "100", status: "error", purpose: "ata", provider: "claude" })).toMatchObject({ limit: 100 });
    expect(ok(UsageCallsQuery, { limit: "101" })).toBe(false);
    expect(ok(UsageCallsQuery, { limit: "0" })).toBe(false);
    expect(ok(UsageCallsQuery, { status: "talvez" })).toBe(false);
    expect(ok(UsageCallsQuery, { purpose: "'; select" })).toBe(false);
    expect(ok(UsageCallsQuery, { provider: "gpt" })).toBe(false);
  });

  it("auditoria: userId uuid, limite e cursor curto", () => {
    expect(ok(AuditQuery, { userId: UUID, kind: "auth_login", limit: "50" })).toBe(true);
    expect(ok(AuditQuery, { userId: "ana" })).toBe(false);
    expect(ok(AuditQuery, { limit: "500" })).toBe(false);
    expect(ok(AuditQuery, { cursor: "x".repeat(201) })).toBe(false);
    expect(ok(AuditQuery, { from: "não é data" })).toBe(false);
  });

  it("código de erro: enum fechado ou http_NNN", () => {
    for (const code of ["timeout", "other", "http_402", "http_500"]) expect(ok(UsageErrorCode, code)).toBe(true);
    for (const code of ["http_42", "http_4020", "Not logged in", ""]) expect(ok(UsageErrorCode, code)).toBe(false);
  });

  it("finalidades e provedores cobrem o que o registro grava", () => {
    expect(USAGE_PURPOSES).toEqual(["ata", "adr", "itens", "resumo", "ao_vivo", "asr_final", "asr_ao_vivo", "busca", "chat", "outro"]);
    expect(USAGE_PROVIDERS).toEqual(["ollama", "openrouter", "claude", "codex", "whisper", "deepgram"]);
  });

  it("o relatório de admin não tem nenhum campo de reunião (garantia no contrato)", () => {
    const keys = Object.keys(AdminUsageReport.shape);
    expect(keys.filter((k) => /meeting|title/i.test(k))).toEqual([]);
    expect(Object.keys(UsageReport.shape)).toContain("topMeetings");
  });
});
