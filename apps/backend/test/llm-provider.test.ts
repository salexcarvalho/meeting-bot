import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Extracao } from "@meeting-bot/contracts";
import { createProvider, LlmQueue, ProviderBlockedError } from "../src/llm/provider";
import { OllamaProvider, toOllamaSchema } from "../src/llm/ollama";

const ollamaCfg = { url: "http://ollama:11434", model: "qwen3.5:4b", keepAlive: "30m" };

describe("createProvider", () => {
  it("recusa provedor externo com LOCAL_ONLY e audita", () => {
    const onBlocked = vi.fn();
    expect(() => createProvider("claude", { localOnly: true, onBlocked, ollama: ollamaCfg })).toThrow(
      ProviderBlockedError,
    );
    expect(onBlocked).toHaveBeenCalledWith("claude");
  });

  it("aceita ollama", () => {
    const provider = createProvider("ollama", { localOnly: true, onBlocked: vi.fn(), ollama: ollamaCfg });
    expect(provider.name).toBe("ollama");
  });
});

describe("toOllamaSchema", () => {
  it("remove limites de tamanho e mantém enums/required", () => {
    const schema = toOllamaSchema(Extracao) as any;
    const text = JSON.stringify(schema);
    expect(text).not.toContain("maxLength");
    expect(text).not.toContain("maxItems");
    expect(text).not.toContain("$schema");
    expect(schema.required).toEqual(["resumo_trecho", "itens"]);
    expect(schema.properties.itens.items.properties.tipo.enum).toContain("decisao_arquitetural");
  });
});

describe("OllamaProvider", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const Schema = z.object({ ok: z.boolean() });

  function reply(content: string) {
    return new Response(JSON.stringify({ message: { content }, eval_count: 3, eval_duration: 1e9 }), { status: 200 });
  }

  it("envia format, think:false, num_ctx e valida a saída", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply('{"ok":true}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new OllamaProvider(ollamaCfg);
    const out = await provider.generate({ system: "s", user: "u", schema: Schema, numCtx: 4096, label: "t" });
    expect(out).toEqual({ ok: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(fetchMock.mock.calls[0][0]).toBe("http://ollama:11434/api/chat");
    expect(body).toMatchObject({
      model: "qwen3.5:4b",
      stream: false,
      think: false,
      keep_alive: "30m",
      options: { temperature: 0, num_ctx: 4096 },
    });
    expect(body.format.type).toBe("object");
    expect(body.messages[0]).toEqual({ role: "system", content: "s" });
  });

  it("tenta de novo uma vez quando a saída não valida", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply('{"ok":"talvez"}'))
      .mockResolvedValueOnce(reply('{"ok":false}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new OllamaProvider(ollamaCfg);
    const out = await provider.generate({ system: "s", user: "u", schema: Schema, numCtx: 4096, label: "t" });
    expect(out).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falha após duas saídas inválidas", async () => {
    globalThis.fetch = vi.fn(async () => reply("não é json")) as unknown as typeof fetch;
    const provider = new OllamaProvider(ollamaCfg);
    await expect(
      provider.generate({ system: "s", user: "u", schema: Schema, numCtx: 4096, label: "t" }),
    ).rejects.toThrow(/inválida/);
  });
});

describe("LlmQueue", () => {
  it("executa uma por vez e prioriza live", async () => {
    const queue = new LlmQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.run("post", async () => {
      order.push("post-1");
      await new Promise<void>((r) => (release = r));
    });
    const second = queue.run("post", async () => void order.push("post-2"));
    const live = queue.run("live", async () => void order.push("live"));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["post-1"]);
    release();
    await Promise.all([first, second, live]);
    expect(order).toEqual(["post-1", "live", "post-2"]);
  });
});
