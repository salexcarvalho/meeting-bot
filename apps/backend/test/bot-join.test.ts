import { describe, expect, it } from "vitest";
import { driveJoin, JoinError, type JoinScreen } from "../src/bot/join";

// Relógio virtual: cada sleep avança o tempo; os controles aparecem conforme o "roteiro".
function harness(script: {
  dismissAt?: number;
  nameAt?: number | null;
  togglesAt?: number | null;
  joinAt?: number;
  failureAt?: number | null;
  joinNeedsName?: boolean;
}) {
  let t = 0;
  const events: string[] = [];
  let nameValue = "";
  let dismissedOpen = script.dismissAt !== undefined;
  const togglesOn = { microfone: true, câmera: true };
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
        events.push(`fill@${t}`);
      },
    },
    toggles: (["microfone", "câmera"] as const).map((name) => ({
      name,
      visible: async () => togglesOn[name] && shown(script.togglesAt),
      act: async () => {
        togglesOn[name] = false;
        events.push(`${name}@${t}`);
      },
    })),
    join: {
      visible: async () => shown(script.joinAt ?? 0),
      enabled: async () => !script.joinNeedsName || nameValue !== "",
      click: async () => {
        events.push(`join@${t}`);
      },
    },
    failure: async () => (shown(script.failureAt) ? "Link de reunião inválido ou expirado." : null),
  };
  const opts = {
    timeoutMs: 45_000,
    pollMs: 250,
    graceMs: 1500,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  return { screen, events, opts, time: () => t };
}

describe("driveJoin", () => {
  it("reage ao que aparecer, sem somar esperas fixas (cenário Teams)", async () => {
    const h = harness({ dismissAt: 500, nameAt: 1500, togglesAt: 2000, joinAt: 1500, joinNeedsName: true });
    let joiningAt: number | null = null;
    await driveJoin(h.screen, "Orion - assistente gravando", { ...h.opts, onJoining: () => (joiningAt = h.time()) });
    expect(h.events).toEqual(["dismiss@500", "fill@1500", "microfone@2000", "câmera@2000", "join@2000"]);
    expect(joiningAt).toBe(1500);
    // antes: 15 s (continuar no navegador) + 3 s + 3 s + 3 s de esperas fixas
    expect(h.time()).toBeLessThan(3000);
  });

  it("espera o campo de nome quando o Entrar ainda está desabilitado", async () => {
    const h = harness({ nameAt: 3000, togglesAt: null, joinAt: 0, joinNeedsName: true });
    await driveJoin(h.screen, "Sérgio - assistente gravando", h.opts);
    expect(h.events).toEqual(["fill@3000", "join@3000"]);
  });

  it("sem campo de nome nem chaves, entra depois da carência", async () => {
    const h = harness({ nameAt: null, togglesAt: null, joinAt: 1000 });
    await driveJoin(h.screen, "x", h.opts);
    expect(h.events).toEqual(["join@2500"]);
  });

  it("falha definitiva interrompe na hora", async () => {
    const h = harness({ nameAt: null, joinAt: 99_000, failureAt: 2000 });
    const err = await driveJoin(h.screen, "x", h.opts).catch((e) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect(err.kind).toBe("failure");
    expect(err.message).toMatch(/inválido/);
    expect(h.time()).toBeLessThanOrEqual(3000);
  });

  it("estoura o prazo total quando o Entrar nunca aparece", async () => {
    const h = harness({ nameAt: null, joinAt: 99_000 });
    const err = await driveJoin(h.screen, "x", { ...h.opts, timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/não apareceu/);
  });

  it("para quando cancelado", async () => {
    const h = harness({ nameAt: null, joinAt: 99_000 });
    const abort = new AbortController();
    abort.abort();
    const err = await driveJoin(h.screen, "x", { ...h.opts, signal: abort.signal }).catch((e) => e);
    expect(err.kind).toBe("aborted");
  });

  it("tenta de novo quando o clique em Entrar falha", async () => {
    const h = harness({ nameAt: null, togglesAt: null, joinAt: 0 });
    let attempts = 0;
    h.screen.join.click = async () => {
      attempts++;
      if (attempts === 1) throw new Error("elemento saiu da página");
    };
    await driveJoin(h.screen, "x", h.opts);
    expect(attempts).toBe(2);
  });
});
