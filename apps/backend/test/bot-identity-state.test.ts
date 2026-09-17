import { afterEach, describe, expect, it, vi } from "vitest";
import { botBaseName, buildBotDisplayName, safeMeetingName } from "../src/bot/identity";
import {
  activeBotCount,
  activeBots,
  botForUrl,
  botProgress,
  botUrlKey,
  onBotProgress,
  releaseBotUrl,
  removeBot,
  reserveBotUrl,
  setBotStage,
} from "../src/bot/state";

const src = { userName: "Sérgio Carvalho", agentName: "Orion", customName: "Ata da Sala 3" };

describe("nome do bot na reunião", () => {
  it("usa a identidade escolhida e sempre marca como assistente gravando", () => {
    const suffix = "assistente gravando";
    expect(buildBotDisplayName({ ...src, mode: "user" }, suffix)).toBe("Sérgio Carvalho - assistente gravando");
    expect(buildBotDisplayName({ ...src, mode: "agent" }, suffix)).toBe("Orion - assistente gravando");
    expect(buildBotDisplayName({ ...src, mode: "custom" }, suffix)).toBe("Ata da Sala 3 - assistente gravando");
  });

  it("remove caracteres que o Teams recusa e limita o tamanho", () => {
    expect(safeMeetingName("Orion 🤖 <bot>!")).toBe("Orion bot");
    const long = botBaseName({ ...src, mode: "custom", customName: "x".repeat(80) });
    expect(long).toHaveLength(30);
  });

  it("nome personalizado vazio ou só com símbolos cai no nome do agente", () => {
    expect(botBaseName({ ...src, mode: "custom", customName: null })).toBe("Orion");
    expect(botBaseName({ ...src, mode: "custom", customName: "🤖🤖" })).toBe("Orion");
    expect(botBaseName({ mode: "agent", userName: "a", agentName: "!!", customName: null })).toBe("Assistente");
  });
});

describe("chave do link do bot", () => {
  it("ignora query, barra final e caixa", () => {
    expect(botUrlKey("https://meet.google.com/abc-defg-hij?authuser=1")).toBe("meet.google.com/abc-defg-hij");
    expect(botUrlKey("https://MEET.google.com/ABC-defg-hij/")).toBe("meet.google.com/abc-defg-hij");
    const teams =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0?context=%7b%22Tid%22%3a%22t1%22%7d";
    expect(botUrlKey(teams)).toBe("teams.microsoft.com/l/meetup-join/19:meeting_x@thread.v2/0");
    expect(botUrlKey(teams.replace("t1", "t2"))).toBe(botUrlKey(teams));
    expect(botUrlKey("https://teams.microsoft.com/meet/123?p=a")).not.toBe(
      botUrlKey("https://teams.microsoft.com/meet/124?p=a"),
    );
  });
});

describe("estado dos bots", () => {
  afterEach(() => {
    activeBots.clear();
    releaseBotUrl("k1");
    releaseBotUrl("k2");
    onBotProgress(() => {});
  });

  const register = (id: string, urlKey: string, requestedAt = Date.now()) =>
    activeBots.set(id, {
      abort: new AbortController(),
      done: Promise.resolve(),
      urlKey,
      displayName: "Orion - assistente gravando",
      requestedAt,
      stage: "preparing",
      stageAt: requestedAt,
    });

  it("reserva impede pedido duplicado até ser liberada", () => {
    expect(reserveBotUrl("k1")).toBe(true);
    expect(reserveBotUrl("k1")).toBe(false);
    expect(activeBotCount()).toBe(1);
    releaseBotUrl("k1");
    expect(reserveBotUrl("k1")).toBe(true);
  });

  it("bot ativo bloqueia o mesmo link", () => {
    register("m1", "k2");
    expect(botForUrl("k2")).toBe("m1");
    expect(reserveBotUrl("k2")).toBe(false);
    expect(reserveBotUrl("k1")).toBe(true);
  });

  it("publica cada etapa uma vez e limpa ao conectar ou sair", () => {
    const listener = vi.fn();
    onBotProgress(listener);
    register("m1", "k1", Date.now() - 1000);
    setBotStage("m1", "launching");
    setBotStage("m1", "launching");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][1]).toMatchObject({ stage: "launching", displayName: "Orion - assistente gravando" });
    expect(listener.mock.calls[0][1].elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(botProgress("m1")?.stage).toBe("launching");
    setBotStage("m1", "in_call");
    expect(listener.mock.calls[1][1]).toBeNull();
    expect(botProgress("m1")).toBeNull();
    removeBot("m1");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(activeBots.has("m1")).toBe(false);
  });
});
