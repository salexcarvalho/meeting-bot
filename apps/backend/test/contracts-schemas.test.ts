import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdrPatch, AgentCalendarImportInput, HeartbeatInput, ItemPatch, LLM_SCHEMAS, NewItemInput, ProjectInput, ScheduledMeetingInput, ShareChangeInput, ShareInput } from "@meeting-bot/contracts";

// Os JSON em packages/contracts/schemas são gerados por `npm run schemas -w @meeting-bot/contracts`.
// Este teste falha se o zod mudou e os arquivos commitados não acompanharam.
const SCHEMAS_DIR = path.resolve(__dirname, "../../../packages/contracts/schemas");
const all: Record<string, z.ZodType> = {
  ...LLM_SCHEMAS,
  ScheduledMeetingInput,
  ItemPatch,
  NewItemInput,
  AdrPatch,
  ProjectInput,
  HeartbeatInput,
  AgentCalendarImportInput,
};

describe("schemas JSON do contrato", () => {
  it("estão em dia com os schemas zod (rode npm run schemas -w @meeting-bot/contracts)", () => {
    const files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".json")).sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(Object.keys(all).map((n) => `${n}.json`).sort((a, b) => a.localeCompare(b)));
    for (const [name, schema] of Object.entries(all)) {
      const committed: unknown = JSON.parse(readFileSync(path.join(SCHEMAS_DIR, `${name}.json`), "utf8"));
      expect(committed, name).toEqual(z.toJSONSchema(schema, { target: "draft-07" }));
    }
  });
});

describe("contratos de compartilhamento", () => {
  const userId = "7d9e0c1a-3b4f-4a5b-8c6d-1e2f3a4b5c6d";

  it("ShareInput aceita leitura e edição e assume o alcance 'occurrence'", () => {
    expect(ShareInput.parse({ userId, access: "read" })).toEqual({ userId, access: "read", scope: "occurrence" });
    expect(ShareInput.parse({ userId, access: "edit", scope: "following" }).scope).toBe("following");
  });

  it("recusa nível inválido, alcance inválido e usuário que não é uuid", () => {
    expect(ShareInput.safeParse({ userId, access: "owner" }).success).toBe(false);
    expect(ShareInput.safeParse({ userId, access: "read", scope: "all" }).success).toBe(false);
    expect(ShareInput.safeParse({ userId: "bia", access: "read" }).success).toBe(false);
    expect(ShareChangeInput.safeParse({ access: "admin" }).success).toBe(false);
    expect(ShareChangeInput.safeParse({}).success).toBe(false);
  });
});
