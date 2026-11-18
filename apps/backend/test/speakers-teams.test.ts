import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { teamsProbe } from "../src/bot/speakers/teams";
import { fast, openFixture, readNamed, sleep, chromiumAvailable, launchChromium } from "./helpers/chromium";

const available = chromiumAvailable();
let browser: Browser;

describe.skipIf(!available)("leitor do Teams (Chromium, fixtures sintéticas: hipóteses do plano, T001 pendente)", () => {
  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("convidado: o contorno de voz muda de estilo em relação ao repouso do quadro", async () => {
    const page = await openFixture(browser, "teams-guest-stage.html");
    const { edges, raw } = await readNamed(page, fast(teamsProbe("guest")), async () => {
      await page.evaluate("window.__setSpeaking('Pessoa B', true)");
      await page.evaluate("window.__setSpeaking('Ata do Sérgio', true)");
      await page.evaluate("window.__setSpeaking('Pessoa D (Guest)', true)");
    });
    // o assistente nunca vira falante; "(Guest)" sai do nome
    expect(edges.map((e) => e.name).sort()).toEqual(["Pessoa B", "Pessoa D"]);
    expect(edges.every((e) => e.speaking)).toBe(true);
    expect(raw.stats.layerName).toBe("semantic");
    await page.context().close();
  });

  it("conta logada: o rótulo acessível carrega o estado e o nome sai limpo, sem '(You)'", async () => {
    const page = await openFixture(browser, "teams-account-stage.html");
    const { edges } = await readNamed(page, fast(teamsProbe("account")), async () => {
      await page.evaluate("window.__setSpeaking('Pessoa A', true)");
      await page.evaluate("window.__setSpeaking('Maria Souza (You)', true)");
    });
    expect(edges).toEqual([{ key: "name:pessoa a", name: "Pessoa A", speaking: true }]);
    await page.context().close();
  });

  it("o perfil só define a ordem: o leitor de convidado acha a tela da conta e vice-versa", async () => {
    const page = await openFixture(browser, "teams-account-stage.html");
    const { raw } = await readNamed(page, fast(teamsProbe("guest")), () => sleep(10));
    expect(raw.stats.tiles).toBe(3);
    await page.context().close();
  });

  it("reunião grande: 40 quadros lidos", async () => {
    const page = await openFixture(browser, "teams-large.html");
    const { edges, raw } = await readNamed(page, fast(teamsProbe("guest")), async () => {
      await page.evaluate("window.__setSpeaking('Pessoa 7', true)");
    });
    expect(raw.stats.tiles).toBe(40);
    expect(edges.map((e) => e.name)).toEqual(["Pessoa 7"]);
    await page.context().close();
  });
});
