import { expect, test } from "@playwright/test";
import { ANA, apiJson, dayFromNow, login, seedItem, seedMeeting, seedTask } from "./tarefas-helpers";

// US5 (specs/002, quickstart S12): cartão "Minhas pendências" na tela Hoje, com links para a lista filtrada.
test.describe.serial("tarefas: resumo na tela Hoje", () => {
  test("o cartão mostra atrasadas, vencem hoje, abertas e propostas a revisar, e os links filtram", async ({ page }) => {
    const stamp = `${Date.now()}`;
    await login(page, ANA);
    const before = (await apiJson<{ counts: { open: number; overdue: number; dueToday: number }; proposalsToReview: number }>(page, "GET", "/api/tasks/summary")).json;

    await seedTask("e2e-ana", { title: `Resumo ${stamp} atrasada 1`, due: dayFromNow(-2) });
    await seedTask("e2e-ana", { title: `Resumo ${stamp} atrasada 2`, due: dayFromNow(-1), status: "em_andamento" });
    await seedTask("e2e-ana", { title: `Resumo ${stamp} hoje`, due: dayFromNow(0) });
    const meetingId = await seedMeeting("e2e-ana", `Resumo de pendências ${stamp}`);
    for (const n of [1, 2, 3]) await seedItem(meetingId, { description: `Pendência proposta ${n} ${stamp}` });

    await page.goto("/");
    const card = page.getByRole("region", { name: "Minhas pendências" });
    await expect(card.getByRole("link", { name: /Atrasadas/ })).toContainText(String(before.counts.overdue + 2));
    await expect(card.getByRole("link", { name: /Vencem hoje/ })).toContainText(String(before.counts.dueToday + 1));
    await expect(card.getByRole("link", { name: /Abertas/ })).toContainText(String(before.counts.open + 3));
    await expect(card.getByRole("link", { name: /Propostas a revisar/ })).toContainText(String(before.proposalsToReview + 3));

    await card.getByRole("link", { name: /Atrasadas/ }).click();
    await expect(page).toHaveURL(/\/pendencias\?prazo=overdue/);
    await expect(page.getByRole("button", { name: `Resumo ${stamp} atrasada 1`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Resumo ${stamp} hoje`, exact: true })).toHaveCount(0);

    await page.goto("/");
    await page.getByRole("region", { name: "Minhas pendências" }).getByRole("link", { name: /Propostas a revisar/ }).click();
    await expect(page).toHaveURL(/\/reunioes/);
  });
});
