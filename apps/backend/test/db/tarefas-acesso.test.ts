import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, Json } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("tarefas e compartilhamento: isolamento por dono (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;

  const fromItem = (who: string, itemId: string) => h.call(who, "POST", "/tasks/from-item", { itemId });
  const ids = async (who: string, query = "?status=all") =>
    ((await h.call(who, "GET", `/tasks${query}`)).json.tasks as Json[]).map((t) => t.id);

  async function sharedMeeting(): Promise<{ meetingId: string; itemId: string }> {
    const meetingId = await h.seedMeeting("ta-ana", { title: "Reunião compartilhada" });
    const itemId = await h.seedItem(meetingId, { description: "Montar o plano de migração do banco", owner: "Ana Lima", status: "aprovado", quote: "eu monto o plano" });
    return { meetingId, itemId };
  }

  beforeAll(async () => {
    h = await startHarness([
      ["ta-ana", "USER", "Ana Lima"],
      ["ta-bia", "USER", "Bia Souza"],
      ["ta-edu", "USER", "Edu Rocha"],
      ["ta-admin", "ADMIN", "Admin Geral"],
      ["ta-super", "SUPER_ADMIN", null],
      ["ta-leo", "VIEWER", "Leo Viana"],
    ]);
  });

  afterAll(async () => {
    await h.stop();
  });

  it("destinatário com leitura vira tarefa um item da reunião e só ele a vê", async () => {
    const { meetingId, itemId } = await sharedMeeting();
    await h.share(meetingId, "ta-bia", "read");
    const res = await fromItem("ta-bia", itemId);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const taskId = res.json.task.id;
    expect(res.json.task).toMatchObject({ meeting: { id: meetingId }, sourceItem: { id: itemId } });
    expect(await ids("ta-bia")).toContain(taskId);

    const owner = await h.call("ta-ana", "GET", `/tasks/${taskId}`);
    expect(owner.status).toBe(404);
    expect(await ids("ta-ana")).not.toContain(taskId);
    for (const who of ["ta-admin", "ta-super"]) {
      expect((await h.call(who, "GET", `/tasks/${taskId}`)).status, who).toBe(404);
      expect((await h.call(who, "PATCH", `/tasks/${taskId}`, { title: "Invadida" })).status, who).toBe(404);
      expect(await ids(who)).not.toContain(taskId);
    }
    expect((await h.call("ta-ana", "GET", `/meetings/${meetingId}/tasks`)).json.tasks).toEqual([]);
  });

  it("destinatário com edição cria a própria tarefa; dono e ele têm tarefas distintas do mesmo item", async () => {
    const { meetingId, itemId } = await sharedMeeting();
    await h.share(meetingId, "ta-edu", "edit");
    const mine = await fromItem("ta-ana", itemId);
    const his = await fromItem("ta-edu", itemId);
    expect(mine.status).toBe(201);
    expect(his.status).toBe(201);
    expect(mine.json.task.id).not.toBe(his.json.task.id);
    const rows = await h.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE source_item_id = $1`, [itemId]);
    expect(rows.rows[0].n).toBe(2);
  });

  it("destinatário com edição que aprova uma pendência dele cria a tarefa dele, não a do dono", async () => {
    const meetingId = await h.seedMeeting("ta-ana");
    await h.share(meetingId, "ta-edu", "edit");
    const itemId = await h.seedItem(meetingId, { description: "Revisar o modelo de dados do módulo novo", owner: "Edu Rocha" });
    const res = await h.call("ta-edu", "POST", `/items/${itemId}/approve`);
    expect(res.json.task).not.toBeNull();
    const row = await h.pool.query(`SELECT owner_id FROM tasks WHERE id = $1`, [res.json.task.id]);
    expect(row.rows[0].owner_id).toBe(h.ids["ta-edu"]);
    expect((await h.call("ta-ana", "GET", `/tasks/${res.json.task.id}`)).status).toBe(404);
  });

  it("quem tem meetings.read_all não ganha acesso a tarefas alheias", async () => {
    const { meetingId, itemId } = await sharedMeeting();
    await h.share(meetingId, "ta-bia", "read");
    const task = (await fromItem("ta-bia", itemId)).json.task;
    await h.pool.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT id, 'meetings.read_all' FROM roles WHERE key = 'ADMIN' ON CONFLICT DO NOTHING`);
    try {
      // o administrador agora lê a reunião, mas a tarefa de Bia continua invisível
      expect((await h.call("ta-admin", "GET", `/meetings/${meetingId}`)).status).toBe(200);
      expect((await h.call("ta-admin", "GET", `/tasks/${task.id}`)).status).toBe(404);
      expect(await ids("ta-admin")).not.toContain(task.id);
      expect((await h.call("ta-admin", "GET", "/tasks/summary")).json.counts.open).toBe(0);
    } finally {
      await h.pool.query(`DELETE FROM role_permissions WHERE permission_key = 'meetings.read_all' AND role_id = (SELECT id FROM roles WHERE key = 'ADMIN')`);
    }
  });

  it("sem acesso à reunião, POST /tasks/from-item dá 404 e nada é criado", async () => {
    const { itemId } = await sharedMeeting();
    expect((await fromItem("ta-bia", itemId)).status).toBe(404);
    expect((await fromItem("ta-admin", itemId)).status).toBe(404);
    const rows = await h.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE source_item_id = $1`, [itemId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("leitor (VIEWER) com a reunião compartilhada não vê nem cria tarefas", async () => {
    const { meetingId, itemId } = await sharedMeeting();
    await h.share(meetingId, "ta-leo", "read");
    expect((await fromItem("ta-leo", itemId)).status).toBe(403);
    expect((await h.call("ta-leo", "GET", "/tasks")).status).toBe(403);
    expect((await h.call("ta-leo", "GET", "/tasks/summary")).status).toBe(403);
    expect((await h.call("ta-leo", "POST", "/tasks", { title: "Leitor cria" })).status).toBe(403);
    expect((await h.call("ta-leo", "GET", `/meetings/${meetingId}/tasks`)).status).toBe(403);
    // a sessão do leitor não traz as permissões novas (o frontend esconde o menu)
    const me = await h.call("ta-leo", "GET", "/auth/me");
    expect(me.json.permissions).not.toContain("tasks.read");
    expect((await h.call("ta-bia", "GET", "/auth/me")).json.permissions).toEqual(expect.arrayContaining(["tasks.read", "tasks.manage"]));
  });

  it("revogar o compartilhamento mantém a tarefa, sem o vínculo, com o instantâneo (Q4 = A)", async () => {
    const { meetingId, itemId } = await sharedMeeting();
    await h.share(meetingId, "ta-bia", "read");
    const task = (await fromItem("ta-bia", itemId)).json.task;
    await h.pool.query(`DELETE FROM meeting_shares WHERE meeting_id = $1 AND user_id = $2`, [meetingId, h.ids["ta-bia"]]);

    const after = (await h.call("ta-bia", "GET", `/tasks/${task.id}`)).json;
    expect(after.meeting).toBeNull();
    expect(after.sourceItem).toBeNull();
    expect(after.title).toBe(task.title);
    expect(after.description).toBe(task.description);
    expect(after.source).toMatchObject({ meetingTitle: "Reunião compartilhada", quote: "eu monto o plano", itemType: "pendencia" });
    expect(await ids("ta-bia")).toContain(task.id);
    // ainda é editável e concluível pela dona da cópia
    expect((await h.call("ta-bia", "POST", `/tasks/${task.id}/status`, { status: "concluida" })).status).toBe(200);
    // mas a reunião deixou de ser dela
    expect((await h.call("ta-bia", "GET", `/meetings/${meetingId}/tasks`)).status).toBe(404);
    expect((await fromItem("ta-bia", itemId)).status).toBe(404);
  });

  it("na lista, tarefas de reunião sem acesso não trazem título nem link, e as com acesso trazem", async () => {
    const a = await sharedMeeting();
    const b = await sharedMeeting();
    await h.share(a.meetingId, "ta-edu", "read");
    await h.share(b.meetingId, "ta-edu", "read");
    const kept = (await fromItem("ta-edu", a.itemId)).json.task;
    const lost = (await fromItem("ta-edu", b.itemId)).json.task;
    await h.pool.query(`DELETE FROM meeting_shares WHERE meeting_id = $1`, [b.meetingId]);
    const list = (await h.call("ta-edu", "GET", "/tasks?status=all")).json.tasks as Json[];
    expect(list.find((t) => t.id === kept.id).meeting).toMatchObject({ id: a.meetingId });
    expect(list.find((t) => t.id === lost.id).meeting).toBeNull();
  });

  it("o resumo (/tasks/summary) só conta as tarefas do próprio usuário", async () => {
    const { meetingId, itemId } = await sharedMeeting();
    await h.share(meetingId, "ta-bia", "read");
    await fromItem("ta-bia", itemId);
    for (const who of ["ta-bia", "ta-edu", "ta-ana", "ta-admin", "ta-super"]) {
      const own = await h.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1 AND status IN ('a_fazer', 'em_andamento', 'bloqueada')`, [h.ids[who]]);
      const summary = (await h.call(who, "GET", "/tasks/summary")).json;
      expect(summary.counts.open, who).toBe(own.rows[0].n);
    }
    expect((await h.call("ta-super", "GET", "/tasks/summary")).json.counts.open).toBe(0);
  });
});
