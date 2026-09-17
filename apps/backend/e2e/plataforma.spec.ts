import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

// Fluxos da fase 1/2 no navegador real, contra o backend real (scripts/e2e.mjs).
const ADMIN = { username: "e2e-admin", password: "senha-e2e-admin" };
const ANA = { username: "e2e-ana", password: "senha-da-ana-123" };
const BIA = { username: "e2e-bia", password: "senha-da-bia-123" };
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// E2E_SHOTS=<pasta> guarda capturas das telas para revisão visual
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}.png`, fullPage: true });
}

async function login(page: Page, user: { username: string; password: string }) {
  await page.goto("/");
  await page.getByLabel("Usuário").fill(user.username);
  await page.getByLabel("Senha").fill(user.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  // desktop mostra a barra lateral; celular, o botão do menu
  const shell = page.getByRole("navigation", { name: "Principal" }).or(page.getByRole("button", { name: "Abrir menu" }));
  await expect(shell.filter({ visible: true }).first()).toBeVisible();
}

async function postJson(page: Page, url: string, body: unknown, method = "POST") {
  return page.evaluate<{ status: number; json: { id: string } }, readonly [string, unknown, string]>(
    async ([u, b, m]) => {
      const res = await fetch(u, { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      return { status: res.status, json: (await res.json()) as { id: string } };
    },
    [url, body, method] as const,
  );
}

// Reunião agendada já concluída com transcrição final: o pipeline real precisaria de GPU.
async function doneMeeting(page: Page, title: string, analysis: object | null = null): Promise<string> {
  const start = new Date(Date.now() - 3600_000).toISOString();
  const created = await postJson(page, "/api/meetings/scheduled", { title, start, durationMinutes: 30 });
  expect(created.status).toBe(201);
  const id = created.json.id;
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      `UPDATE meetings SET status = 'done', analysis = $2, analyzed_at = CASE WHEN $2::jsonb IS NULL THEN NULL ELSE now() END
       WHERE id = $1`,
      [id, analysis],
    );
    await db.query(
      `INSERT INTO transcript_segments (meeting_id, speaker, text, start_seconds, end_seconds, channel, pass)
       VALUES ($1, 'Ana', 'Vamos adotar Kafka entre os serviços.', 0, 5, 'mic', 'final')`,
      [id],
    );
  } finally {
    await db.end();
  }
  return id;
}

async function logout(page: Page) {
  await page.locator("aside.sidebar").getByRole("button", { name: "Sair" }).click();
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
}

async function createUser(page: Page, user: { username: string; password: string }, realName: string) {
  await page.getByRole("button", { name: "Novo usuário" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo usuário" });
  await dialog.getByLabel("Usuário (login)").fill(user.username);
  await dialog.getByLabel("Nome real").fill(realName);
  await dialog.getByLabel("Senha", { exact: true }).fill(user.password);
  await dialog.getByLabel("Confirme a senha").fill(user.password);
  await expect(dialog.getByRole("radio", { name: /Super administrador/ })).toBeEnabled();
  await dialog.getByRole("radio", { name: /^Usuário/ }).check();
  await dialog.getByRole("button", { name: "Criar usuário" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Usuário criado." })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`@${user.username}`) })).toBeVisible();
}

test.describe.serial("plataforma multiusuário", () => {
  let anaMeetingUrl = "";

  test("admin cria usuários pela interface", async ({ page }) => {
    await login(page, ADMIN);
    await page.getByRole("link", { name: "Usuários" }).click();
    await expect(page.getByRole("heading", { name: "Usuários", level: 1 })).toBeVisible();
    await createUser(page, ANA, "Ana Souza");
    await createUser(page, BIA, "Beatriz Lima");
    const anaRow = page.getByRole("row", { name: /@e2e-ana/ });
    await expect(anaRow.getByText("Usuário", { exact: true })).toBeVisible();
    await expect(anaRow.getByText("Ativo")).toBeVisible();
    await shot(page, "admin-usuarios");
    // o próprio admin não tem botão de desativar
    await expect(page.getByRole("button", { name: `Desativar ${ADMIN.username}` })).toHaveCount(0);
    await logout(page);
  });

  test("usuário comum não vê administração e o backend também bloqueia", async ({ page }) => {
    await login(page, ANA);
    await expect(page.getByRole("link", { name: "Usuários" })).toHaveCount(0);
    await page.goto("/admin/usuarios");
    await expect(page).toHaveURL(/\/$/);
    const status = await page.evaluate(async () => (await fetch("/api/admin/users")).status);
    expect(status).toBe(403);
  });

  test("perfil, agente e identidade do assistente persistem", async ({ page }) => {
    await login(page, ANA);
    await page.getByRole("link", { name: "Configurações" }).click();
    await page.getByLabel("Nome de exibição").fill("Ana");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Perfil salvo." })).toBeVisible();
    await expect(page.locator("aside.sidebar .user-box-name")).toHaveText("Ana");

    await page.getByLabel("Sua foto").setInputFiles({ name: "ana.png", mimeType: "image/png", buffer: PNG_1PX });
    await expect(page.getByRole("status").filter({ hasText: "Foto atualizada." })).toBeVisible();
    await expect(page.locator("aside.sidebar .avatar img")).toHaveAttribute("src", /\/api\/me\/avatar\?v=/);

    await page.getByRole("tab", { name: "Meu agente" }).click();
    await expect(page).toHaveURL(/aba=agente/);
    await page.getByLabel("Nome do agente").fill("Orion");
    await page.getByLabel("Papel").fill("Arquiteto de software");
    await page.getByLabel("Tecnologias prioritárias").fill("Kafka, PostgreSQL, Kafka");
    await page.getByRole("checkbox", { name: "Decisão arquitetural" }).check();
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Agente salvo." })).toBeVisible();
    await expect(page.getByLabel("Tecnologias prioritárias")).toHaveValue("Kafka, PostgreSQL");
    await shot(page, "config-agente");

    await page.getByRole("tab", { name: "Reuniões" }).click();
    await page.getByRole("radio", { name: "Nome personalizado" }).check({ force: true });
    await expect(page.getByRole("button", { name: "Salvar" })).toBeEnabled();
    await page.getByRole("textbox", { name: "Nome personalizado" }).fill("Ata <da> Ana");
    await expect(page.getByText("Vai aparecer como")).toContainText("Ata da Ana - assistente gravando");
    await page.getByRole("radio", { name: "Nome do agente" }).check({ force: true });
    await expect(page.getByText("Vai aparecer como")).toContainText("Orion - assistente gravando");
    await expect(page.getByText("Hoje:")).toContainText("Orion - assistente gravando");
    await shot(page, "config-reunioes");

    // recarregar mantém tudo
    await page.reload();
    await page.getByRole("tab", { name: "Meu agente" }).click();
    await expect(page.getByLabel("Nome do agente")).toHaveValue("Orion");
    await expect(page.getByRole("checkbox", { name: "Decisão arquitetural" })).toBeChecked();
  });

  test("reunião própria fica isolada de outro usuário", async ({ page }) => {
    await login(page, ANA);
    await page.getByRole("button", { name: "Nova reunião" }).click();
    const dialog = page.getByRole("dialog", { name: "Nova reunião" });
    await dialog.getByRole("textbox", { name: "Título", exact: true }).fill("Arquitetura privada da Ana");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("link", { name: "Arquitetura privada da Ana" })).toBeVisible();
    await page.getByRole("link", { name: "Arquitetura privada da Ana" }).click();
    await expect(page.getByRole("heading", { name: "Arquitetura privada da Ana" })).toBeVisible();
    anaMeetingUrl = new URL(page.url()).pathname;
    await logout(page);

    await login(page, BIA);
    await expect(page.getByText("Arquitetura privada da Ana")).toHaveCount(0);
    await page.goto("/reunioes");
    await expect(page.getByRole("heading", { name: "Reuniões", level: 1 })).toBeVisible();
    await expect(page.getByText("Arquitetura privada da Ana")).toHaveCount(0);
    await page.goto(anaMeetingUrl);
    await expect(page.getByText("Reunião não encontrada.")).toBeVisible();
  });

  test("enviar assistente: um pedido por clique duplo, identidade visível e erro claro", async ({ page }) => {
    await login(page, ANA);
    await page.getByRole("link", { name: "Reuniões", exact: true }).first().click();
    const form = page.locator("form", { has: page.getByRole("heading", { name: /Modo Agente/ }) });
    await expect(form.getByText("Vai aparecer como")).toContainText("Orion - assistente gravando");
    await form.getByLabel("Link do Google Meet ou Teams").fill("https://meet.google.com/e2e-abcd-efg");
    await form.getByRole("textbox", { name: "Título", exact: true }).fill("Reunião com assistente");

    const posts: number[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/meetings") posts.push(Date.now());
    });
    const button = form.getByRole("button", { name: "Enviar assistente" });
    const clickedAt = Date.now();
    await button.dblclick();
    await expect(page).toHaveURL(/\/reunioes\/[0-9a-f-]{36}$/);
    const navigatedMs = Date.now() - clickedAt;
    expect(posts).toHaveLength(1);
    expect(navigatedMs).toBeLessThan(5000);

    await expect(page.getByRole("heading", { name: "Reunião com assistente" })).toBeVisible();
    await expect(page.getByText("assistente: Orion - assistente gravando")).toBeVisible();
    // Sem PulseAudio no E2E o assistente falha logo na preparação, com mensagem clara.
    await expect(page.getByText(/Erro no bot|pactl/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Enviar assistente de novo" })).toBeVisible();
    await shot(page, "reuniao-bot-erro");
  });

  test("gerar ata e ADR pergunta onde gerar e só envia depois de confirmar", async ({ page }) => {
    await login(page, ANA);
    const id = await doneMeeting(page, "Revisão de arquitetura E2E");
    const item = await postJson(page, `/api/meetings/${id}/items`, { type: "decisao_arquitetural", description: "Adotar Kafka entre os serviços" });
    expect(item.status).toBe(201);

    const generations: unknown[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (req.method() === "POST" && (path.endsWith("/reprocess") || path.endsWith("/adrs/generate"))) {
        generations.push(req.postDataJSON());
      }
    });
    await page.goto(`/reunioes/${id}`);
    await expect(page.getByRole("heading", { name: "Revisão de arquitetura E2E" })).toBeVisible();

    await page.getByRole("tab", { name: "Ata" }).click();
    await page.getByRole("button", { name: "Gerar ata" }).click();
    const ataDialog = page.getByRole("dialog", { name: "Gerar ata" });
    await expect(ataDialog.getByRole("radio", { name: /Modelo local/ })).toBeChecked();
    const claude = ataDialog.getByRole("radio", { name: /Claude \(sua assinatura\)/ });
    await expect(claude).toBeDisabled();
    await expect(ataDialog.getByText(/vale só para as reuniões dele/)).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: /OpenRouter/ })).toHaveCount(0);
    await ataDialog.getByRole("radio", { name: /OpenRouter/ }).check();
    await expect(ataDialog.getByRole("note")).toContainText("OpenRouter");
    await shot(page, "gerar-ata-openrouter");
    await ataDialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(ataDialog).toBeHidden();
    expect(generations).toEqual([]);

    await page.getByRole("tab", { name: "ADRs" }).click();
    await expect(page.getByRole("button", { name: "Gerar ADRs (1)" })).toBeVisible();

    await page.getByRole("tab", { name: /^Itens/ }).click();
    await page.getByRole("button", { name: "Gerar ADR", exact: true }).click();
    const adrDialog = page.getByRole("dialog", { name: "Gerar ADR" });
    await expect(adrDialog.getByRole("radio", { name: /Modelo local/ })).toBeChecked();
    await adrDialog.getByRole("button", { name: "Gerar ADR" }).click();
    await expect(adrDialog).toBeHidden();
    // sem Ollama no E2E a geração falha; o aviso chega pelo WebSocket e não é coberto pelo "Gerando…"
    await expect(page.getByRole("status").filter({ hasText: /Falha no processamento/ })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await expect(page.getByRole("status")).toContainText("Falha no processamento");
    expect(generations).toEqual([{ llm: "local", itemId: item.json.id }]);
    await shot(page, "gerar-adr-falha");
  });

  test("resumo para enviar mostra só o aprovado e copia", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await login(page, ANA);
    const id = await doneMeeting(page, "Planejamento da sprint E2E", {
      objetivo: "Fechar o escopo da sprint.",
      resumo_executivo: "O time fechou o escopo e dividiu as tarefas.",
      assuntos: [],
      observacoes_arquiteto: [],
    });
    // manual nasce aprovado
    expect((await postJson(page, `/api/meetings/${id}/items`, { type: "decisao", description: "Congelar o escopo na quarta" })).status).toBe(201);
    const pendencia = await postJson(page, `/api/meetings/${id}/items`, {
      type: "pendencia",
      description: "Atualizar o quadro",
      owner: "Bia",
      due: "sexta",
    });
    expect(pendencia.status).toBe(201);

    await page.goto(`/reunioes/${id}`);
    await page.getByRole("tab", { name: "Ata" }).click();
    // ata na tela: ficha no topo, índice e seções vazias numa linha só
    const facts = page.locator("dl.ata-facts");
    await expect(facts.getByRole("definition").filter({ hasText: "Ana" })).toBeVisible();
    await expect(facts).toContainText("Duração");
    await expect(page.getByRole("heading", { name: "Decisões 1", level: 3 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Seções da ata" }).getByRole("button", { name: /Pendências/ })).toBeVisible();
    await expect(page.locator(".ata-empty")).toContainText("Riscos");
    await expect(page.getByRole("heading", { name: "Riscos" })).toHaveCount(0);
    await shot(page, "ata");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400); // fim das transições de cor
    await shot(page, "ata-celular-escuro");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "Resumo para enviar" }).click();
    const dialog = page.getByRole("dialog", { name: "Resumo para enviar" });
    const text = dialog.getByRole("textbox", { name: "Texto do resumo" });
    await expect(text).toHaveValue(/^Resumo da reunião: Planejamento da sprint E2E\n/);
    await expect(text).toHaveValue(/Objetivo: Fechar o escopo da sprint\./);
    await expect(text).toHaveValue(/Decisões\n- Congelar o escopo na quarta\n/);
    await expect(text).toHaveValue(/Pendências\n- Atualizar o quadro \(responsável: Bia; prazo: sexta\)/);
    await expect(dialog.getByText("Só entram itens aprovados.")).toBeVisible();
    await shot(page, "resumo-para-enviar");
    await dialog.getByRole("button", { name: "Copiar resumo" }).click();
    await expect(page.getByRole("status")).toContainText("Resumo copiado.");
    const copied: string = await page.evaluate("navigator.clipboard.readText()");
    expect(copied).toContain("Congelar o escopo na quarta");
    await dialog.getByRole("button", { name: "Fechar" }).click();
    await expect(dialog).toBeHidden();
  });

  test("ADRs: filtros, cartões recolhidos, data correta e ida para a decisão", async ({ page }) => {
    await login(page, ANA);
    const id = await doneMeeting(page, "Arquitetura do Radar E2E");
    const decision = async (description: string) => {
      const res = await postJson(page, `/api/meetings/${id}/items`, { type: "decisao_arquitetural", description });
      expect(res.status).toBe(201);
      return res.json.id;
    };
    const perms = await decision("Guardar permissões no banco de dados");
    const queues = await decision("Usar filas entre os serviços");
    const matrix = await decision("Adotar matriz de testes automatizados");
    const longText = "As regras de permissão estão fixas no código, sem uma fonte única e consultável. ".repeat(4).trim();
    const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await db.connect();
    try {
      const insert = `INSERT INTO adrs (item_id, meeting_id, number, title, context, problem, alternatives, decision, consequences, risks, status, approved_at, generated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;
      await db.query(insert, [
        perms, id, null, "Modelo de dados de permissões como fonte da verdade", longText, longText, "[]",
        "Criar um catálogo de permissões no banco, com matriz por perfil e CRUD de gestão. ".repeat(3).trim(),
        longText, JSON.stringify(["Validação difícil sem entregável visual", "Mapear todos os pontos do código"]),
        "proposto", null, "claude:sonnet",
      ]);
      await db.query(insert, [
        queues, id, 41, "Filas entre os serviços", "Integrações síncronas falham em cascata.", "Acoplamento temporal.",
        JSON.stringify([{ opcao: "REST síncrono", pros: "simples", contras: "acoplado" }]), "Usar filas.", "Mais uma peça para operar.",
        "[]", "aprovado", "2026-09-16T15:00:00Z", "local:qwen3.5:4b",
      ]);
      await db.query(insert, [
        matrix, id, 42, "Matriz automatizada de testes de acesso", "Muitas pontas soltas.", "Regressões de permissão.", "[]",
        "Implementar a matriz de testes.", "Cobertura por nível de acesso.", "[]", "rejeitado", "2026-09-16T15:00:00Z",
        "openrouter:deepseek/deepseek-v4.1-flash",
      ]);
    } finally {
      await db.end();
    }

    await page.goto(`/reunioes/${id}`);
    await page.getByRole("tab", { name: "ADRs (3)" }).click();
    const filters = page.getByRole("tablist", { name: "Filtrar ADRs" });
    await expect(filters.getByRole("tab", { name: "Ativos (2)" })).toHaveAttribute("aria-selected", "true");
    await expect(filters.getByRole("tab", { name: "Rejeitados (1)" })).toBeVisible();
    const toggles = page.locator("button.adr-toggle");
    await expect(toggles).toHaveCount(2);
    // proposto primeiro, recolhido, com o começo da decisão à vista
    await expect(toggles.first()).toContainText("Sugestão");
    await expect(toggles.first()).toHaveAttribute("aria-expanded", "false");
    const proposed = page.locator("article.adr-card").first();
    await expect(proposed.locator(".adr-excerpt")).toContainText("Criar um catálogo de permissões");
    await expect(proposed.getByText("Claude", { exact: true })).toHaveAttribute("title", "Gerado por sonnet via assinatura Claude (externo)");
    await expect(page.locator("article.adr-card").nth(1)).toContainText("ADR-041");
    await shot(page, "adrs-recolhidos");

    await page.getByRole("button", { name: "Expandir todos" }).click();
    await expect(toggles.first()).toHaveAttribute("aria-expanded", "true");
    await expect(proposed.getByRole("heading", { name: "Decisão" })).toBeVisible();
    await expect(proposed.getByRole("listitem").filter({ hasText: "Mapear todos os pontos do código" })).toBeVisible();
    await expect(proposed).toContainText("Aguardando revisão · gerado por sonnet via assinatura Claude (externo)");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400); // fim das transições de cor
    await shot(page, "adrs-abertos-escuro");
    await page.emulateMedia({ colorScheme: "light" });

    // rejeitado depois de aprovado: a data é da aprovação, e o texto diz isso
    await filters.getByRole("tab", { name: "Rejeitados (1)" }).click();
    const rejected = page.locator("article.adr-card");
    await expect(rejected).toHaveCount(1);
    await expect(rejected).toContainText("Rejeitado depois de aprovado em 16/09/2026");
    await expect(rejected.getByRole("button", { name: "Aprovar ADR" })).not.toHaveClass(/primary/);

    // aprovar a sugestão dá o próximo número
    await filters.getByRole("tab", { name: "Propostos (1)" }).click();
    await page.getByRole("button", { name: "Aprovar ADR" }).click();
    await expect(filters.getByRole("tab", { name: "Propostos (0)" })).toBeVisible();
    await filters.getByRole("tab", { name: /^Ativos/ }).click();
    await expect(toggles.first()).toContainText("ADR-041");
    await expect(toggles.nth(1)).toContainText("ADR-043");

    // a decisão de origem leva à aba Itens, com o cartão à vista
    await page.getByRole("button", { name: "Guardar permissões no banco de dados" }).click();
    await expect(page.getByRole("tab", { name: /^Itens/ })).toHaveAttribute("aria-selected", "true");
    const permsCard = page.locator(`#item-${perms}`);
    await expect(permsCard).toBeInViewport();

    // histórico legível: rótulos em português, sem null nem nomes de campo
    expect(
      (await postJson(page, `/api/items/${perms}`, { description: "Guardar permissões e menus no banco de dados" }, "PATCH")).status,
    ).toBe(200);
    await permsCard.getByRole("button", { name: "Histórico" }).click();
    const history = page.getByRole("dialog", { name: "Histórico do item" });
    const entries = history.locator("li.history-entry");
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText("Criado");
    await expect(entries.nth(0)).toContainText("Decisão arquitetural · manual");
    await expect(entries.nth(1)).toContainText("ADR aprovadoADR-043");
    await expect(entries.nth(1)).toContainText("Status do ADR");
    await expect(entries.nth(2)).toContainText("Editado");
    await expect(entries.nth(2).locator("del")).toContainText("Guardar permissões no banco de dados");
    await expect(history).not.toContainText("null");
    await expect(history).not.toContainText("reviewStatus");
    await shot(page, "historico");
    await history.getByRole("button", { name: "Fechar" }).click();

    await page.getByRole("tab", { name: "ADRs (3)" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "adrs-celular");
  });

  test("reunião da agenda com link: o assistente entra no horário e pode ir agora", async ({ page }) => {
    await login(page, ANA);
    const start = new Date(Date.now() + 3600_000).toISOString();
    const created = await postJson(page, "/api/meetings/scheduled", {
      title: "Daily com assistente E2E",
      start,
      durationMinutes: 15,
      url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_e2e%40thread.v2/0",
    });
    expect(created.status).toBe(201);

    await page.goto("/");
    const item = page.locator("li.agenda-item").filter({ hasText: "Daily com assistente E2E" });
    await expect(item).toContainText("assistente entra no horário");
    // com link, o PC não grava: não há "Gravar agora"
    await expect(item.getByRole("button", { name: "Gravar agora" })).toHaveCount(0);
    await expect(item.getByRole("button", { name: "Enviar assistente agora" })).toBeVisible();

    await item.getByRole("link", { name: "Daily com assistente E2E" }).click();
    await expect(page.getByText("No horário, o assistente entra na chamada e grava de dentro dela.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Gravar agora" })).toHaveCount(0);
    await shot(page, "assistente-agenda");
    await page.getByRole("button", { name: "Enviar assistente agora" }).click();
    // sem PulseAudio no E2E o assistente não sobe: a reunião mostra o erro e oferece mandar de novo
    await expect(page.getByRole("button", { name: "Enviar assistente de novo" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".error-text").first()).toContainText("Erro no bot");
  });

  test("admin desativa usuário e a sessão dele cai", async ({ browser }) => {
    const biaContext = await browser.newContext();
    const bia = await biaContext.newPage();
    await login(bia, BIA);

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await login(admin, ADMIN);
    await admin.getByRole("link", { name: "Usuários" }).click();
    await admin.getByRole("button", { name: `Desativar ${BIA.username}` }).click();
    await admin.getByRole("dialog", { name: "Desativar usuário?" }).getByRole("button", { name: "Desativar" }).click();
    await expect(admin.getByRole("row", { name: /@e2e-bia/ }).getByText("Desativado")).toBeVisible();

    await bia.getByRole("link", { name: "Reuniões", exact: true }).first().click();
    await expect(bia.getByRole("heading", { name: "Entrar" })).toBeVisible();
    await bia.getByLabel("Usuário").fill(BIA.username);
    await bia.getByLabel("Senha").fill(BIA.password);
    await bia.getByRole("button", { name: "Entrar" }).click();
    await expect(bia.getByRole("alert")).toContainText("desativado");

    await admin.getByRole("button", { name: `Reativar ${BIA.username}` }).click();
    await admin.getByRole("dialog", { name: "Reativar usuário?" }).getByRole("button", { name: "Reativar" }).click();
    await expect(admin.getByRole("row", { name: /@e2e-bia/ }).getByText("Ativo")).toBeVisible();
    await biaContext.close();
    await adminContext.close();
  });

  test("tema escuro persiste e o menu móvel abre @mobile", async ({ page, isMobile }) => {
    await login(page, ANA);
    const toggle = page.getByRole("button", { name: /Usar tema (escuro|claro)/ });
    const theme = async () => (await page.locator("html").getAttribute("data-theme")) ?? "";
    const before = await theme();
    await toggle.click();
    await expect.poll(theme).not.toBe(before);
    const after = await theme();
    await page.reload();
    expect(await theme()).toBe(after);
    await page.goto("/configuracoes");
    await expect(page.getByLabel("Nome de exibição")).toBeVisible();
    await shot(page, `config-perfil-${after}`);
    if (isMobile) {
      await page.getByRole("button", { name: "Abrir menu" }).click();
      await expect(page.getByRole("dialog").getByRole("link", { name: "Configurações" })).toBeVisible();
      await shot(page, "drawer");
      const overflow = await page.evaluate<boolean>("document.documentElement.scrollWidth > window.innerWidth");
      expect(overflow).toBe(false);
    }
  });
});
