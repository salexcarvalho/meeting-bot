import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meetProbe } from "../src/bot/speakers/meet";
import { fast, openFixture, readNamed, chromiumAvailable, launchChromium } from "./helpers/chromium";

const available = chromiumAvailable();
let browser: Browser;

describe.skipIf(!available)("leitor do Meet (Chromium, fixtures sintéticas: hipóteses do plano, T001 pendente)", () => {
  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("grade: nomeia quem fala, ignora o assistente e o quadro de apresentação", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const { edges, raw } = await readNamed(page, fast(meetProbe()), async () => {
      await page.evaluate("window.__setSpeaking('Pessoa A', true)");
      await page.evaluate("window.__setSpeaking('Ata do Sérgio (You)', true)");
      await page.evaluate("window.__setSpeaking('Pessoa A está apresentando', true)");
    });
    expect(edges).toEqual([{ key: "id:spaces/s/devices/1", name: "Pessoa A", speaking: true }]);
    expect(raw.stats.layerName).toBe("semantic");
    await page.context().close();
  });

  it("painel de pessoas já aberto: camada 3 lê a lista", async () => {
    const page = await openFixture(browser, "meet-people-panel.html");
    const { edges, raw } = await readNamed(page, fast(meetProbe()), async () => {
      await page.evaluate("window.__setSpeaking('Pessoa C', true)");
    });
    expect(raw.stats.layerName).toBe("panel");
    expect(edges.map((e) => [e.name, e.speaking])).toEqual([["Pessoa C", true]]);
    await page.context().close();
  });

  it("reunião grande: lê 40 quadros e acompanha a fala de um deles", async () => {
    const page = await openFixture(browser, "meet-large.html");
    const { edges, raw } = await readNamed(page, fast(meetProbe()), async () => {
      await page.evaluate("window.__setSpeaking('Pessoa 33', true)");
    });
    expect(raw.stats.tiles).toBe(40);
    expect(edges.map((e) => e.name)).toEqual(["Pessoa 33"]);
    await page.context().close();
  });
});
