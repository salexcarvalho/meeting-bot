import { expect, test, type Page } from "@playwright/test";
import { ANA, BIA, apiJson, login, noHorizontalScroll, seedMeeting, shot, userId, withDb } from "./tarefas-helpers";

const ADMIN = { username: "e2e-admin", password: "senha-e2e-admin" };

// F6 (specs/004-uso-custo, quickstart 3 a 5): painel de consumo do usuário, painel de admin e auditoria visível.
// Usa os usuários criados por plataforma.spec.ts (Ana e Bia). O consumo é semeado direto no banco descartável.

async function seedUsage(owner: string, meetingId: string | null, rows: { purpose?: string; provider: string; input?: number; output?: number; cost?: number | null; success?: boolean; error?: string }[]) {
  const ownerId = await userId(owner);
  await withDb(async (db) => {
    for (const r of rows) {
      await db.query(
        `INSERT INTO ai_usage_logs (user_id, meeting_id, category, purpose, provider, model, input_tokens, output_tokens, cost_usd, duration_ms, success, error_code)
         VALUES ($1, $2, 'llm', $3, $4, 'modelo-e2e', $5, $6, $7, 4200, $8, $9)`,
        [ownerId, meetingId, r.purpose ?? "ata", r.provider, r.input ?? null, r.output ?? null, r.cost ?? null, r.success ?? true, r.success === false ? (r.error ?? "other") : null],
      );
    }
  });
}

/** Evento da lista de auditoria (o texto também existe como opção do filtro de tipo). */
function event(page: Page, title: string) {
  return page.locator(".audit-title", { hasText: title }).first();
}

async function kpiValue(page: Page, label: string): Promise<string> {
  const kpi = page.locator(".kpi").filter({ has: page.locator(".kpi-label", { hasText: new RegExp(`^${label}$`) }) });
  return ((await kpi.locator(".kpi-value").textContent()) ?? "").trim();
}

test.describe.serial("uso e custo de IA, painel de admin e auditoria visível", () => {
  const stamp = `${Date.now()}`;
  const TITLE = `Reunião de consumo da Ana ${stamp}`;
  let meetingId = "";

  test.beforeAll(async () => {
    meetingId = await seedMeeting("e2e-ana", TITLE);
    await seedUsage("e2e-ana", meetingId, [
      { purpose: "ata", provider: "openrouter", input: 12_000, output: 1_500, cost: 0.0421 },
      { purpose: "itens", provider: "ollama", input: 4_000, output: 300 },
      { purpose: "ata", provider: "openrouter", success: false, error: "http_402" },
    ]);
    // a reunião da Ana é compartilhada com a Bia: o consumo continua sendo da Ana
    const biaId = await userId("e2e-bia");
    await withDb((db) => db.query(`INSERT INTO meeting_shares (meeting_id, user_id, access) VALUES ($1, $2, 'read')`, [meetingId, biaId]));
  });

  test("Ana vê o próprio consumo: totais batem com a API, falha filtrável, custo nulo sem inventar preço @mobile", async ({ page }) => {
    await login(page, ANA);
    await page.goto("/configuracoes?aba=consumo");
    await expect(page.getByRole("heading", { name: "Consumo de IA" })).toBeVisible();
    const api = await apiJson<{ totals: { calls: number; failedCalls: number } }>(page, "GET", "/api/usage/me");
    expect(api.json.totals.calls).toBeGreaterThanOrEqual(3);
    expect(await kpiValue(page, "Chamadas")).toBe(new Intl.NumberFormat("pt-BR").format(api.json.totals.calls));
    expect(await kpiValue(page, "Custo informado")).toContain("US$");
    await expect(page.getByText("sem custo por chamada").first()).toBeVisible();
    await expect(page.getByRole("link", { name: TITLE }).first()).toBeVisible();
    await shot(page, "uso-usuario");

    // filtro de falhas: só a chamada recusada pelo provedor, com a causa curta e sem texto de reunião
    await page.getByLabel("Só falhas").check();
    await expect(page.getByText("recusada pelo provedor (402)").first()).toBeVisible();
    await expect(page.getByRole("table").last().locator("tbody tr")).toHaveCount(api.json.totals.failedCalls);
    await noHorizontalScroll(page);
  });

  test("mês sem consumo mostra o estado vazio", async ({ page }) => {
    await login(page, ANA);
    await page.goto("/configuracoes?aba=consumo");
    const picker = page.getByRole("combobox", { name: /^Período/ });
    await expect(picker).toBeVisible();
    const options = await picker.locator("option").all();
    // o penúltimo item é o mês mais antigo da lista (o último é "Intervalo livre")
    await picker.selectOption(await options[options.length - 2].getAttribute("value") ?? "");
    await expect(page.getByText("Nenhum consumo neste período")).toBeVisible();
  });

  test("Bia não vê nada da Ana, mesmo com a reunião compartilhada", async ({ page }) => {
    await login(page, BIA);
    await page.goto("/configuracoes?aba=consumo");
    await expect(page.getByRole("heading", { name: "Consumo de IA" })).toBeVisible();
    await expect(page.locator(".kpi").first()).toBeVisible();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    const api = await apiJson<{ topMeetings: { meetingId: string }[] }>(page, "GET", "/api/usage/me");
    expect(api.json.topMeetings.map((m) => m.meetingId)).not.toContain(meetingId);
    expect(JSON.stringify(api.json)).not.toContain(TITLE);
    // a API não aceita escolher outro usuário pela consulta
    const spoof = await apiJson<{ topMeetings: { meetingId: string }[] }>(page, "GET", `/api/usage/me?userId=${await userId("e2e-ana")}`);
    expect(JSON.stringify(spoof.json)).not.toContain(TITLE);
  });

  test("admin vê o uso por usuário, sem títulos nem ids de reunião; usuário comum não vê o menu nem a rota", async ({ page, browser }) => {
    await login(page, ADMIN);
    await page.getByRole("link", { name: "Uso de IA" }).filter({ visible: true }).first().click();
    await expect(page.getByRole("heading", { name: "Uso de IA", level: 1 })).toBeVisible();
    await expect(page.getByText(/conteúdo e títulos de reuniões não aparecem/)).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "e2e-ana" })).toBeVisible();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    const res = await apiJson(page, "GET", "/api/admin/usage");
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.json);
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(meetingId);
    expect(text).not.toMatch(/meetingId|"title"/);
    await shot(page, "uso-admin");

    const anaContext = await browser.newContext();
    const ana = await anaContext.newPage();
    await login(ana, ANA);
    await expect(ana.getByRole("link", { name: "Uso de IA" })).toHaveCount(0);
    await expect(ana.getByRole("link", { name: "Auditoria" })).toHaveCount(0);
    await ana.goto("/admin/uso");
    await expect(ana).not.toHaveURL(/\/admin\/uso/);
    expect((await apiJson(ana, "GET", "/api/admin/usage")).status).toBe(403);
    expect((await apiJson(ana, "GET", "/api/admin/audit")).status).toBe(403);
    await anaContext.close();
  });

  test("entrada recusada e entrada aparecem em Segurança (usuário) e em Auditoria (admin), sem conteúdo", async ({ page, browser }) => {
    const wrong = await page.request.post("/api/auth/login", { data: { username: BIA.username, password: "senha-errada-do-e2e-1" } });
    expect(wrong.status()).toBe(401);
    await login(page, BIA);
    await page.goto("/configuracoes?aba=seguranca");
    await expect(page.getByRole("heading", { name: "Segurança" })).toBeVisible();
    await expect(event(page, "Tentativa de entrada recusada")).toBeVisible();
    await expect(event(page, "Entrada na conta")).toBeVisible();
    await expect(page.getByText(/IP:/).first()).toBeVisible();
    await shot(page, "seguranca-usuario");

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await login(admin, ADMIN);
    await admin.getByRole("link", { name: "Auditoria" }).filter({ visible: true }).first().click();
    await expect(admin.getByRole("heading", { name: "Auditoria", level: 1 })).toBeVisible();
    await expect(event(admin, "Tentativa de entrada recusada")).toBeVisible();
    await expect(admin.getByText(TITLE)).toHaveCount(0);
    await shot(admin, "auditoria-admin");
    const events = await apiJson(admin, "GET", "/api/admin/audit?limit=100");
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.json)).not.toContain(meetingId);
    await adminContext.close();
  });
});
