import { expect, test } from "@playwright/test";
import { ANA, dayFromNow, login, noHorizontalScroll, seedTask, shot } from "./tarefas-helpers";

// US2 (specs/002, quickstart S7, S8, S11): lista com filtros na URL, contadores e status editável na lista.
test.describe.serial("tarefas: minhas pendências", () => {
  test("filtrar, recarregar mantendo a URL, mudar o status e ver os contadores @mobile", async ({ page, isMobile }) => {
    const stamp = `${Date.now()}`;
    const title = (name: string) => `Lista ${stamp} ${name}`;
    await seedTask("e2e-ana", { title: title("atrasada"), due: dayFromNow(-3), priority: "alta" });
    await seedTask("e2e-ana", { title: title("hoje"), due: dayFromNow(0), priority: "urgente" });
    await seedTask("e2e-ana", { title: title("futura"), due: dayFromNow(5) });
    await seedTask("e2e-ana", { title: title("sem prazo"), assignee: "none" });
    await seedTask("e2e-ana", { title: title("bloqueada"), status: "bloqueada", assignee: "other", name: "João Pereira" });
    await seedTask("e2e-ana", { title: title("concluída"), status: "concluida", due: dayFromNow(-9) });

    await login(page, ANA);
    await page.goto(`/pendencias?q=${stamp}`);
    await expect(page.getByRole("heading", { name: "Minhas pendências", level: 1 })).toBeVisible();
    const row = (name: string) => page.getByRole("button", { name: title(name), exact: true });

    // padrão: só abertas; a concluída não aparece
    for (const name of ["atrasada", "hoje", "futura", "sem prazo", "bloqueada"]) await expect(row(name)).toBeVisible();
    await expect(row("concluída")).toHaveCount(0);
    await shot(page, "lista-padrao");

    // contador Atrasadas filtra e a URL guarda o filtro
    await page.getByRole("button", { name: /Atrasadas/ }).filter({ has: page.locator(".task-counter-label") }).click();
    await expect(page).toHaveURL(/prazo=overdue/);
    await expect(row("atrasada")).toBeVisible();
    await expect(row("hoje")).toHaveCount(0);
    await page.reload();
    await expect(row("atrasada")).toBeVisible();
    await expect(row("futura")).toHaveCount(0);

    // sem responsável confirmado
    await page.getByRole("button", { name: /Sem responsável confirmado/ }).click();
    await expect(page).toHaveURL(/resp=none/);
    await expect(row("sem prazo")).toBeVisible();
    await expect(row("atrasada")).toHaveCount(0);

    // limpar filtros volta ao padrão (a busca é um filtro e também sai: reaplicamos pela URL)
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await page.goto(`/pendencias?q=${stamp}`);
    await expect(row("futura")).toBeVisible();

    // mudar o status na lista salva na hora e tira a tarefa de "Abertas"
    await page.getByLabel(`Status da tarefa ${title("futura")}`).selectOption({ label: "Concluída" });
    await expect(row("futura")).toHaveCount(0);
    await page.getByRole("button", { name: /^Todas/ }).click();
    await expect(row("futura")).toBeVisible();
    await expect(row("concluída")).toBeVisible();
    await expect(page.getByLabel(`Status da tarefa ${title("futura")}`)).toHaveValue("concluida");

    // sem resultado: estado vazio com atalho para remover os filtros
    await page.goto(`/pendencias?q=${stamp}nao-existe`);
    await expect(page.getByText("Nenhuma tarefa com estes filtros")).toBeVisible();
    await page.getByRole("button", { name: "Remover filtros" }).click();
    await expect(page.getByRole("heading", { name: "Minhas pendências", level: 1 })).toBeVisible();

    // valores inválidos na URL nunca quebram a tela
    await page.goto("/pendencias?status=xyz&prazo=ontem&ordem=nada&prioridade=zzz");
    await expect(page.getByRole("heading", { name: "Minhas pendências", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tentar de novo" })).toHaveCount(0);

    if (isMobile) {
      await page.goto(`/pendencias?q=${stamp}`);
      await expect(row("atrasada")).toBeVisible();
      await noHorizontalScroll(page);
      await shot(page, "lista-celular");
    }
  });

  test("o menu leva a Minhas pendências e a Hoje mostra o cartão", async ({ page }) => {
    await login(page, ANA);
    await page.goto("/");
    const card = page.getByRole("region", { name: "Minhas pendências" });
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: /Abertas/ }).click();
    await expect(page).toHaveURL(/\/pendencias/);
    await expect(page.getByRole("heading", { name: "Minhas pendências", level: 1 })).toBeVisible();
  });
});
