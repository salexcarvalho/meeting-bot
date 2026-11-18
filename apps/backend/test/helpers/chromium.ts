import { existsSync, readFileSync } from "fs";
import path from "path";
import { chromium, type Browser, type Page } from "playwright";
import { identifyTile, participantKey } from "../../src/bot/speakers/names";
import { PageProbeHost, type DrainResult, type IndicatorRule, type ProbeConfig } from "../../src/bot/speakers/probe";

// Chromium headless para os testes do leitor da tela (spec 006). Sem o navegador instalado, os testes são pulados.
export function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

export function launchChromium(): Promise<Browser> {
  return chromium.launch({ headless: true, args: ["--no-sandbox"] });
}

export const fixturePath = (name: string) => path.join(__dirname, "..", "fixtures", "speakers", name);

/** Abre uma fixture de HTML (sintética, ver o comentário no topo de cada arquivo). */
export async function openFixture(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.setContent(readFileSync(fixturePath(name), "utf8"));
  return page;
}

/** Mesma configuração de produção, mas lendo a cada 30 ms e aprendendo o repouso em 3 leituras (testes rápidos). */
export function fast(config: ProbeConfig): ProbeConfig {
  const speed = (rule: IndicatorRule): IndicatorRule => (rule.mode === "style" ? { ...rule, minObservations: 3 } : rule);
  return {
    ...config,
    intervalMs: 30,
    largeIntervalMs: 60,
    cacheMs: 200,
    layers: config.layers.map((layer) => ({ ...layer, indicators: layer.indicators.map(speed) })),
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface NamedEdge {
  key: string;
  name: string;
  speaking: boolean;
}

/** Espera o leitor ter lido várias vezes sem fala, para aprender o estilo de repouso dos quadros (a CI pode estar lenta). */
export async function waitForRest(host: PageProbeHost, polls = 15): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await host.drain();
    if (result && result.stats.polls >= polls) return;
    await sleep(30);
  }
}

/** Instala o leitor, espera o repouso e devolve o que ele viu já com o nome limpo (como o coletor faz). */
export async function readNamed(
  page: Page,
  config: ProbeConfig,
  actions: () => Promise<void>,
  assistant = "Ata do Sérgio",
): Promise<{ edges: NamedEdge[]; raw: DrainResult }> {
  const host = new PageProbeHost(page, config);
  await host.install();
  await waitForRest(host);
  await actions();
  await sleep(150);
  const raw = await host.drain();
  if (!raw) throw new Error("sem leitura");
  const edges: NamedEdge[] = [];
  for (const edge of raw.edges) {
    const tile = identifyTile(edge.raw, assistant);
    if (tile.name) edges.push({ key: participantKey(edge.id, tile.name), name: tile.name, speaking: edge.speaking });
  }
  return { edges, raw };
}
