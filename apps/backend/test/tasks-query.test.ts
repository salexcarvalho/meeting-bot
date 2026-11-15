import { describe, expect, it } from "vitest";
import { TaskQuery } from "@meeting-bot/contracts";
import { buildTaskQuery, TaskFilterError } from "../src/tasks/query";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const MEETING = "33333333-3333-4333-8333-333333333333";
const TZ = "America/Sao_Paulo";

const build = (raw: Record<string, string> = {}) => buildTaskQuery(TaskQuery.parse(raw), OWNER, TZ);

describe("buildTaskQuery", () => {
  it("sempre escopa por dono e fuso, e nunca concatena valores no texto", () => {
    const { list, count } = build({
      q: "contrato; DROP TABLE tasks",
      projectId: PROJECT,
      meetingId: MEETING,
      assignee: "other",
      assigneeName: "João'--",
    });
    for (const q of [list, count]) {
      expect(q.text).toContain("t.owner_id = $1");
      expect(q.values.slice(0, 2)).toEqual([OWNER, TZ]);
    }
    for (const forbidden of ["DROP TABLE", PROJECT, MEETING, "João", "--"]) expect(list.text).not.toContain(forbidden);
    expect(list.values).toContain(PROJECT);
    expect(list.values).toContain(MEETING);
  });

  it("padrão: abertas, ordenação por prazo com 'sem prazo' no fim, 100 por página", () => {
    const { list } = build();
    expect(list.text).toContain("t.status IN ('a_fazer', 'em_andamento', 'bloqueada')");
    expect(list.text).toContain("ORDER BY t.due_date ASC NULLS LAST");
    expect(list.values.slice(-2)).toEqual([100, 0]);
  });

  it("status=all não filtra por status e lista de status vira ANY", () => {
    expect(build({ status: "all" }).count.text).not.toContain("t.status");
    const { list } = build({ status: "concluida,cancelada" });
    expect(list.text).toContain("t.status = ANY(");
    expect(list.values).toContainEqual(["concluida", "cancelada"]);
  });

  it("projeto 'none' e filtros de prazo", () => {
    expect(build({ projectId: "none" }).list.text).toContain("t.project_id IS NULL");
    expect(build({ due: "overdue" }).list.text).toContain("t.due_date < (now() AT TIME ZONE $2)::date");
    expect(build({ due: "today" }).list.text).toContain("t.due_date = (now() AT TIME ZONE $2)::date");
    expect(build({ due: "none" }).list.text).toContain("t.due_date IS NULL");
    expect(build({ due: "week" }).list.text).toContain("isodow");
    expect(build({ due: "month" }).list.text).toContain("date_trunc('month'");
    const range = build({ due: "range", dueFrom: "2026-11-01", dueTo: "2026-11-30" });
    expect(range.list.values).toEqual(expect.arrayContaining(["2026-11-01", "2026-11-30"]));
  });

  it("responsável: eu, não confirmado e outra pessoa com nome", () => {
    expect(build({ assignee: "me" }).list.text).toContain("t.assignee_kind = 'self'");
    expect(build({ assignee: "none" }).list.text).toContain("t.assignee_kind = 'none'");
    const other = build({ assignee: "other", assigneeName: "João" });
    expect(other.list.text).toContain("t.assignee_kind = 'other'");
    expect(other.list.values).toContain("%joao%");
  });

  it("busca sem acento e sem maiúsculas, com curingas escapados", () => {
    const { list } = build({ q: "Ação 100%_" });
    expect(list.values).toContain("%acao 100\\%\\_%");
    expect(list.text).toContain("translate(");
  });

  it("ordenações aceitas", () => {
    expect(build({ sort: "priority" }).list.text).toContain("ORDER BY CASE t.priority");
    expect(build({ sort: "updated" }).list.text).toContain("ORDER BY t.updated_at DESC");
    expect(build({ sort: "created" }).list.text).toContain("ORDER BY t.created_at DESC");
  });

  it("due=range sem datas lança erro de filtro", () => {
    expect(() => buildTaskQuery({ ...TaskQuery.parse({}), due: "range" }, OWNER, TZ)).toThrow(TaskFilterError);
  });
});

describe("TaskQuery (query string)", () => {
  it("coage limit e offset e recusa valores fora da faixa", () => {
    expect(TaskQuery.parse({ limit: "50", offset: "10" })).toMatchObject({ limit: 50, offset: 10 });
    for (const bad of [{ limit: "0" }, { limit: "201" }, { offset: "-1" }, { status: "xyz" }, { due: "ontem" }, { sort: "x" }, { extra: "1" }]) {
      expect(TaskQuery.safeParse(bad).success).toBe(false);
    }
  });

  it("due=range exige dueFrom e dueTo", () => {
    expect(TaskQuery.safeParse({ due: "range" }).success).toBe(false);
    expect(TaskQuery.safeParse({ due: "range", dueFrom: "2026-11-01" }).success).toBe(false);
    expect(TaskQuery.safeParse({ due: "range", dueFrom: "2026-11-01", dueTo: "2026-11-30" }).success).toBe(true);
  });
});
