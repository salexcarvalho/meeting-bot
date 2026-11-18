import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, Json } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!enabled)("tarefa manual: criação, edição e exclusão (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;

  const create = async (who: string, body: Json) => {
    const res = await h.call(who, "POST", "/tasks", body);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json;
  };
  const patch = (who: string, id: string, body: Json) => h.call(who, "PATCH", `/tasks/${id}`, body);
  const actions = async (who: string, id: string) =>
    (await h.call(who, "GET", `/tasks/${id}/history`)).json.history.map((e: Json) => e.action);

  beforeAll(async () => {
    h = await startHarness([
      ["te-ana", "USER", "Ana Lima"],
      ["te-bia", "USER", "Bia Souza"],
    ]);
  });

  afterAll(async () => {
    await h.stop();
  });

  it("cria com todos os campos: projeto, prazo, prioridade e responsável", async () => {
    const project = await h.projectId("Portal SES");
    const task = await create("te-ana", {
      title: "Revisar contrato",
      description: "Cláusulas de SLA",
      priority: "alta",
      dueDate: "2026-12-04",
      projectId: project,
      assignee: { kind: "other", name: "Carla Dias" },
    });
    expect(task).toMatchObject({
      status: "a_fazer",
      priority: "alta",
      dueDate: "2026-12-04",
      project: { id: project, name: "Portal SES" },
      assignee: { kind: "other", name: "Carla Dias" },
      origin: "manual",
      sourceItem: null,
    });
  });

  it("limites de título (3 a 200) e descrição (até 4000)", async () => {
    expect((await h.call("te-ana", "POST", "/tasks", { title: "ab" })).status).toBe(400);
    expect((await h.call("te-ana", "POST", "/tasks", { title: "x".repeat(201) })).status).toBe(400);
    expect((await h.call("te-ana", "POST", "/tasks", { title: "abc", description: "d".repeat(4001) })).status).toBe(400);
    expect((await h.call("te-ana", "POST", "/tasks", { title: "x".repeat(200), description: "d".repeat(4000) })).status).toBe(201);
  });

  it("prazo no passado é aceito (e a tarefa fica atrasada)", async () => {
    const task = await create("te-ana", { title: "Prazo antigo", dueDate: "2020-01-15" });
    expect(task).toMatchObject({ dueDate: "2020-01-15", overdue: true });
  });

  it("responsável 'other' sem nome → 400; trocar o responsável grava histórico com antes e depois", async () => {
    expect((await h.call("te-ana", "POST", "/tasks", { title: "Sem nome", assignee: { kind: "other" } })).status).toBe(400);
    const task = await create("te-ana", { title: "Delegar", assignee: { kind: "other", name: "Carla" } });
    const self = await patch("te-ana", task.id, { assignee: { kind: "self" } });
    expect(self.json.assignee).toEqual({ kind: "self", name: null });
    const none = await patch("te-ana", task.id, { assignee: { kind: "none" } });
    expect(none.json.assignee).toEqual({ kind: "none", name: null });
    const edits = (await h.call("te-ana", "GET", `/tasks/${task.id}/history`)).json.history.filter((e: Json) => e.action === "edited");
    expect(edits[0].before).toEqual({ assignee: { kind: "other", name: "Carla" } });
    expect(edits[0].after).toEqual({ assignee: { kind: "self", name: null } });
    expect(edits).toHaveLength(2);
  });

  it("projeto inexistente → 404 na criação e na edição; remover o projeto com null", async () => {
    expect((await h.call("te-ana", "POST", "/tasks", { title: "Projeto fantasma", projectId: ZERO_UUID })).status).toBe(404);
    const project = await h.projectId("Agenith");
    const task = await create("te-ana", { title: "Com projeto", projectId: project });
    expect((await patch("te-ana", task.id, { projectId: ZERO_UUID })).status).toBe(404);
    expect((await patch("te-ana", task.id, { projectId: null })).json.project).toBeNull();
  });

  it("reunião sem acesso → 404; com acesso, a tarefa herda o projeto da reunião e não muda a reunião depois", async () => {
    const project = await h.projectId("InfraVision");
    const mine = await h.seedMeeting("te-ana", { title: "Reunião de infra", projectId: project });
    const hers = await h.seedMeeting("te-bia");
    expect((await h.call("te-ana", "POST", "/tasks", { title: "Reunião alheia", meetingId: hers })).status).toBe(404);
    expect((await h.call("te-ana", "POST", "/tasks", { title: "Reunião fantasma", meetingId: ZERO_UUID })).status).toBe(404);
    const task = await create("te-ana", { title: "Ligada à reunião", meetingId: mine });
    expect(task).toMatchObject({ meeting: { id: mine, title: "Reunião de infra" }, project: { id: project } });
    expect(task.source).toMatchObject({ meetingTitle: "Reunião de infra" });
    expect((await patch("te-ana", task.id, { meetingId: hers })).status).toBe(400);
    const explicit = await create("te-ana", { title: "Projeto explícito", meetingId: mine, projectId: await h.projectId("Agenith") });
    expect(explicit.project.name).toBe("Agenith");
  });

  it("histórico: um registro 'edited' por requisição só com os campos alterados; status à parte", async () => {
    const task = await create("te-ana", { title: "Histórico fino", priority: "media", dueDate: "2026-12-01" });
    await patch("te-ana", task.id, { title: "Histórico fino", priority: "urgente", dueDate: "2026-12-01", description: "nova" });
    await patch("te-ana", task.id, { priority: "urgente" });
    await patch("te-ana", task.id, { status: "em_andamento", dueDate: null });
    const history = (await h.call("te-ana", "GET", `/tasks/${task.id}/history`)).json.history;
    expect(history.map((e: Json) => e.action)).toEqual(["created", "edited", "edited", "status_changed"]);
    expect(history[1].before).toEqual({ priority: "media", description: "" });
    expect(history[1].after).toEqual({ priority: "urgente", description: "nova" });
    expect(history[2].before).toEqual({ dueDate: "2026-12-01" });
    expect(history[2].after).toEqual({ dueDate: null });
    expect(history[3].before).toEqual({ status: "a_fazer" });
    expect(history[3].after).toEqual({ status: "em_andamento" });
  });

  it("dueHint só pode ser limpo", async () => {
    const meetingId = await h.seedMeeting("te-ana");
    const itemId = await h.seedItem(meetingId, { description: "Responder o ofício até sexta", due: "sexta-feira", status: "aprovado" });
    const created = (await h.call("te-ana", "POST", "/tasks/from-item", { itemId })).json.task;
    expect(created.dueHint).toBe("sexta-feira");
    expect((await patch("te-ana", created.id, { dueHint: "segunda" })).status).toBe(400);
    const cleared = await patch("te-ana", created.id, { dueHint: null, dueDate: "2026-11-20" });
    expect(cleared.json).toMatchObject({ dueHint: null, dueDate: "2026-11-20" });
  });

  it("reabrir limpa completedAt; concluída e reaberta mantém o histórico", async () => {
    const task = await create("te-ana", { title: "Reabrível" });
    await h.call("te-ana", "POST", `/tasks/${task.id}/status`, { status: "concluida" });
    const reopened = await h.call("te-ana", "POST", `/tasks/${task.id}/status`, { status: "em_andamento" });
    expect(reopened.json).toMatchObject({ status: "em_andamento", completedAt: null });
    expect(await actions("te-ana", task.id)).toEqual(["created", "status_changed", "status_changed"]);
    // mesmo status de novo: nada muda
    await h.call("te-ana", "POST", `/tasks/${task.id}/status`, { status: "em_andamento" });
    expect(await actions("te-ana", task.id)).toHaveLength(3);
  });

  it("excluir libera o par (item, dono): virar tarefa de novo cria outra", async () => {
    const meetingId = await h.seedMeeting("te-ana");
    const itemId = await h.seedItem(meetingId, { description: "Preparar o relatório de auditoria", status: "aprovado" });
    const first = (await h.call("te-ana", "POST", "/tasks/from-item", { itemId })).json.task;
    expect((await h.call("te-ana", "DELETE", `/tasks/${first.id}`)).status).toBe(204);
    const again = await h.call("te-ana", "POST", "/tasks/from-item", { itemId });
    expect(again.status).toBe(201);
    expect(again.json.task.id).not.toBe(first.id);
    // o item de origem continua
    expect((await h.call("te-ana", "GET", `/meetings/${meetingId}/items`)).json.items).toHaveLength(1);
  });

  it("aviso do item de origem: reaberto ou rejeitado aparece em sourceItem.reviewStatus, sem mudar a tarefa", async () => {
    const meetingId = await h.seedMeeting("te-ana");
    const itemId = await h.seedItem(meetingId, { description: "Contratar a revisão externa do código", status: "aprovado" });
    const task = (await h.call("te-ana", "POST", "/tasks/from-item", { itemId })).json.task;
    await h.call("te-ana", "POST", `/items/${itemId}/reopen`);
    const after = (await h.call("te-ana", "GET", `/tasks/${task.id}`)).json;
    expect(after.sourceItem.reviewStatus).toBe("proposto");
    expect(after.title).toBe(task.title);
    await h.call("te-ana", "POST", `/items/${itemId}/reject`);
    expect((await h.call("te-ana", "GET", `/tasks/${task.id}`)).json.sourceItem.reviewStatus).toBe("rejeitado");
  });
});
