import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness } from "./tarefas-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// `visibleMeetingsSql` vira TRUE para quem tem meetings.read_all. O parâmetro do usuário não pode ficar sem
// uso na consulta, senão o Postgres a rejeita (500). Aqui toda rota que usa o helper roda com a permissão.
describe.skipIf(!enabled)("visibleMeetingsSql com meetings.read_all (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;
  const grant = `INSERT INTO role_permissions (role_id, permission_key) SELECT id, 'meetings.read_all' FROM roles WHERE key = 'ADMIN' ON CONFLICT DO NOTHING`;
  const revoke = `DELETE FROM role_permissions WHERE permission_key = 'meetings.read_all' AND role_id = (SELECT id FROM roles WHERE key = 'ADMIN')`;

  beforeAll(async () => {
    h = await startHarness([
      ["vr-ana", "USER", "Ana Lima"],
      ["vr-admin", "ADMIN", "Admin Geral"],
    ]);
    await h.pool.query(grant);
  });

  afterAll(async () => {
    await h.pool.query(revoke);
    await h.stop();
  });

  it("projetos (lista e edição) contam as reuniões sem erro de parâmetro", async () => {
    const projectId = await (async () => {
      const { rows } = await h.pool.query(`INSERT INTO projects (name, keywords) VALUES ('Projeto read_all', '{}') RETURNING id`);
      return rows[0].id as string;
    })();
    await h.seedMeeting("vr-ana", { projectId });
    const list = await h.call("vr-admin", "GET", "/projects");
    expect(list.status).toBe(200);
    expect(list.json.projects.find((p: { id: string }) => p.id === projectId).meetingCount).toBe(1);
    const patch = await h.call("vr-admin", "PATCH", `/projects/${projectId}`, { name: "Projeto read_all 2" });
    expect(patch.status).toBe(200);
    expect(patch.json.meetingCount).toBe(1);
  });

  it("lista de reuniões, agenda e consumo de IA respondem 200", async () => {
    await h.seedMeeting("vr-ana", { scheduledStart: new Date("2026-11-12T13:00:00Z") });
    expect((await h.call("vr-admin", "GET", "/meetings")).status).toBe(200);
    expect((await h.call("vr-admin", "GET", "/agenda?date=2026-11-12")).status).toBe(200);
    expect((await h.call("vr-admin", "GET", "/llm/usage")).status).toBe(200);
  });

  it("resumo de tarefas e reunião sem acesso continuam funcionando", async () => {
    expect((await h.call("vr-admin", "GET", "/tasks/summary")).status).toBe(200);
    expect((await h.call("vr-admin", "GET", "/tasks")).status).toBe(200);
  });
});
