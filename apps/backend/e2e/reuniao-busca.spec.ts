import { expect, test, type Page } from "@playwright/test";
import { ANA, BIA, apiJson, login, noHorizontalScroll, seedItem, seedMeeting, shot, userId, withDb } from "./tarefas-helpers";

// F3 (specs/003-busca-chat, T031): busca em modo texto (o Ollama do E2E está fora do ar) sobre reuniões semeadas no banco.
// Usa os usuários criados por plataforma.spec.ts (Ana, dona; Bia, sem acesso até o compartilhamento).
const STAMP = `${Date.now()}`;
const TITLE = `Reunião da arquitetura ${STAMP}`;
const WORD = "quimerarium";
const KIND_TRANSCRIPT = "Transcrição";

async function seedSegments(meetingId: string): Promise<number[]> {
  const rows = [
    ["Carlos", "Bom dia a todos, vamos começar pela pauta de hoje.", 5],
    ["Marina", `Precisamos decidir o ${WORD} antes da entrega, porque o prazo apertou.`, 62],
    ["Carlos", "Fechado, seguimos assim e revisamos na semana que vem.", 130],
  ] as const;
  return withDb(async (db) => {
    const ids: number[] = [];
    for (const [speaker, text, start] of rows) {
      const { rows: out } = await db.query(
        `INSERT INTO transcript_segments (meeting_id, channel, pass, speaker, text, start_seconds, end_seconds)
         VALUES ($1, 'remote', 'final', $2, $3, $4, $5) RETURNING id`,
        [meetingId, speaker, text, start, start + 10],
      );
      ids.push(Number(out[0].id));
    }
    return ids;
  });
}

async function seedAdr(meetingId: string, itemId: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `INSERT INTO adrs (item_id, meeting_id, title, context, problem, decision, consequences, status)
       VALUES ($1, $2, $3, 'contexto do ADR', 'problema do ADR', $4, 'consequências do ADR', 'proposto')`,
      [itemId, meetingId, `ADR sobre o ${WORD}`, `Adotar o ${WORD} como padrão.`],
    ),
  );
}

async function indexReady(page: Page, meetingId: string): Promise<void> {
  await expect
    .poll(async () => (await apiJson<{ status: string }>(page, "GET", `/api/search/status?meetingId=${meetingId}`)).json?.status, { timeout: 45_000 })
    .toMatch(/text_ready|indexed/);
}

test.describe.serial("busca nas reuniões (modo texto)", () => {
  let meetingId = "";
  let segmentIds: number[] = [];
  let itemId = "";

  test.beforeAll(async () => {
    meetingId = await seedMeeting("e2e-ana", TITLE);
    segmentIds = await seedSegments(meetingId);
    itemId = await seedItem(meetingId, { type: "decisao", description: `Decidir o ${WORD} até sexta`, status: "aprovado" });
    const adrItem = await seedItem(meetingId, { type: "adr", description: `Registrar a escolha do ${WORD}`, status: "aprovado" });
    await seedAdr(meetingId, adrItem);
  });

  test("Ana busca por texto, abre o trecho da transcrição no horário e vê item e ADR @mobile", async ({ page }) => {
    await login(page, ANA);
    const queued = await apiJson<{ queued: number }>(page, "POST", "/api/search/reindex", {});
    expect(queued.status).toBe(202);
    await indexReady(page, meetingId);

    await page.goto(`/busca?q=${WORD}&mode=text`);
    await expect(page.getByRole("heading", { name: "Busca" }).first()).toBeVisible();
    const group = page.locator(".search-group", { hasText: TITLE });
    await expect(group).toBeVisible();
    // o que casou vem em <mark>, nunca como HTML cru
    await expect(group.locator("mark").first()).toContainText(WORD);
    await expect(group.getByText(KIND_TRANSCRIPT).first()).toBeVisible();
    await expect(group.getByText("Item").first()).toBeVisible();
    await expect(group.getByText("ADR").first()).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, "busca-resultados");

    // transcrição: link direto ao segmento, que abre destacado
    await group.locator(".search-hit", { hasText: KIND_TRANSCRIPT }).locator("a.search-hit-link").first().click();
    await expect(page).toHaveURL(new RegExp(`/reunioes/${meetingId}\\?.*seg=${segmentIds[1]}`));
    await expect(page.locator(`#seg-${segmentIds[1]}.highlight`)).toBeVisible();
    await shot(page, "busca-trecho");
  });

  test("teclado: Ctrl+K leva à busca, Enter envia e o resultado é um link focável", async ({ page }) => {
    await login(page, ANA);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("search").getByLabel("Buscar nas reuniões")).toBeFocused();
    await page.keyboard.type(WORD);
    await page.keyboard.press("Enter");
    await expect(page.locator(".search-group", { hasText: TITLE })).toBeVisible();
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
  });

  test("com o Ollama fora do ar a busca híbrida cai para texto e avisa; Perguntar fica indisponível", async ({ page }) => {
    await login(page, ANA);
    await page.goto(`/busca?q=${WORD}`);
    await expect(page.getByRole("note").filter({ hasText: "busca semântica não está disponível" })).toBeVisible();
    await expect(page.locator(".search-group", { hasText: TITLE })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Perguntar" })).toBeDisabled();
  });

  test("isolamento: Bia não vê a reunião da Ana; compartilhar mostra e revogar tira na hora", async ({ page }) => {
    await login(page, BIA);
    const outside = await apiJson<{ total: number }>(page, "GET", `/api/search?q=${WORD}&mode=text`);
    expect(outside.json.total).toBe(0);
    await page.goto(`/busca?q=${WORD}&mode=text`);
    await expect(page.getByText("Nada encontrado")).toBeVisible();

    const biaId = await userId("e2e-bia");
    await withDb((db) => db.query(`INSERT INTO meeting_shares (meeting_id, user_id, access) VALUES ($1, $2, 'read')`, [meetingId, biaId]));
    await page.reload();
    await expect(page.locator(".search-group", { hasText: TITLE })).toBeVisible();

    await withDb((db) => db.query(`DELETE FROM meeting_shares WHERE meeting_id = $1 AND user_id = $2`, [meetingId, biaId]));
    await page.reload();
    await expect(page.getByText("Nada encontrado")).toBeVisible();
    expect(itemId).not.toBe("");
  });
});
