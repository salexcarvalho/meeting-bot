import { readFileSync } from "fs";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpeakerCollector } from "../src/bot/speakers/collector";
import { meetProbe } from "../src/bot/speakers/meet";
import { PageProbeHost } from "../src/bot/speakers/probe";
import { ClockAnchor } from "../src/recording/clockAnchor";
import { SpeakerTimeline, type SpeechInterval } from "../src/recording/speakerTimeline";
import { fast, fixturePath, openFixture, sleep, chromiumAvailable, launchChromium } from "./helpers/chromium";

const available = chromiumAvailable();
let browser: Browser;

// Spec 006, US2: nenhuma falha da leitura da tela interrompe a gravação. O coletor roda com o Chromium de verdade.
function build(page: Awaited<ReturnType<typeof openFixture>>, persist: (i: SpeechInterval[]) => Promise<void>) {
  const anchor = new ClockAnchor();
  anchor.observe(32_000, performance.now() - 1000);
  const logs: string[] = [];
  const timeline = new SpeakerTimeline();
  const collector = createSpeakerCollector({
    host: new PageProbeHost(page, fast(meetProbe())),
    anchor,
    timeline,
    assistantName: "Ata do Sérgio",
    now: () => performance.now(),
    soundSinceLast: () => true,
    participants: async () => 4,
    persist,
    finish: async () => undefined,
    log: (m) => logs.push(m),
    sourceLabel: "meet",
  });
  return { collector, logs, timeline };
}

describe.skipIf(!available)("falha da leitura nunca atrapalha a gravação (Chromium)", () => {
  beforeAll(async () => {
    browser = await launchChromium();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("seletor que não acha nada: o ciclo roda, nada é gravado e o resumo diz indisponível", async () => {
    const page = await openFixture(browser, "broken.html");
    const saved: SpeechInterval[] = [];
    const { collector } = build(page, async (i) => void saved.push(...i));
    for (let i = 0; i < 3; i++) await collector.tick();
    const meta = await collector.stop();
    expect(saved).toEqual([]);
    expect(meta).toMatchObject({ status: "unavailable", reason: "no_tiles" });
    await page.context().close();
  });

  it("a página navega no meio da chamada: a leitura falha sem lançar e, reinjetado, o leitor volta a ler", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const host = new PageProbeHost(page, fast(meetProbe()));
    await host.install();
    await page.goto("about:blank");
    await expect(host.drain()).resolves.toBeNull();
    await page.setContent(readFileSync(fixturePath("meet-grid.html"), "utf8"));
    await host.install();
    await page.evaluate("window.__setSpeaking('Pessoa A', true)");
    await sleep(200);
    const result = await host.drain();
    expect(result?.edges.some((e) => e.raw === "Pessoa A" && e.speaking)).toBe(true);
    await page.context().close();
  });

  it("página fechada: tick e stop não lançam", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const { collector } = build(page, async () => undefined);
    await collector.tick();
    await page.context().close();
    await expect(collector.tick()).resolves.toBeUndefined();
    await expect(collector.stop()).resolves.toBeDefined();
  });

  it("gravação dos lotes falhando não impede o ciclo nem o encerramento", async () => {
    const page = await openFixture(browser, "meet-grid.html");
    const { collector, logs } = build(page, async () => {
      throw new Error("banco fora");
    });
    await collector.tick();
    await page.evaluate("window.__setSpeaking('Pessoa B', true)");
    await sleep(1300);
    await collector.tick();
    await expect(collector.stop()).resolves.toBeDefined();
    expect(logs.filter((l) => l.includes("não consegui gravar")).length).toBeLessThanOrEqual(1);
    await page.context().close();
  });
});
