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
    const api = (url: string, body: unknown) =>
      page.evaluate<{ status: number; json: { id: string } }, readonly [string, unknown]>(
        async ([u, b]) => {
          const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
          return { status: res.status, json: (await res.json()) as { id: string } };
        },
        [url, body] as const,
      );
    const start = new Date(Date.now() - 3600_000).toISOString();
    const created = await api("/api/meetings/scheduled", { title: "Revisão de arquitetura E2E", start, durationMinutes: 30 });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    // reunião já concluída com transcrição final: o pipeline real precisaria de GPU
    const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await db.connect();
    try {
      await db.query(`UPDATE meetings SET status = 'done' WHERE id = $1`, [id]);
      await db.query(
        `INSERT INTO transcript_segments (meeting_id, speaker, text, start_seconds, end_seconds, channel, pass)
         VALUES ($1, 'Ana', 'Vamos adotar Kafka entre os serviços.', 0, 5, 'mic', 'final')`,
        [id],
      );
    } finally {
      await db.end();
    }
    const item = await api(`/api/meetings/${id}/items`, { type: "decisao_arquitetural", description: "Adotar Kafka entre os serviços" });
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
