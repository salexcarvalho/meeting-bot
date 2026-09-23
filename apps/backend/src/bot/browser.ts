import { Browser, BrowserContextOptions, chromium, Page } from "playwright";
import { config } from "../config";

/** `cameraFile`: cartão .y4m que a câmera falsa mostra (sem ele, a câmera fica desligada na reunião). */
/** `storageState`: sessão da conta do agente (cookies e localStorage); sem ela, entra como convidado. */
export async function launchBrowser(
  sinkName: string,
  cameraFile?: string | null,
  storageState?: unknown,
): Promise<{ browser: Browser; page: Page }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PULSE_SINK = sinkName;

  // Headed dentro do Xvfb (ver entrypoint.sh): Meet/Teams bloqueiam menos
  // que no modo headless.
  const browser = await chromium.launch({
    headless: false,
    env,
    args: [
      "--no-sandbox",
      "--lang=en-US",
      "--use-fake-ui-for-media-stream",
      // O container não tem câmera/mic: sem dispositivos o Teams trava num
      // aviso. Dispositivos falsos resolvem; o mic falso toca silêncio (o
      // padrão do Chromium seria um bipe).
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${config.fakeMicFile}`,
      ...(cameraFile ? [`--use-file-for-fake-video-capture=${cameraFile}`] : []),
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 720 },
    permissions: ["microphone", "camera"],
    ...(storageState ? { storageState: storageState as BrowserContextOptions["storageState"] } : {}),
  });
  const page = await context.newPage();
  return { browser, page };
}
