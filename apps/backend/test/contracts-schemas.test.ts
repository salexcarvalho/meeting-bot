import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdrPatch, AgentCalendarImportInput, HeartbeatInput, ItemPatch, LLM_SCHEMAS, NewItemInput, ProjectInput, ScheduledMeetingInput, ShareChangeInput, ShareInput, TaskFromItemInput, TaskInput, TaskPatch } from "@meeting-bot/contracts";

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

describe("schemas de tarefas", () => {
  const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
  const UUID = "11111111-1111-4111-8111-111111111111";

  it("TaskInput: título de 3 a 200 caracteres", () => {
    expect(ok(TaskInput, { title: "Rev" })).toBe(true);
    expect(ok(TaskInput, { title: "ab" })).toBe(false);
    expect(ok(TaskInput, { title: "  ab  " })).toBe(false);
    expect(ok(TaskInput, { title: "x".repeat(201) })).toBe(false);
    expect(ok(TaskInput, { title: "x".repeat(200) })).toBe(true);
  });

  it("status e prioridade inválidos são recusados", () => {
    expect(ok(TaskInput, { title: "Tarefa", status: "pendente" })).toBe(false);
    expect(ok(TaskInput, { title: "Tarefa", priority: "critica" })).toBe(false);
    expect(ok(TaskInput, { title: "Tarefa", status: "bloqueada", priority: "urgente" })).toBe(true);
  });

  it("responsável 'other' exige nome; 'self' e 'none' não aceitam nome", () => {
    expect(ok(TaskInput, { title: "Tarefa", assignee: { kind: "other" } })).toBe(false);
    expect(ok(TaskInput, { title: "Tarefa", assignee: { kind: "other", name: "  " } })).toBe(false);
    expect(ok(TaskInput, { title: "Tarefa", assignee: { kind: "other", name: "João" } })).toBe(true);
    expect(ok(TaskInput, { title: "Tarefa", assignee: { kind: "self", name: "x" } })).toBe(false);
    expect(ok(TaskInput, { title: "Tarefa", assignee: { kind: "none" } })).toBe(true);
  });

  it("campos de leitura nunca aceitam escrita (externalRef, origin, source, completedAt, overdue)", () => {
    for (const field of ["externalRef", "origin", "source", "completedAt", "overdue", "ownerId", "sourceItemId"]) {
      expect(ok(TaskInput, { title: "Tarefa", [field]: "x" })).toBe(false);
      expect(ok(TaskPatch, { title: "Tarefa", [field]: "x" })).toBe(false);
    }
  });

  it("prazo precisa ser uma data civil válida", () => {
    expect(ok(TaskInput, { title: "Tarefa", dueDate: "2026-11-30" })).toBe(true);
    expect(ok(TaskInput, { title: "Tarefa", dueDate: null })).toBe(true);
    expect(ok(TaskInput, { title: "Tarefa", dueDate: "2026-02-31" })).toBe(false);
    expect(ok(TaskInput, { title: "Tarefa", dueDate: "30/11/2026" })).toBe(false);
  });

  it("TaskPatch: exige ao menos um campo, não muda a reunião e dueHint só aceita null", () => {
    expect(ok(TaskPatch, {})).toBe(false);
    expect(ok(TaskPatch, { dueDate: null })).toBe(true);
    expect(ok(TaskPatch, { dueHint: null })).toBe(true);
    expect(ok(TaskPatch, { dueHint: "sexta" })).toBe(false);
    expect(ok(TaskPatch, { meetingId: UUID })).toBe(false);
    expect(ok(TaskPatch, { projectId: UUID })).toBe(true);
  });

  it("TaskFromItemInput: itemId uuid e campos estritos", () => {
    expect(ok(TaskFromItemInput, { itemId: UUID })).toBe(true);
    expect(ok(TaskFromItemInput, { itemId: "x" })).toBe(false);
    expect(ok(TaskFromItemInput, { itemId: UUID, force: true, priority: "alta" })).toBe(true);
    expect(ok(TaskFromItemInput, { itemId: UUID, origin: "item_auto" })).toBe(false);
  });
});
