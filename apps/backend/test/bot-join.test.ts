import { describe, expect, it } from "vitest";
import { driveJoin, JoinError, type JoinIdentity, type JoinScreen } from "../src/bot/join";

// Relógio virtual: cada sleep avança o tempo; os controles aparecem conforme o "roteiro".
function harness(script: {
  dismissAt?: number;
  nameAt?: number | null;
  micAt?: number | null;
  cameraAt?: number | null;
  /** estado inicial da câmera (Teams já abre com ela ligada) */
  cameraStartsOn?: boolean;
  /** a chave obedece? false = a reunião não deixa ligar */
  cameraObeys?: boolean;
  /** a câmera desliga sozinha neste instante */
  cameraDropsAt?: number;
  joinAt?: number;
  failureAt?: number | null;
  joinNeedsName?: boolean;
}) {
  let t = 0;
  const events: string[] = [];
  let nameValue = "";
  let dismissedOpen = script.dismissAt !== undefined;
  let micOn = true;
  let cameraOn = script.cameraStartsOn ?? true;
  let dropped = false;
  const shown = (at: number | null | undefined) => at !== null && at !== undefined && t >= at;

  const screen: JoinScreen = {
    dismiss: [
      {
        name: "continuar no navegador",
        visible: async () => dismissedOpen && shown(script.dismissAt),
        act: async () => {
          dismissedOpen = false;
          events.push(`dismiss@${t}`);
        },
      },
    ],
    nameInput: {
      visible: async () => shown(script.nameAt),
      value: async () => nameValue,
      fill: async (v) => {
        nameValue = v;
        events.push(`fill:${v}@${t}`);
      },
    },
    mute: [
      {
        name: "microfone",
        visible: async () => micOn && shown(script.micAt),
        act: async () => {
          micOn = false;
          events.push(`microfone@${t}`);
        },
      },
    ],
    camera: {
      state: async () => {
        if (!dropped && script.cameraDropsAt !== undefined && t >= script.cameraDropsAt) {
          dropped = true;
          cameraOn = false;
        }
        return shown(script.cameraAt) ? (cameraOn ? "on" : "off") : null;
      },
      set: async (on) => {
        events.push(`câmera:${on ? "ligar" : "desligar"}@${t}`);
        if (script.cameraObeys ?? true) cameraOn = on;
      },
    },
    join: {
      visible: async () => shown(script.joinAt ?? 0),
      enabled: async () => !script.joinNeedsName || nameValue !== "",
      click: async () => {
        events.push(`join:${nameValue}@${t}`);
      },
    },
    failure: async () => (shown(script.failureAt) ? "Link de reunião inválido ou expirado." : null),
  };
  const opts = {
    timeoutMs: 45_000,
    pollMs: 250,
    graceMs: 1500,
    cameraGraceMs: 5000,
    cameraRetryMs: 2000,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  return { screen, events, opts, time: () => t };
}

const NAME = "Ata de Orion";
const withCamera: JoinIdentity = { name: NAME, camera: true };
const noCamera: JoinIdentity = { name: NAME, camera: false };

describe("driveJoin", () => {
  it("reage ao que aparecer, sem somar esperas fixas (cenário Teams, sem ícone)", async () => {
    const h = harness({ dismissAt: 500, nameAt: 1500, micAt: 2000, cameraAt: 2000, joinAt: 1500, joinNeedsName: true });
    let joiningAt: number | null = null;
    const result = await driveJoin(h.screen, noCamera, { ...h.opts, onJoining: () => (joiningAt = h.time()) });
    expect(h.events).toEqual([
      "dismiss@500",
      `fill:${NAME}@1500`,
      "câmera:desligar@2000",
      "microfone@2000",
      `join:${NAME}@2250`,
    ]);
    expect(result).toEqual({ camera: false });
    expect(joiningAt).toBe(1500);
    // antes: 15 s (continuar no navegador) + 3 s + 3 s + 3 s de esperas fixas
    expect(h.time()).toBeLessThan(3000);
  });

  it("com ícone, mantém a câmera ligada e o nome com o aviso", async () => {
    const h = harness({ nameAt: 500, micAt: 500, cameraAt: 500, joinAt: 500, joinNeedsName: true });
    const result = await driveJoin(h.screen, withCamera, h.opts);
    expect(h.events).toEqual([`fill:${NAME}@500`, "microfone@500", `join:${NAME}@500`]);
    expect(result).toEqual({ camera: true });
  });

  it("liga a câmera que abriu desligada antes de entrar", async () => {
    const h = harness({ nameAt: 0, micAt: 0, cameraAt: 0, cameraStartsOn: false, joinAt: 0, joinNeedsName: true });
    const result = await driveJoin(h.screen, withCamera, h.opts);
    expect(h.events).toEqual(["câmera:ligar@0", `fill:${NAME}@0`, "microfone@0", `join:${NAME}@250`]);
    expect(result.camera).toBe(true);
  });

  it("se a câmera não liga, entra sem ela depois de três tentativas", async () => {
    const h = harness({ nameAt: 0, cameraAt: 0, cameraStartsOn: false, cameraObeys: false, joinAt: 0, joinNeedsName: true });
    const result = await driveJoin(h.screen, withCamera, h.opts);
    expect(h.events.filter((e) => e.startsWith("câmera"))).toEqual(["câmera:ligar@0", "câmera:ligar@2000", "câmera:ligar@4000"]);
    expect(h.events.at(-1)).toBe(`join:${NAME}@5000`);
    expect(result).toEqual({ camera: false });
  });

  it("câmera que cai antes do clique é reportada como desligada", async () => {
    const h = harness({ nameAt: 0, cameraAt: 0, cameraObeys: false, cameraDropsAt: 750, joinAt: 1000, joinNeedsName: true });
    const result = await driveJoin(h.screen, withCamera, h.opts);
    expect(h.events[1]).toBe("câmera:ligar@750");
    expect(h.events.at(-1)).toMatch(/^join:/);
    expect(result.camera).toBe(false);
  });

  it("sem chave de câmera na tela, entra depois da carência", async () => {
    const h = harness({ nameAt: 0, cameraAt: null, joinAt: 0, joinNeedsName: true });
    const result = await driveJoin(h.screen, withCamera, h.opts);
    expect(h.events).toEqual([`fill:${NAME}@0`, `join:${NAME}@1500`]);
    expect(result.camera).toBe(false);
  });

  it("espera o campo de nome quando o Entrar ainda está desabilitado", async () => {
    const h = harness({ nameAt: 3000, micAt: null, cameraAt: null, joinAt: 0, joinNeedsName: true });
    await driveJoin(h.screen, noCamera, h.opts);
    expect(h.events).toEqual([`fill:${NAME}@3000`, `join:${NAME}@3000`]);
  });

  it("sem campo de nome nem chaves, entra depois da carência", async () => {
    const h = harness({ nameAt: null, micAt: null, cameraAt: null, joinAt: 1000 });
    await driveJoin(h.screen, noCamera, h.opts);
    expect(h.events).toEqual(["join:@2500"]);
  });

  it("falha definitiva interrompe na hora", async () => {
    const h = harness({ nameAt: null, joinAt: 99_000, failureAt: 2000 });
    const err = await driveJoin(h.screen, noCamera, h.opts).catch((e) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect(err.kind).toBe("failure");
    expect(err.message).toMatch(/inválido/);
    expect(h.time()).toBeLessThanOrEqual(3000);
  });

  it("estoura o prazo total quando o Entrar nunca aparece", async () => {
    const h = harness({ nameAt: null, joinAt: 99_000 });
    const err = await driveJoin(h.screen, noCamera, { ...h.opts, timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/não apareceu/);
  });

  it("para quando cancelado", async () => {
    const h = harness({ nameAt: null, joinAt: 99_000 });
    const abort = new AbortController();
    abort.abort();
    const err = await driveJoin(h.screen, noCamera, { ...h.opts, signal: abort.signal }).catch((e) => e);
    expect(err.kind).toBe("aborted");
  });

  it("tenta de novo quando o clique em Entrar falha", async () => {
    const h = harness({ nameAt: null, micAt: null, cameraAt: null, joinAt: 0 });
    let attempts = 0;
    h.screen.join.click = async () => {
      attempts++;
      if (attempts === 1) throw new Error("elemento saiu da página");
    };
    await driveJoin(h.screen, noCamera, h.opts);
    expect(attempts).toBe(2);
  });
});
