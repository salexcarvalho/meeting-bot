import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, Json } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!enabled)("tarefas: base, CRUD e isolamento (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  const { migrate } = await import("../../src/schema");
  let h: Harness;

  const create = async (who: string, body: Json) => {
    const res = await h.call(who, "POST", "/tasks", body);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json;
  };

  beforeAll(async () => {
    h = await startHarness([
      ["tb-ana", "USER", "Ana Lima"],
      ["tb-bia", "USER", "Bia Souza"],
      ["tb-admin", "ADMIN", "Admin Geral"],
      ["tb-super", "SUPER_ADMIN", null],
      ["tb-leo", "VIEWER", "Leo Viana"],
    ]);
  });

  afterAll(async () => {
    await h.stop();
  });

  it("a migração é idempotente e só aditiva (rodar duas vezes não muda nada)", async () => {
    const before = await h.pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('tasks', 'task_history')`);
    await migrate(h.pool);
    await migrate(h.pool);
    const after = await h.pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('tasks', 'task_history')`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const idx = await h.pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'tasks' AND indexname = 'uq_tasks_item_owner'`);
    expect(idx.rowCount).toBe(1);
    const perms = await h.pool.query(`SELECT key FROM permissions WHERE key LIKE 'tasks.%' ORDER BY key`);
    expect(perms.rows.map((r) => r.key)).toEqual(["tasks.manage", "tasks.read"]);
  });

  it("cria, lê, edita e exclui; o histórico guarda só o que mudou", async () => {
    const task = await create("tb-ana", { title: "Revisar contrato", priority: "alta", dueDate: "2026-11-30" });
    expect(task).toMatchObject({
      title: "Revisar contrato",
      status: "a_fazer",
      priority: "alta",
      dueDate: "2026-11-30",
      origin: "manual",
      assignee: { kind: "self", name: null },
      externalRef: null,
      project: null,
      meeting: null,
    });
    const got = await h.call("tb-ana", "GET", `/tasks/${task.id}`);
    expect(got.json.id).toBe(task.id);

    const edited = await h.call("tb-ana", "PATCH", `/tasks/${task.id}`, { dueDate: "2026-12-05", priority: "alta", description: "Ver cláusula 4" });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ dueDate: "2026-12-05", description: "Ver cláusula 4" });

    const history = (await h.call("tb-ana", "GET", `/tasks/${task.id}/history`)).json.history;
    expect(history.map((e: Json) => e.action)).toEqual(["created", "edited"]);
    expect(history[1].before).toEqual({ dueDate: "2026-11-30", description: "" });
    expect(history[1].after).toEqual({ dueDate: "2026-12-05", description: "Ver cláusula 4" });
    expect(history[1].actor.name).toBe("Ana Lima");

    expect((await h.call("tb-ana", "DELETE", `/tasks/${task.id}`)).status).toBe(204);
    expect((await h.call("tb-ana", "GET", `/tasks/${task.id}`)).status).toBe(404);
    const orphan = await h.pool.query(`SELECT 1 FROM task_history WHERE task_id = $1`, [task.id]);
    expect(orphan.rowCount).toBe(0);
  });

  it("PATCH sem mudança real responde 200 e não grava histórico nem mexe em updated_at", async () => {
    const task = await create("tb-ana", { title: "Sem mudança", priority: "baixa" });
    const noop = await h.call("tb-ana", "PATCH", `/tasks/${task.id}`, { title: "Sem mudança", priority: "baixa" });
    expect(noop.status).toBe(200);
    expect(noop.json.updatedAt).toBe(task.updatedAt);
    const history = (await h.call("tb-ana", "GET", `/tasks/${task.id}/history`)).json.history;
    expect(history.map((e: Json) => e.action)).toEqual(["created"]);
  });

  it("concluir define completedAt; reabrir ou cancelar limpa", async () => {
    const task = await create("tb-ana", { title: "Ciclo de status" });
    const done = await h.call("tb-ana", "POST", `/tasks/${task.id}/status`, { status: "concluida" });
    expect(done.json.status).toBe("concluida");
    expect(done.json.completedAt).not.toBeNull();
    const reopened = await h.call("tb-ana", "POST", `/tasks/${task.id}/status`, { status: "a_fazer" });
    expect(reopened.json).toMatchObject({ status: "a_fazer", completedAt: null });
    await h.call("tb-ana", "POST", `/tasks/${task.id}/status`, { status: "concluida" });
    const cancelled = await h.call("tb-ana", "PATCH", `/tasks/${task.id}`, { status: "cancelada" });
    expect(cancelled.json).toMatchObject({ status: "cancelada", completedAt: null });
    const history = (await h.call("tb-ana", "GET", `/tasks/${task.id}/history`)).json.history;
    expect(history.filter((e: Json) => e.action === "status_changed")).toHaveLength(4);
    expect((await h.call("tb-ana", "POST", `/tasks/${task.id}/status`, { status: "pronta" })).status).toBe(400);
  });

  it("criar já concluída grava completedAt (a CHECK do banco exige)", async () => {
    const task = await create("tb-ana", { title: "Já feita", status: "concluida" });
    expect(task.completedAt).not.toBeNull();
  });

  it("recusa externalRef, origin e demais campos de leitura em POST e PATCH", async () => {
    for (const field of ["externalRef", "origin", "source", "completedAt", "overdue", "ownerId"]) {
      const post = await h.call("tb-ana", "POST", "/tasks", { title: "Campo proibido", [field]: "x" });
      expect(post.status, field).toBe(400);
    }
    const task = await create("tb-ana", { title: "Alvo do patch" });
    const patch = await h.call("tb-ana", "PATCH", `/tasks/${task.id}`, { externalRef: { system: "azure", id: "1" } });
    expect(patch.status).toBe(400);
    expect((await h.call("tb-ana", "PATCH", `/tasks/${task.id}`, {})).status).toBe(400);
  });

  it("projeto inexistente → 404; título curto → 400", async () => {
    expect((await h.call("tb-ana", "POST", "/tasks", { title: "Com projeto", projectId: ZERO_UUID })).status).toBe(404);
    expect((await h.call("tb-ana", "POST", "/tasks", { title: "ab" })).status).toBe(400);
  });

  it("ninguém além do dono acessa a tarefa: 404 em todas as rotas de :taskId", async () => {
    const task = await create("tb-ana", { title: "Tarefa privada da Ana" });
    const routes: [string, string, Json?][] = [
      ["GET", `/tasks/${task.id}`],
      ["PATCH", `/tasks/${task.id}`, { title: "Invadida" }],
      ["POST", `/tasks/${task.id}/status`, { status: "concluida" }],
      ["GET", `/tasks/${task.id}/history`],
      ["DELETE", `/tasks/${task.id}`],
    ];
    for (const who of ["tb-bia", "tb-admin", "tb-super"]) {
      for (const [method, url, body] of routes) {
        const res = await h.call(who, method, url, body);
        expect(res.status, `${who} ${method} ${url}`).toBe(404);
        expect(res.json).toEqual({ error: "Tarefa não encontrada." });
      }
      const list = await h.call(who, "GET", "/tasks?status=all");
      expect(list.json.tasks.map((t: Json) => t.id)).not.toContain(task.id);
    }
    // o leitor não tem tasks.*: 403 antes de qualquer consulta
    for (const [method, url, body] of routes) {
      expect((await h.call("tb-leo", method, url, body)).status, `leo ${method} ${url}`).toBe(403);
    }
    expect((await h.call("tb-leo", "GET", "/tasks")).status).toBe(403);
    expect((await h.call("tb-leo", "POST", "/tasks", { title: "Leitor cria" })).status).toBe(403);
    // intacta para a dona
    expect((await h.call("tb-ana", "GET", `/tasks/${task.id}`)).json.title).toBe("Tarefa privada da Ana");
  });

  it("id inválido ou inexistente → 404; sem sessão → 401", async () => {
    expect((await h.call("tb-ana", "GET", "/tasks/nao-e-uuid")).status).toBe(404);
    expect((await h.call("tb-ana", "GET", `/tasks/${ZERO_UUID}`)).status).toBe(404);
    expect((await h.call("tb-ana", "GET", "/tasks/from-item")).status).toBe(404);
    expect((await h.call(null, "GET", "/tasks")).status).toBe(401);
  });

  it("filtro inválido → 400 com o nome do parâmetro", async () => {
    const res = await h.call("tb-ana", "GET", "/tasks?due=ontem");
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Filtro inválido: due.");
    expect((await h.call("tb-ana", "GET", "/tasks?limit=500")).json.error).toBe("Filtro inválido: limit.");
  });
});
