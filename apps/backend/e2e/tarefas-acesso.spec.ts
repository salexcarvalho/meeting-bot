import { expect, test } from "@playwright/test";
import { ANA, BIA, apiJson, login, seedItem, seedMeeting, userId, withDb } from "./tarefas-helpers";

const ADMIN = { username: "e2e-admin", password: "senha-e2e-admin" };
const LEO = { username: "e2e-leo", password: "senha-do-leo-123" };

// US4 (specs/002, quickstart I1–I4): reunião compartilhada e isolamento entre usuários, com dois contextos.
test.describe.serial("tarefas: compartilhamento e isolamento", () => {
  test("Bia cria tarefa de reunião compartilhada, Ana e o admin não a veem, revogar tira o vínculo", async ({ browser }) => {
    const stamp = `${Date.now()}`;
    const meetingId = await seedMeeting("e2e-ana", `Reunião compartilhada de tarefas ${stamp}`);
    const itemId = await seedItem(meetingId, {
      description: `Montar o plano de migração ${stamp}`,
      owner: "eu",
      status: "aprovado",
      quote: "eu monto o plano de migração",
    });
    const biaId = await userId("e2e-bia");
    await withDb((db) => db.query(`INSERT INTO meeting_shares (meeting_id, user_id, access) VALUES ($1, $2, 'read')`, [meetingId, biaId]));

    const biaContext = await browser.newContext();
    const bia = await biaContext.newPage();
    await login(bia, BIA);
    await bia.goto(`/reunioes/${meetingId}`);
    await bia.getByRole("tab", { name: /^Itens/ }).click();
    await bia.locator(`#item-${itemId}`).getByRole("button", { name: "Virar tarefa" }).click();
    await bia.getByRole("dialog", { name: "Virar tarefa" }).getByRole("button", { name: "Criar tarefa" }).click();
    const chip = bia.locator(`#item-${itemId}`).getByRole("link", { name: /Tarefa criada/ });
    await expect(chip).toBeVisible();
    const href = (await chip.getAttribute("href")) ?? "";
    const taskId = new URL(href, "http://x").searchParams.get("tarefa") ?? "";
    expect(taskId).not.toBe("");

    // I1: Ana (dona da reunião) e o administrador recebem 404 e não a veem em nenhuma lista
    const anaContext = await browser.newContext();
    const ana = await anaContext.newPage();
    await login(ana, ANA);
    expect((await apiJson(ana, "GET", `/api/tasks/${taskId}`)).status).toBe(404);
    const anaList = await apiJson<{ tasks: { id: string }[] }>(ana, "GET", "/api/tasks?status=all&limit=200");
    expect(anaList.json.tasks.map((t) => t.id)).not.toContain(taskId);

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await login(admin, ADMIN);
    expect((await apiJson(admin, "GET", `/api/tasks/${taskId}`)).status).toBe(404);
    expect((await apiJson(admin, "PATCH", `/api/tasks/${taskId}`, { title: "Invadida" })).status).toBe(404);

    // I2: revogar o acesso mantém a tarefa da Bia, sem o link da reunião
    await withDb((db) => db.query(`DELETE FROM meeting_shares WHERE meeting_id = $1 AND user_id = $2`, [meetingId, biaId]));
    await bia.goto(`/pendencias?tarefa=${taskId}`);
    const dialog = bia.getByRole("dialog", { name: "Editar tarefa" });
    await expect(dialog.getByLabel("Título")).toHaveValue(new RegExp(`Montar o plano de migração ${stamp}`));
    await expect(dialog.getByText("Você não tem mais acesso à reunião")).toBeVisible();
    await expect(dialog).toContainText("eu monto o plano de migração");
    await expect(dialog.getByRole("link", { name: /Reunião compartilhada de tarefas/ })).toHaveCount(0);

    await biaContext.close();
    await anaContext.close();
    await adminContext.close();
  });

  test("leitor não vê o menu nem a tela e o backend responde 403 @mobile", async ({ browser }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await login(admin, ADMIN);
    const created = await apiJson(admin, "POST", "/api/admin/users", { username: LEO.username, password: LEO.password, realName: "Leo Viana", role: "VIEWER" });
    expect([201, 409]).toContain(created.status);
    await adminContext.close();

    const context = await browser.newContext();
    const leo = await context.newPage();
    await login(leo, LEO);
    await expect(leo.getByRole("link", { name: "Minhas pendências" })).toHaveCount(0);
    await leo.goto("/pendencias");
    await expect(leo).toHaveURL(/\/$/);
    expect((await apiJson(leo, "GET", "/api/tasks")).status).toBe(403);
    expect((await apiJson(leo, "POST", "/api/tasks", { title: "Leitor cria" })).status).toBe(403);
    await context.close();
  });
});
