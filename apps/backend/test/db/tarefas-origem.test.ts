import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ValidItem } from "../../src/agent/evidence";
import type { Harness, Json } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("tarefas a partir de itens (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  const items = await import("../../src/items/service");
  let h: Harness;

  const fromItem = (who: string, body: Json) => h.call(who, "POST", "/tasks/from-item", body);
  const approve = (who: string, itemId: string) => h.call(who, "POST", `/items/${itemId}/approve`);
  const taskCount = async (who: string, meetingId?: string) =>
    Number(
      (
        await h.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1 AND ($2::uuid IS NULL OR meeting_id = $2)`, [
          h.ids[who],
          meetingId ?? null,
        ])
      ).rows[0].n,
    );

  beforeAll(async () => {
    h = await startHarness([
      ["to-ana", "USER", "Ana Lima"],
      ["to-bia", "USER", "Bia Souza"],
      ["to-leo", "VIEWER", "Leo Viana"],
    ]);
  });

  afterAll(async () => {
    await h.stop();
  });

  describe("Virar tarefa (POST /tasks/from-item)", () => {
    it("item aprovado vira tarefa com título, descrição, prazo, projeto e instantâneo da origem", async () => {
      const project = await h.projectId("Portal SES");
      const meetingId = await h.seedMeeting("to-ana", { title: "Alinhamento Farmácia Digital", projectId: project });
      const itemId = await h.seedItem(meetingId, {
        type: "pendencia",
        description: "Enviar o desenho da integração até 30/11. Validar com o time de arquitetura.",
        owner: "Ana Lima",
        due: "30/11",
        status: "aprovado",
        quote: "eu mando o desenho até o dia trinta",
      });
      const res = await fromItem("to-ana", { itemId });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(res.json.created).toBe(true);
      expect(res.json.task).toMatchObject({
        title: "Enviar o desenho da integração até 30/11",
        description: "Enviar o desenho da integração até 30/11. Validar com o time de arquitetura.",
        dueDate: "2026-11-30",
        dueHint: null,
        status: "a_fazer",
        priority: "media",
        origin: "item_manual",
        assignee: { kind: "self", name: null },
        project: { id: project, name: "Portal SES" },
        meeting: { id: meetingId, title: "Alinhamento Farmácia Digital" },
        sourceItem: { id: itemId, type: "pendencia", reviewStatus: "aprovado" },
      });
      expect(res.json.task.source).toMatchObject({
        meetingTitle: "Alinhamento Farmácia Digital",
        itemType: "pendencia",
        itemDue: "30/11",
        quote: "eu mando o desenho até o dia trinta",
        quoteStart: 1234.5,
        channel: "remote",
      });
      const history = (await h.call("to-ana", "GET", `/tasks/${res.json.task.id}/history`)).json.history;
      expect(history.map((e: Json) => e.action)).toEqual(["created"]);
    });

    it("risco aprovado vira tarefa; prazo que não é data fica como prazo dito; sem responsável = não confirmado", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { type: "risco", description: "Fornecedor pode atrasar a entrega", due: "sexta-feira", status: "aprovado" });
      const res = await fromItem("to-ana", { itemId });
      expect(res.status).toBe(201);
      expect(res.json.task).toMatchObject({ dueDate: null, dueHint: "sexta-feira", assignee: { kind: "none", name: null } });
    });

    it("sobrescritas: título, prazo, prioridade e responsável", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Responder o ofício da secretaria", owner: "Carla", due: "amanhã", status: "aprovado" });
      const res = await fromItem("to-ana", {
        itemId,
        title: "Responder ofício",
        dueDate: "2026-12-10",
        priority: "urgente",
        assignee: { kind: "other", name: "Carla Dias" },
      });
      expect(res.json.task).toMatchObject({ title: "Responder ofício", dueDate: "2026-12-10", dueHint: null, priority: "urgente", assignee: { kind: "other", name: "Carla Dias" } });
    });

    it("item proposto ou rejeitado → 409 item_not_approved e nada é criado", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      for (const status of ["proposto", "rejeitado"] as const) {
        const itemId = await h.seedItem(meetingId, { description: `Item ${status} sem tarefa`, status });
        const res = await fromItem("to-ana", { itemId });
        expect(res.status).toBe(409);
        expect(res.json.code).toBe("item_not_approved");
      }
      expect(await taskCount("to-ana", meetingId)).toBe(0);
    });

    it("criar de novo devolve a mesma tarefa (200); em corrida (Promise.all) gera uma só", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Atualizar o diagrama de componentes", status: "aprovado" });
      const first = await fromItem("to-ana", { itemId });
      const again = await fromItem("to-ana", { itemId });
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ created: false, task: { id: first.json.task.id } });

      const raceItem = await h.seedItem(meetingId, { description: "Configurar o monitoramento de filas", status: "aprovado" });
      const race = await Promise.all([1, 2, 3, 4, 5].map(() => fromItem("to-ana", { itemId: raceItem, force: true })));
      expect(race.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(new Set(race.map((r) => r.json.task.id)).size).toBe(1);
      expect(race.filter((r) => r.status === 201)).toHaveLength(1);
      const rows = await h.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE source_item_id = $1`, [raceItem]);
      expect(rows.rows[0].n).toBe(1);
    });

    it("tarefa parecida na mesma reunião → 409 possible_duplicate; force cria", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const a = await h.seedItem(meetingId, { description: "Enviar o relatório mensal de custos para a diretoria", status: "aprovado" });
      const b = await h.seedItem(meetingId, { description: "Enviar relatório mensal de custos à diretoria", status: "aprovado" });
      const first = await fromItem("to-ana", { itemId: a });
      expect(first.status).toBe(201);
      const dup = await fromItem("to-ana", { itemId: b });
      expect(dup.status).toBe(409);
      expect(dup.json).toMatchObject({ code: "possible_duplicate", taskId: first.json.task.id });
      const forced = await fromItem("to-ana", { itemId: b, force: true });
      expect(forced.status).toBe(201);
      expect(forced.json.task.id).not.toBe(first.json.task.id);
    });

    it("sem acesso à reunião → 404 (não revela o item); leitor sem tasks.manage → 403", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Item da reunião privada da Ana", status: "aprovado" });
      expect((await fromItem("to-bia", { itemId })).status).toBe(404);
      expect((await fromItem("to-leo", { itemId })).status).toBe(403);
      expect((await fromItem("to-ana", { itemId: "nao-uuid" })).status).toBe(400);
      expect((await fromItem("to-ana", { itemId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    });
  });

  describe("aprovar pendência (POST /items/:id/approve)", () => {
    it("pendência do próprio usuário cria a tarefa e a resposta traz task", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Fechar a minuta do contrato", owner: "Ana Lima", due: "até 5/12" });
      const res = await approve("to-ana", itemId);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.reviewStatus).toBe("aprovado");
      expect(res.json.task).toMatchObject({ status: "a_fazer" });
      expect(res.json.taskNotice).toBeUndefined();
      const task = (await h.call("to-ana", "GET", `/tasks/${res.json.task.id}`)).json;
      expect(task).toMatchObject({ origin: "item_auto", dueDate: "2026-12-05", assignee: { kind: "self" } });
    });

    it("pendência sem responsável cria como 'responsável não confirmado'", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Verificar o certificado do servidor", owner: null });
      const res = await approve("to-ana", itemId);
      const task = (await h.call("to-ana", "GET", `/tasks/${res.json.task.id}`)).json;
      expect(task.assignee).toEqual({ kind: "none", name: null });
    });

    it("pendência de outra pessoa não vira tarefa sozinha: taskNotice assignee_other", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Preparar a apresentação para o cliente", owner: "João" });
      const res = await approve("to-ana", itemId);
      expect(res.status).toBe(200);
      expect(res.json.reviewStatus).toBe("aprovado");
      expect(res.json.task).toBeNull();
      expect(res.json.taskNotice).toEqual({ kind: "assignee_other", name: "João" });
      expect(await taskCount("to-ana", meetingId)).toBe(0);
      // mas "Virar tarefa" continua disponível
      const manual = await fromItem("to-ana", { itemId });
      expect(manual.status).toBe(201);
      expect(manual.json.task.assignee).toEqual({ kind: "other", name: "João" });
    });

    it("item de outro tipo aprovado não cria tarefa sozinho", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { type: "risco", description: "Risco de indisponibilidade do banco" });
      const res = await approve("to-ana", itemId);
      expect(res.json.task).toBeNull();
      expect(await taskCount("to-ana", meetingId)).toBe(0);
    });

    it("pendência parecida com tarefa existente não cria: taskNotice possible_duplicate", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const a = await h.seedItem(meetingId, { description: "Contratar a licença do monitoramento de logs", status: "aprovado" });
      const first = await fromItem("to-ana", { itemId: a });
      const b = await h.seedItem(meetingId, { description: "Contratar licença do monitoramento de logs", owner: "Ana Lima" });
      const res = await approve("to-ana", b);
      expect(res.json.task).toBeNull();
      expect(res.json.taskNotice).toEqual({ kind: "possible_duplicate", taskId: first.json.task.id });
    });

    it("aprovar duas vezes: 409 do item e nenhuma tarefa a mais; reabrir e aprovar mantém a mesma tarefa", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Publicar o guia de contribuição", owner: "eu" });
      const first = await approve("to-ana", itemId);
      expect(first.json.task).not.toBeNull();
      expect((await approve("to-ana", itemId)).status).toBe(409);
      expect(await taskCount("to-ana", meetingId)).toBe(1);
      expect((await h.call("to-ana", "POST", `/items/${itemId}/reopen`)).status).toBe(200);
      const again = await approve("to-ana", itemId);
      expect(again.json.task.id).toBe(first.json.task.id);
      expect(await taskCount("to-ana", meetingId)).toBe(1);
      // tarefa excluída: aprovar de novo cria outra
      await h.call("to-ana", "DELETE", `/tasks/${first.json.task.id}`);
      await h.call("to-ana", "POST", `/items/${itemId}/reopen`);
      const third = await approve("to-ana", itemId);
      expect(third.json.task.id).not.toBe(first.json.task.id);
    });

    it("quem não tem tasks.manage recebe a resposta de antes (sem task nem taskNotice)", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Registrar a ata no repositório", owner: "Ana Lima" });
      await h.pool.query(`DELETE FROM role_permissions WHERE permission_key = 'tasks.manage' AND role_id = (SELECT id FROM roles WHERE key = 'USER')`);
      try {
        const res = await approve("to-ana", itemId);
        expect(res.status).toBe(200);
        expect(res.json.reviewStatus).toBe("aprovado");
        expect("task" in res.json).toBe(false);
        expect("taskNotice" in res.json).toBe(false);
        expect(await taskCount("to-ana", meetingId)).toBe(0);
      } finally {
        await h.pool.query(
          `INSERT INTO role_permissions (role_id, permission_key) SELECT id, 'tasks.manage' FROM roles WHERE key = 'USER' ON CONFLICT DO NOTHING`,
        );
      }
    });

    it("falha ao criar a tarefa nunca desfaz a aprovação", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Atualizar a documentação da API", owner: "Ana Lima" });
      await h.pool.query(`ALTER TABLE tasks RENAME TO tasks_off`);
      try {
        const res = await approve("to-ana", itemId);
        expect(res.status).toBe(200);
        expect(res.json.reviewStatus).toBe("aprovado");
        expect(res.json.task).toBeNull();
      } finally {
        await h.pool.query(`ALTER TABLE tasks_off RENAME TO tasks`);
      }
    });
  });

  describe("reprocessamento e exclusão", () => {
    const aiItem = (description: string): ValidItem => ({
      type: "pendencia",
      description,
      owner: null,
      due: null,
      attributes: {},
      evidence: [{ segmentId: null, start: 10, end: 14, channel: "remote", quote: "trecho" }],
    });

    it("10 reprocessamentos (limpar propostas e extrair de novo) não duplicam nem apagam a tarefa (SC-002)", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      const itemId = await h.seedItem(meetingId, { description: "Enviar a proposta comercial revisada ao cliente", owner: "Ana Lima" });
      const approved = await approve("to-ana", itemId);
      expect(approved.json.task).not.toBeNull();
      for (let i = 0; i < 10; i++) {
        await items.clearUnreviewedAiItems(meetingId);
        await items.createAiItems(meetingId, [aiItem("Enviar proposta comercial revisada ao cliente")], "final");
      }
      expect(await taskCount("to-ana", meetingId)).toBe(1);
      const row = await h.pool.query(`SELECT source_item_id FROM tasks WHERE owner_id = $1 AND meeting_id = $2`, [h.ids["to-ana"], meetingId]);
      expect(row.rows[0].source_item_id).toBe(itemId);
      expect((await h.call("to-ana", "GET", `/meetings/${meetingId}/items`)).json.items.map((i: Json) => i.id)).toContain(itemId);
    });

    it("excluir a reunião mantém a tarefa, com meeting e sourceItem nulos e o instantâneo", async () => {
      const meetingId = await h.seedMeeting("to-ana", { title: "Reunião que será excluída" });
      const itemId = await h.seedItem(meetingId, { description: "Alinhar o cronograma com a fábrica", owner: "Ana Lima", quote: "alinho com a fábrica" });
      const approved = await approve("to-ana", itemId);
      const taskId = approved.json.task.id;
      await h.pool.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);
      const task = (await h.call("to-ana", "GET", `/tasks/${taskId}`)).json;
      expect(task.meeting).toBeNull();
      expect(task.sourceItem).toBeNull();
      expect(task.source).toMatchObject({ meetingTitle: "Reunião que será excluída", quote: "alinho com a fábrica" });
    });
  });

  describe("GET /meetings/:id/tasks", () => {
    it("devolve só as tarefas do usuário nessa reunião", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      await h.share(meetingId, "to-bia", "read");
      const itemId = await h.seedItem(meetingId, { description: "Montar o plano de testes de carga", status: "aprovado" });
      await fromItem("to-ana", { itemId });
      await fromItem("to-bia", { itemId });
      const mine = (await h.call("to-ana", "GET", `/meetings/${meetingId}/tasks`)).json.tasks;
      expect(mine).toHaveLength(1);
      const hers = (await h.call("to-bia", "GET", `/meetings/${meetingId}/tasks`)).json.tasks;
      expect(hers).toHaveLength(1);
      expect(hers[0].id).not.toBe(mine[0].id);
    });

    it("sem acesso à reunião → 404; leitor sem tasks.read → 403", async () => {
      const meetingId = await h.seedMeeting("to-ana");
      expect((await h.call("to-bia", "GET", `/meetings/${meetingId}/tasks`)).status).toBe(404);
      await h.share(meetingId, "to-leo", "read");
      expect((await h.call("to-leo", "GET", `/meetings/${meetingId}/tasks`)).status).toBe(403);
    });
  });
});
