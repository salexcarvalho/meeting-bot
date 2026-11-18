import type { Page } from "playwright";
import type { PlatformDriver } from "./platforms";

export interface CameraWatchOptions {
  /** há ícone do agente para mostrar (BOT_CAMERA + avatar) */
  icon: boolean;
  /** o ícone ficou ligado na entrada */
  iconOn: boolean;
  /** tentativas por sentido; depois disso segue como está */
  retries: number;
  log: (msg: string) => void;
}

/**
 * Vigia a câmera na chamada, nos dois sentidos: religa o ícone se ele cair e,
 * sem ícone, desliga a câmera se o Teams/Meet a ligar sozinho.
 */
export function createCameraWatch(opts: CameraWatchOptions) {
  let onRetries = 0;
  let offRetries = 0;
  return {
    async check(driver: Pick<PlatformDriver, "cameraState" | "setCamera">, page: Page): Promise<void> {
      if (opts.icon && !opts.iconOn) return;
      if (opts.icon ? onRetries >= opts.retries : offRetries >= opts.retries) return;
      const state = await driver.cameraState(page).catch(() => null);
      if (opts.icon && state === "off") {
        onRetries++;
        opts.log("câmera desligada na chamada; religando o ícone");
        await driver.setCamera(page, true).catch(() => {});
      } else if (!opts.icon && state === "on") {
        offRetries++;
        opts.log("câmera ligada na chamada sem pedido; desligando");
        await driver.setCamera(page, false).catch(() => {});
      }
    },
  };
}
