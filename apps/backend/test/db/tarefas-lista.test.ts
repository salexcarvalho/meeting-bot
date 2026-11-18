import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, dayInZone } from "../../src/tasks/derive";
import type { Harness, Json } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("lista de tarefas: filtros, contadores e fuso (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;
  const SP = "America/Sao_Paulo";
  const EAST = "Pacific/Kiritimati";
  const WEST = "Pacific/Pago_Pago";
  const today = (zone: string) => dayInZone(new Date(), zone);

  interface Seed {
    title: string;
    status?: string;
    priority?: string;
    due?: string | null;
    assignee?: "self" | "other" | "none";
    name?: string | null;
    project?: string | null;
    description?: string;
  }

  async function seed(who: string, s: Seed): Promise<string> {
    const assignee = s.assignee ?? "self";
    const status = s.status ?? "a_fazer";
    const { rows } = await h.pool.query(
      `INSERT INTO tasks (owner_id, title, description, status, priority, due_date, assignee_kind, assignee_name, project_id, origin, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', CASE WHEN $4::text = 'concluida' THEN now() END) RETURNING id`,
      [h.ids[who], s.title, s.description ?? "", status, s.priority ?? "media", s.due ?? null, assignee, assignee === "other" ? (s.name ?? "Fulano") : null, s.project ?? null],
    );
    return rows[0].id;
  }

  const list = async (who: string, query = "") => {
    const res = await h.call(who, "GET", `/tasks${query}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as { tasks: Json[]; total: number; counts: Json };
  };
  const titles = (r: { tasks: Json[] }) => r.tasks.map((t) => t.title);

  beforeAll(async () => {
    h = await startHarness([
      ["tl-ana", "USER", "Ana Lima"],
      ["tl-leste", "USER", null],
      ["tl-oeste", "USER", null],
      ["tl-bia", "USER", "Bia Souza"],
    ]);
    await h.pool.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [h.ids["tl-leste"], EAST]);
    await h.pool.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [h.ids["tl-oeste"], WEST]);
  });

  afterAll(async () => {
    await h.stop();
  });

  describe("filtros e ordenação", () => {
    let portal = "";
    let farmacia = "";

    beforeAll(async () => {
      portal = await h.projectId("Portal SES");
      farmacia = await h.projectId("Farmácia Digital");
      const t = today(SP);
      await seed("tl-ana", { title: "Atrasada do portal", due: addDays(t, -3), project: portal, priority: "alta" });
      await seed("tl-ana", { title: "Atrasada da farmácia", due: addDays(t, -1), project: farmacia });
      await seed("tl-ana", { title: "Vence hoje", due: t, priority: "urgente", project: portal });
      await seed("tl-ana", { title: "Mês que vem", due: addDays(t, 40), priority: "baixa" });
      await seed("tl-ana", { title: "Sem prazo", priority: "alta", assignee: "none" });
      await seed("tl-ana", { title: "Bloqueada de outro", status: "bloqueada", due: addDays(t, 2), assignee: "other", name: "João Pereira" });
      await seed("tl-ana", { title: "Concluída antiga", status: "concluida", due: addDays(t, -10) });
      await seed("tl-ana", { title: "Cancelada", status: "cancelada" });
      await seed("tl-ana", { title: "Revisão de ação e orçamento", description: "Incluir a previsão de março", due: addDays(t, 5) });
    });

    it("padrão: só abertas, por prazo (sem prazo no fim) e depois prioridade", async () => {
      const r = await list("tl-ana");
      expect(titles(r)).toEqual([
        "Atrasada do portal",
        "Atrasada da farmácia",
        "Vence hoje",
        "Bloqueada de outro",
        "Revisão de ação e orçamento",
        "Mês que vem",
        "Sem prazo",
      ]);
      expect(r.total).toBe(7);
      expect(r.tasks[0]).toMatchObject({ overdue: true, project: { name: "Portal SES" } });
      expect(r.tasks.find((x) => x.title === "Vence hoje")).toMatchObject({ overdue: false });
    });

    it("status: lista, all e concluídas não aparecem como atrasadas", async () => {
      expect(titles(await list("tl-ana", "?status=concluida,cancelada")).sort((a, b) => a.localeCompare(b))).toEqual(["Cancelada", "Concluída antiga"]);
      expect((await list("tl-ana", "?status=all")).total).toBe(9);
      const done = (await list("tl-ana", "?status=concluida")).tasks[0];
      expect(done.overdue).toBe(false);
    });

    it("atrasadas + projeto; projeto none; hoje; sem prazo; semana; mês", async () => {
      expect(titles(await list("tl-ana", `?due=overdue&projectId=${portal}`))).toEqual(["Atrasada do portal"]);
      expect(titles(await list("tl-ana", "?due=overdue"))).toEqual(["Atrasada do portal", "Atrasada da farmácia"]);
      expect(titles(await list("tl-ana", "?projectId=none&status=all")).length).toBe(6);
      expect(titles(await list("tl-ana", "?due=today"))).toEqual(["Vence hoje"]);
      expect(titles(await list("tl-ana", "?due=none"))).toEqual(["Sem prazo"]);
      const week = titles(await list("tl-ana", "?due=week"));
      expect(week).toContain("Vence hoje");
      expect(week).not.toContain("Mês que vem");
      expect(week).not.toContain("Atrasada do portal");
      const month = titles(await list("tl-ana", "?due=month"));
      expect(month).not.toContain("Mês que vem");
    });

    it("intervalo de datas", async () => {
      const t = today(SP);
      const r = await list("tl-ana", `?due=range&dueFrom=${addDays(t, -2)}&dueTo=${addDays(t, 2)}`);
      expect(titles(r)).toEqual(["Atrasada da farmácia", "Vence hoje", "Bloqueada de outro"]);
    });

    it("responsável: eu, não confirmado, outra pessoa (com nome)", async () => {
      expect(titles(await list("tl-ana", "?assignee=none"))).toEqual(["Sem prazo"]);
      expect(titles(await list("tl-ana", "?assignee=other"))).toEqual(["Bloqueada de outro"]);
      expect(titles(await list("tl-ana", "?assignee=other&assigneeName=JOAO"))).toEqual(["Bloqueada de outro"]);
      expect(titles(await list("tl-ana", "?assignee=other&assigneeName=maria"))).toEqual([]);
      expect((await list("tl-ana", "?assignee=me&status=all")).total).toBe(7);
    });

    it("prioridade (lista), busca sem acento e sem maiúsculas em título e descrição", async () => {
      expect(titles(await list("tl-ana", "?priority=alta,urgente&sort=priority"))).toEqual(["Vence hoje", "Atrasada do portal", "Sem prazo"]);
      expect(titles(await list("tl-ana", "?q=ACAO"))).toEqual(["Revisão de ação e orçamento"]);
      expect(titles(await list("tl-ana", "?q=previsao%20de%20marco"))).toEqual(["Revisão de ação e orçamento"]);
      expect(titles(await list("tl-ana", "?q=100%25"))).toEqual([]);
    });

    it("paginação com total e contadores que ignoram os filtros", async () => {
      const page = await list("tl-ana", "?limit=3&offset=0");
      expect(page.tasks).toHaveLength(3);
      expect(page.total).toBe(7);
      const next = await list("tl-ana", "?limit=3&offset=3");
      expect(titles(next)).toEqual(["Bloqueada de outro", "Revisão de ação e orçamento", "Mês que vem"]);
      const filtered = await list("tl-ana", "?due=today");
      expect(filtered.total).toBe(1);
      expect(filtered.counts).toMatchObject({
        open: 7,
        overdue: 2,
        dueToday: 1,
        unconfirmedAssignee: 1,
        byStatus: { a_fazer: 6, em_andamento: 0, bloqueada: 1, concluida: 1, cancelada: 1 },
      });
    });

    it("reunião inexistente no filtro devolve lista vazia, não vaza nada", async () => {
      expect((await list("tl-ana", "?meetingId=00000000-0000-4000-8000-000000000000")).total).toBe(0);
    });

    it("outro usuário não vê nada disso", async () => {
      const r = await list("tl-bia", "?status=all");
      expect(r.total).toBe(0);
      expect(r.counts.open).toBe(0);
    });
  });

  describe("fuso do usuário", () => {
    it("'hoje' e 'atrasada' são datas civis no fuso de cada usuário", async () => {
      const east = today(EAST);
      const west = today(WEST);
      expect(east).not.toBe(west);
      await seed("tl-leste", { title: "Hoje no leste", due: east });
      await seed("tl-leste", { title: "Ontem no leste", due: addDays(east, -1) });
      await seed("tl-oeste", { title: "Hoje no oeste", due: west });
      await seed("tl-oeste", { title: "Ontem no oeste", due: addDays(west, -1) });
      for (const [who, label] of [["tl-leste", "leste"], ["tl-oeste", "oeste"]] as const) {
        const r = await list(who);
        expect(titles(await list(who, "?due=today"))).toEqual([`Hoje no ${label}`]);
        expect(titles(await list(who, "?due=overdue"))).toEqual([`Ontem no ${label}`]);
        expect(r.counts).toMatchObject({ dueToday: 1, overdue: 1 });
      }
    });
  });

  describe("volume", () => {
    it("500 tarefas respondem a lista filtrada em menos de 1 s", async () => {
      await h.pool.query(
        `INSERT INTO tasks (owner_id, title, description, priority, due_date, origin)
         SELECT $1, 'Tarefa em massa ' || g, 'Descrição ' || g, (ARRAY['baixa','media','alta','urgente'])[1 + g % 4],
                CURRENT_DATE + (g % 60 - 30), 'manual'
           FROM generate_series(1, 500) g`,
        [h.ids["tl-ana"]],
      );
      const started = performance.now();
      const r = await list("tl-ana", "?status=open&due=overdue&priority=alta,urgente&q=massa&limit=100");
      const elapsed = performance.now() - started;
      expect(r.tasks.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(1000);
      const all = await list("tl-ana", "?status=all&limit=200");
      expect(all.total).toBeGreaterThanOrEqual(500);
    });
  });
});
