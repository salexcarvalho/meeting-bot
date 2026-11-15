import { expect, test } from "@playwright/test";
import { ANA, apiJson, countTasks, login, noHorizontalScroll, seedItem, seedMeeting, shot } from "./tarefas-helpers";

// US1 (specs/002, quickstart S1, S4, S5, S6): aprovar uma pendência vira tarefa, sem duplicar; Virar tarefa nos demais.
test.describe.serial("tarefas: origem na reunião", () => {
  test("aprovar pendência cria uma tarefa; reabrir e aprovar mantém uma só; Virar tarefa num risco @mobile", async ({ page, isMobile }) => {
    const stamp = `${Date.now()}`;
    await login(page, ANA);
    const meetingId = await seedMeeting("e2e-ana", `Origem das tarefas ${stamp}`);
    const pending = await seedItem(meetingId, {
      description: `Enviar o desenho da integração ${stamp} até 30/11`,
      owner: "eu",
      due: "30/11",
      quote: "eu mando o desenho até o dia trinta",
    });
    const risk = await seedItem(meetingId, { type: "risco", description: `Fornecedor pode atrasar a entrega ${stamp}`, status: "aprovado" });
    const proposed = await seedItem(meetingId, { type: "decisao", description: `Decisão ainda proposta ${stamp}` });

    await page.goto(`/reunioes/${meetingId}`);
    await page.getByRole("tab", { name: /^Itens/ }).click();

    // S1: aprovar a pendência cria a tarefa e avisa com um atalho
    const card = page.locator(`#item-${pending}`);
    await card.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Tarefa criada em Minhas pendências" })).toBeVisible();
    const chip = card.getByRole("link", { name: /Tarefa criada/ });
    await expect(chip).toBeVisible();
    expect(await countTasks("e2e-ana", `Enviar o desenho da integração ${stamp}%`)).toBe(1);
    await shot(page, "origem-aprovada");

    // reabrir e aprovar de novo não duplica (a mesma regra vale para "Gerar ata" de novo)
    await card.getByRole("button", { name: "Reabrir" }).click();
    await card.getByRole("button", { name: "Aprovar" }).click();
    await expect(card.getByRole("link", { name: /Tarefa criada/ })).toBeVisible();
    expect(await countTasks("e2e-ana", `Enviar o desenho da integração ${stamp}%`)).toBe(1);

    // S4/S5: um risco aprovado não vira tarefa sozinho; "Virar tarefa" abre o diálogo já preenchido
    const riskCard = page.locator(`#item-${risk}`);
    await expect(riskCard.getByRole("link", { name: /Tarefa criada/ })).toHaveCount(0);
    await riskCard.getByRole("button", { name: "Virar tarefa" }).click();
    const dialog = page.getByRole("dialog", { name: "Virar tarefa" });
    await expect(dialog.getByLabel("Título")).toHaveValue(new RegExp(`Fornecedor pode atrasar a entrega ${stamp}`));
    await dialog.getByRole("button", { name: "Criar tarefa" }).click();
    await expect(riskCard.getByRole("link", { name: /Tarefa criada/ })).toBeVisible();
    expect(await countTasks("e2e-ana", `Fornecedor pode atrasar a entrega ${stamp}%`)).toBe(1);

    // S6: item proposto não tem "Virar tarefa" (só aprovado vira tarefa) e o backend recusa
    await expect(page.locator(`#item-${proposed}`).getByRole("button", { name: "Virar tarefa" })).toHaveCount(0);
    const refused = await apiJson(page, "POST", "/api/tasks/from-item", { itemId: proposed });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("item_not_approved");

    // a seção da reunião lista as duas e o chip leva ao diálogo da tarefa
    await expect(page.getByRole("region", { name: "Tarefas desta reunião" }).getByRole("link")).toHaveCount(2);
    await chip.click();
    await expect(page).toHaveURL(/\/pendencias\?tarefa=/);
    await expect(page.getByRole("dialog", { name: "Editar tarefa" }).getByLabel("Título")).toHaveValue(new RegExp(`Enviar o desenho da integração ${stamp}`));
    await expect(page.getByRole("dialog", { name: "Editar tarefa" })).toContainText("eu mando o desenho até o dia trinta");
    if (isMobile) await noHorizontalScroll(page);
  });

  test("pendência de outra pessoa não vira tarefa sozinha, mas Virar tarefa continua disponível", async ({ page }) => {
    const stamp = `${Date.now()}`;
    await login(page, ANA);
    const meetingId = await seedMeeting("e2e-ana", `Pendência de outra pessoa ${stamp}`);
    const item = await seedItem(meetingId, { description: `Preparar a apresentação do cliente ${stamp}`, owner: "João Pereira" });
    await page.goto(`/reunioes/${meetingId}`);
    await page.getByRole("tab", { name: /^Itens/ }).click();
    const card = page.locator(`#item-${item}`);
    await card.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Esta pendência é de João Pereira" })).toBeVisible();
    expect(await countTasks("e2e-ana", `Preparar a apresentação do cliente ${stamp}%`)).toBe(0);
    await card.getByRole("button", { name: "Virar tarefa" }).click();
    await page.getByRole("dialog", { name: "Virar tarefa" }).getByRole("button", { name: "Criar tarefa" }).click();
    await expect(card.getByRole("link", { name: /Tarefa criada/ })).toBeVisible();
    expect(await countTasks("e2e-ana", `Preparar a apresentação do cliente ${stamp}%`)).toBe(1);
  });
});
