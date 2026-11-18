import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meetProbe } from "../src/bot/speakers/meet";
import { PageProbeHost, probeConfig, type DrainResult } from "../src/bot/speakers/probe";
import { teamsProbe } from "../src/bot/speakers/teams";
import { fast, openFixture, sleep, chromiumAvailable, launchChromium, waitForRest } from "./helpers/chromium";

const available = chromiumAvailable();
let browser: Browser;

async function collect(host: PageProbeHost, ms: number): Promise<DrainResult> {
  await sleep(ms);
  const result = await host.drain();
  if (!result) throw new Error("sem leitura");
  return result;
}

describe.skipIf(!available)("leitor da tela: núcleo (Chromium, fixtures sintéticas)", () => {
  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("registra a borda de subida e a de descida de quem fala, com o nome cru do quadro", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const host = new PageProbeHost(page, fast(meetProbe()));
    await host.install();
    await waitForRest(host);
    await page.evaluate("window.__setSpeaking('Pessoa B', true)");
    await sleep(150);
    await page.evaluate("window.__setSpeaking('Pessoa B', false)");
    const result = await collect(host, 150);
    const edges = result.edges.filter((e) => e.raw.includes("Pessoa B"));
    expect(edges.map((e) => e.speaking)).toEqual([true, false]);
    expect(edges[1].atNodeMs).toBeGreaterThan(edges[0].atNodeMs);
    expect(edges[0].id).toBe("spaces/s/devices/2");
    expect(result.stats.layerName).toBe("semantic");
    expect(result.stats.tiles).toBe(5);
    await page.context().close();
  });

  it("quadro que some falando gera a borda de descida", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const host = new PageProbeHost(page, fast(meetProbe()));
    await host.install();
    await page.evaluate("window.__setSpeaking('Pessoa C', true)");
    await sleep(150);
    await page.evaluate("window.__remove('Pessoa C')");
    const result = await collect(host, 200);
    expect(result.edges.filter((e) => e.raw.includes("Pessoa C")).map((e) => e.speaking)).toEqual([true, false]);
    await page.context().close();
  });

  it("sem mudança de estado não devolve nada (só as mudanças saem da página)", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const host = new PageProbeHost(page, fast(meetProbe()));
    await host.install();
    await sleep(200);
    expect((await collect(host, 200)).edges).toEqual([]);
    await page.context().close();
  });

  it("exceção dentro da página é contada e não propagada", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const config = fast(probeConfig([{ name: "ruim", tile: "[data-participant-id]", nameFrom: [{ sel: "[data-self-name]", attr: "data-self-name" }], indicators: [{ mode: "attr", attr: "data-participant-id", match: "(" }] }]));
    const host = new PageProbeHost(page, config);
    await host.install();
    const result = await collect(host, 200);
    expect(result.stats.errors).toBeGreaterThan(0);
    expect(result.stats.lastError).not.toBe("");
    await page.context().close();
  });

  it("cache de quadros: continua lendo depois de a estrutura mudar", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const host = new PageProbeHost(page, fast(meetProbe()));
    await host.install();
    await sleep(100);
    await page.evaluate(`(() => { const t = document.querySelector('[data-participant-id]').cloneNode(true); t.setAttribute('data-participant-id','x/9'); t.setAttribute('data-tile-name','Pessoa Nova'); t.querySelector('[data-self-name]').setAttribute('data-self-name','Pessoa Nova'); t.querySelector('[data-audio-level]').setAttribute('data-is-speaking','true'); document.querySelector('.stage').appendChild(t); })()`);
    const result = await collect(host, 200);
    expect(result.edges.some((e) => e.raw === "Pessoa Nova" && e.speaking)).toBe(true);
    await page.context().close();
  });

  it("intervalo sobe para o grande quando há mais de 30 quadros", async () => {
    const page = await openFixture(browser, "meet-large.html");
    const config = { ...fast(meetProbe()), largeTiles: 30 };
    const host = new PageProbeHost(page, config);
    await host.install();
    await sleep(300);
    const result = await collect(host, 100);
    expect(result.stats.tiles).toBe(40);
    const polls = result.stats.polls;
    await sleep(600);
    const later = (await collect(host, 0)).stats.polls - polls;
    // com 60 ms por leitura cabem no máximo ~10 leituras em 600 ms (com 30 ms seriam ~20)
    expect(later).toBeLessThanOrEqual(14);
    await page.context().close();
  });

  it("instalar de novo é idempotente (não duplica leitores)", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const host = new PageProbeHost(page, fast(meetProbe()));
    await host.install();
    await host.install();
    await host.install();
    await page.evaluate("window.__setSpeaking('Pessoa A', true)");
    const result = await collect(host, 200);
    expect(result.edges.filter((e) => e.raw === "Pessoa A")).toHaveLength(1);
    await page.context().close();
  });

  it("fixture sem quadros: nada a ler, sem erro", async () => {
    const page = await openFixture(browser, "broken.html");
    for (const config of [fast(meetProbe()), fast(teamsProbe("guest"))]) {
      const host = new PageProbeHost(page, config);
      await host.install();
      const result = await collect(host, 150);
      expect(result.edges).toEqual([]);
      expect(result.stats.tiles).toBe(0);
      expect(result.stats.errors).toBe(0);
    }
    await page.context().close();
  });
});
