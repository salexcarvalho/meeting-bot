import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, dayInZone } from "../../src/tasks/derive";
import type { Harness } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("resumo de tarefas para a tela Hoje (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;
  const today = dayInZone(new Date(), "America/Sao_Paulo");

  const addTask = (who: string, title: string, status: string, due: string | null, assignee = "self") =>
    h.pool.query(
      `INSERT INTO tasks (owner_id, title, status, due_date, assignee_kind, origin, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'manual', CASE WHEN $3::text = 'concluida' THEN now() END)`,
      [h.ids[who], title, status, due, assignee],
    );
  const summary = async (who: string) => (await h.call(who, "GET", "/tasks/summary")).json;

  beforeAll(async () => {
    h = await startHarness([
      ["tr-ana", "USER", "Ana Lima"],
      ["tr-bia", "USER", "Bia Souza"],
      ["tr-leo", "VIEWER", "Leo Viana"],
    ]);
  });

  afterAll(async () => {
    await h.stop();
  });

  it("conta atrasadas, vencem hoje, abertas e sem responsável confirmado", async () => {
    await addTask("tr-ana", "Atrasada 1", "a_fazer", addDays(today, -2));
    await addTask("tr-ana", "Atrasada 2", "em_andamento", addDays(today, -1));
    await addTask("tr-ana", "Hoje", "bloqueada", today);
    await addTask("tr-ana", "Futura", "a_fazer", addDays(today, 9), "none");
    await addTask("tr-ana", "Concluída atrasada", "concluida", addDays(today, -5));
    await addTask("tr-ana", "Cancelada hoje", "cancelada", today);
    const s = await summary("tr-ana");
    expect(s.counts).toMatchObject({
      open: 4,
      overdue: 2,
      dueToday: 1,
      unconfirmedAssignee: 1,
      byStatus: { a_fazer: 2, em_andamento: 1, bloqueada: 1, concluida: 1, cancelada: 1 },
    });
    expect((await summary("tr-bia")).counts).toMatchObject({ open: 0, overdue: 0, dueToday: 0 });
  });

  it("propostas a revisar: só pendência proposta, em reunião visível e com itens ligados", async () => {
    const own = await h.seedMeeting("tr-ana", { extractItems: true });
    await h.seedItem(own, { description: "Pendência proposta 1 da reunião", status: "proposto" });
    await h.seedItem(own, { description: "Pendência proposta 2 da reunião", status: "proposto" });
    await h.seedItem(own, { description: "Pendência já aprovada da reunião", status: "aprovado" });
    await h.seedItem(own, { description: "Pendência rejeitada da reunião", status: "rejeitado" });
    await h.seedItem(own, { type: "risco", description: "Risco proposto que não conta", status: "proposto" });

    const off = await h.seedMeeting("tr-ana", { extractItems: false });
    await h.seedItem(off, { description: "Pendência em reunião sem itens ligados", status: "proposto" });

    const hers = await h.seedMeeting("tr-bia", { extractItems: true });
    await h.seedItem(hers, { description: "Pendência proposta da reunião da Bia", status: "proposto" });

    expect((await summary("tr-ana")).proposalsToReview).toBe(2);
    expect((await summary("tr-bia")).proposalsToReview).toBe(1);

    // compartilhar a reunião da Bia com a Ana passa a contá-la; revogar tira de novo
    await h.share(hers, "tr-ana", "read");
    expect((await summary("tr-ana")).proposalsToReview).toBe(3);
    await h.pool.query(`DELETE FROM meeting_shares WHERE meeting_id = $1`, [hers]);
    expect((await summary("tr-ana")).proposalsToReview).toBe(2);
  });

  it("sem tasks.read → 403", async () => {
    expect((await h.call("tr-leo", "GET", "/tasks/summary")).status).toBe(403);
    expect((await h.call(null, "GET", "/tasks/summary")).status).toBe(401);
  });
});
