import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { createCameraWatch } from "../src/bot/cameraWatch";
import type { CameraState } from "../src/bot/join";

const page = {} as Page;

function fakeDriver(initial: CameraState | null, obeys = true) {
  let state = initial;
  const calls: boolean[] = [];
  return {
    calls,
    driver: {
      cameraState: async () => state,
      setCamera: async (_p: Page, on: boolean) => {
        calls.push(on);
        if (obeys) state = on ? "on" : "off";
      },
    },
  };
}

const opts = (over: Partial<Parameters<typeof createCameraWatch>[0]> = {}) => {
  const logs: string[] = [];
  return { logs, opts: { icon: false, iconOn: false, retries: 3, log: (m: string) => logs.push(m), ...over } };
};

describe("vigia da câmera na chamada", () => {
  it("sem ícone, câmera ligada sem pedido é desligada", async () => {
    const { logs, opts: o } = opts();
    const f = fakeDriver("on");
    const watch = createCameraWatch(o);
    await watch.check(f.driver, page);
    expect(f.calls).toEqual([false]);
    expect(logs).toEqual(["câmera ligada na chamada sem pedido; desligando"]);
    await watch.check(f.driver, page);
    expect(f.calls).toEqual([false]);
  });

  it("sem ícone, câmera desligada ou ilegível não faz nada", async () => {
    for (const state of ["off", null] as const) {
      const { opts: o } = opts();
      const f = fakeDriver(state);
      await createCameraWatch(o).check(f.driver, page);
      expect(f.calls).toEqual([]);
    }
  });

  it("desistir depois de CAMERA_RETRIES tentativas quando a câmera teima em ficar ligada", async () => {
    const { opts: o } = opts({ retries: 3 });
    const f = fakeDriver("on", false);
    const watch = createCameraWatch(o);
    for (let i = 0; i < 6; i++) await watch.check(f.driver, page);
    expect(f.calls).toEqual([false, false, false]);
  });

  it("com ícone ligado na entrada, religa se a câmera cair", async () => {
    const { logs, opts: o } = opts({ icon: true, iconOn: true });
    const f = fakeDriver("off");
    await createCameraWatch(o).check(f.driver, page);
    expect(f.calls).toEqual([true]);
    expect(logs).toEqual(["câmera desligada na chamada; religando o ícone"]);
  });

  it("com ícone, câmera ligada não é tocada; ícone que não ligou na entrada não é religado", async () => {
    const on = fakeDriver("on");
    await createCameraWatch(opts({ icon: true, iconOn: true }).opts).check(on.driver, page);
    const off = fakeDriver("off");
    await createCameraWatch(opts({ icon: true, iconOn: false }).opts).check(off.driver, page);
    expect([...on.calls, ...off.calls]).toEqual([]);
  });
});
