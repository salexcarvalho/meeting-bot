import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meetProbe } from "../src/bot/speakers/meet";
import { PageProbeHost } from "../src/bot/speakers/probe";
import { teamsProbe } from "../src/bot/speakers/teams";
import { openFixture, sleep, chromiumAvailable, launchChromium } from "./helpers/chromium";

const available = chromiumAvailable();
let browser: Browser;
const WINDOW_MS = 4000;
// SC-006 / FR-020: menos de 3% de um núcleo (configuração de produção: 250 ms, 500 ms com mais de 30 quadros)
const MAX_CPU = 0.03;

async function pageCpu(fixture: string, tiles: number, config: ReturnType<typeof teamsProbe>): Promise<number> {
  const page = await openFixture(browser, fixture);
  await page.evaluate(`document.querySelectorAll('[data-tile-name]').forEach((t, i) => { if (i >= ${tiles}) t.remove(); })`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const host = new PageProbeHost(page, config);
  await host.install();
  await sleep(500);
  const metric = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "ScriptDuration")?.value ?? 0;
  };
  const before = await metric();
  const started = performance.now();
  // alguns falam durante a medição, para exercitar o caminho de estilo
  for (let step = 0; step < 4; step++) {
    await page.evaluate(`window.__setSpeaking('Pessoa ${step}', ${step % 2 === 0})`);
    await sleep(WINDOW_MS / 4);
  }
  const used = (await metric()) - before;
  const cpu = used / ((performance.now() - started) / 1000);
  await page.context().close();
  return cpu;
}

describe.skipIf(!available)("custo da leitura da tela (T038, SC-006)", () => {
  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it.each([8, 30, 40])("Teams com %i quadros usa menos de 3 por cento de um núcleo na página", async (tiles) => {
    const cpu = await pageCpu("teams-large.html", tiles, teamsProbe("guest"));
    expect(cpu).toBeLessThan(MAX_CPU);
  });

  it.each([8, 40])("Meet com %i quadros usa menos de 3 por cento de um núcleo na página", async (tiles) => {
    const cpu = await pageCpu("meet-large.html", tiles, meetProbe());
    expect(cpu).toBeLessThan(MAX_CPU);
  });
});
