import { expect, test } from "@playwright/test";
import { ANA, countTasks, dayFromNow, login } from "./tarefas-helpers";

// US3 (specs/002, quickstart S9): criar tarefa manual, editar o prazo, ver o histórico e excluir.
test.describe.serial("tarefas: manual, edição e histórico", () => {
  test("criar, editar o prazo, conferir o histórico e excluir", async ({ page }) => {
    const stamp = `${Date.now()}`;
    const title = `Revisar contrato ${stamp}`;
    await login(page, ANA);
    await page.goto(`/pendencias?q=${stamp}`);
    await page.getByRole("button", { name: "Nova tarefa" }).first().click();

    const dialog = page.getByRole("dialog", { name: "Nova tarefa" });
    await dialog.getByLabel("Título").fill(title);
    await dialog.getByLabel("Descrição").fill("Ver a cláusula de SLA");
    await dialog.getByLabel("Prioridade").selectOption({ label: "Alta" });
    await dialog.getByLabel("Prazo").fill(dayFromNow(4));
    await dialog.getByLabel("Projeto").selectOption({ label: "Portal SES" });
    await dialog.getByRole("button", { name: "Criar tarefa" }).click();
    const row = page.getByRole("button", { name: title, exact: true });
    await expect(row).toBeVisible();
    expect(await countTasks("e2e-ana", title)).toBe(1);

    // editar o prazo grava histórico com antes e depois
    await row.click();
    const edit = page.getByRole("dialog", { name: "Editar tarefa" });
    await expect(edit.getByLabel("Título")).toHaveValue(title);
    await edit.getByLabel("Prazo").fill(dayFromNow(9));
    await edit.getByRole("button", { name: "Salvar" }).click();
    await expect(edit).toBeHidden();

    await row.click();
    const again = page.getByRole("dialog", { name: "Editar tarefa" });
    await expect(again.getByText("Prazo").first()).toBeVisible();
    await expect(again.getByText("Criada")).toBeVisible();
    await expect(again.getByText("Editada")).toBeVisible();

    // título curto demais: o erro aparece no próprio diálogo e nada é salvo
    await again.getByLabel("Título").fill("ab");
    await again.getByRole("button", { name: "Salvar" }).click();
    await expect(again).toBeVisible();
    await again.getByRole("button", { name: "Cancelar" }).click();

    // excluir pede confirmação e remove da lista
    await row.click();
    await page.getByRole("dialog", { name: "Editar tarefa" }).getByRole("button", { name: "Excluir" }).click();
    await page.getByRole("button", { name: "Sim, excluir" }).click();
    await expect(row).toHaveCount(0);
    expect(await countTasks("e2e-ana", title)).toBe(0);
  });
});
