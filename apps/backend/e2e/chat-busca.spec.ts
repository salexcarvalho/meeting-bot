import { expect, test } from "@playwright/test";
import { apiJson, login, seedMeeting, shot, withDb } from "./tarefas-helpers";

// F3 (specs/003-busca-chat, T056): chat com citação clicável. Roda só com E2E_FAKE_OLLAMA=1 (scripts/e2e.mjs sobe um Ollama
// de mentira para embeddings e chat): `E2E_FAKE_OLLAMA=1 npm run test:e2e -w @meeting-bot/backend -- chat-busca`.
// O playwright.config.ts ignora este spec sem E2E_FAKE_OLLAMA. Não depende de outros specs: o dono é o administrador criado pelo próprio scripts/e2e.mjs.
const ADMIN = { username: "e2e-admin", password: "senha-e2e-admin" };
const TITLE = `Reunião do chat ${Date.now()}`;
const SENTENCE = "Ficou combinado que o fornecedor de armazenamento entrega o contrato assinado até dia vinte.";

test.describe.serial("chat sobre as reuniões", () => {
  let meetingId = "";
  let segmentId = 0;

  test.beforeAll(async () => {
    meetingId = await seedMeeting("e2e-admin", TITLE);
    segmentId = await withDb(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO transcript_segments (meeting_id, channel, pass, speaker, text, start_seconds, end_seconds)
         VALUES ($1, 'remote', 'final', 'Marina', $2, 95, 105) RETURNING id`,
        [meetingId, SENTENCE],
      );
      return Number(rows[0].id);
    });
  });

  test("pergunta com resposta e citação que abre o horário; pergunta sem resposta; seguimento", async ({ page }) => {
    await login(page, ADMIN);
    const queued = await apiJson(page, "POST", "/api/search/reindex", {});
    expect(queued.status).toBe(202);
    await expect
      .poll(async () => (await apiJson<{ status: string }>(page, "GET", `/api/search/status?meetingId=${meetingId}`)).json?.status, { timeout: 45_000 })
      .toBe("indexed");

    await page.goto("/busca?tab=perguntar");
    await expect(page.getByRole("tab", { name: "Perguntar" })).toBeEnabled();
    const ask = async (question: string) => {
      await page.getByLabel("Sua pergunta").fill(question);
      await page.getByRole("button", { name: "Perguntar", exact: true }).last().click();
    };

    await ask("Quando o fornecedor entrega o contrato assinado?");
    const log = page.getByRole("log", { name: "Conversa" });
    const chip = log.locator("a.citation-chip").first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await shot(page, "chat-resposta");

    // seguimento na mesma conversa (o histórico vai junto)
    await ask("E quem ficou de assinar o contrato?");
    await expect(log.locator("a.citation-chip")).toHaveCount(4, { timeout: 30_000 });

    // sem evidência: "não encontrei", sem citação
    await ask("Qual a cor da zebra do escritório?");
    await expect(log.getByText("Não encontrei registro").first()).toBeVisible({ timeout: 30_000 });

    // a citação abre a reunião no segmento citado
    await chip.click();
    await expect(page).toHaveURL(new RegExp(`/reunioes/${meetingId}\\?.*seg=${segmentId}`));
    await expect(page.locator(`#seg-${segmentId}.highlight`)).toBeVisible();
  });
});
