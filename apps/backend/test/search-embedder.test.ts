import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkVector,
  EmbedDimensionError,
  EmbedModelMissingError,
  EmbedUnavailableError,
  EMBED_OPTIONS,
  l2normalize,
  OllamaEmbedder,
  vectorLiteral,
} from "../src/search/embedder";

const settings = { embedModel: "bge-m3", embedDim: 4, embedKeepAlive: "10m", embedBatch: 2, embedDocPrefix: "", embedQueryPrefix: "" };
const noSleep = async () => undefined;
const embedder = (overrides: Partial<typeof settings> = {}) => new OllamaEmbedder({ ...settings, ...overrides }, "http://ollama:11434", noSleep);

const ok = (embeddings: unknown, extra: object = {}) =>
  new Response(JSON.stringify({ embeddings, prompt_eval_count: 7, total_duration: 3_000_000, ...extra }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

function stubFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; body: any }[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next;
      return next.clone();
    }),
  );
  return calls;
}

describe("cliente de embeddings do Ollama", () => {
  it("pede em CPU (num_gpu 0) com keep_alive, truncate e o modelo configurado", async () => {
    const calls = stubFetch(ok([[1, 0, 0, 0]]));
    await embedder().embedDocuments(["a"]);
    expect(calls[0].url).toBe("http://ollama:11434/api/embed");
    expect(calls[0].body).toMatchObject({ model: "bge-m3", input: ["a"], truncate: true, keep_alive: "10m", options: { num_gpu: 0 } });
    expect(EMBED_OPTIONS).toEqual({ num_gpu: 0 });
  });

  it("divide em lotes e junta o resultado na ordem", async () => {
    const calls = stubFetch(ok([[1, 0, 0, 0], [0, 1, 0, 0]]), ok([[0, 0, 1, 0]]));
    const result = await embedder().embedDocuments(["a", "b", "c"]);
    expect(calls.map((c) => c.body.input)).toEqual([["a", "b"], ["c"]]);
    expect(result.vectors).toHaveLength(3);
    expect(result.vectors[2]).toEqual([0, 0, 1, 0]);
    expect(result.inputTokens).toBe(14);
  });

  it("aplica os prefixos de documento e de consulta", async () => {
    const calls = stubFetch(ok([[1, 0, 0, 0]]));
    const e = embedder({ embedDocPrefix: "doc: ", embedQueryPrefix: "q: " });
    await e.embedDocuments(["x"]);
    await e.embedQuery("y");
    expect(calls.map((c) => c.body.input[0])).toEqual(["doc: x", "q: y"]);
  });

  it("recusa dimensão errada, vetor não finito e quantidade divergente", async () => {
    stubFetch(ok([[1, 0, 0]]));
    await expect(embedder().embedQuery("a")).rejects.toBeInstanceOf(EmbedDimensionError);
    stubFetch(ok([[1, 0, 0, null]]));
    await expect(embedder().embedQuery("a")).rejects.toBeInstanceOf(EmbedDimensionError);
    stubFetch(ok([]));
    await expect(embedder().embedQuery("a")).rejects.toBeInstanceOf(EmbedDimensionError);
  });

  it("normaliza o vetor (norma 1)", () => {
    expect(l2normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(checkVector([2, 0, 0, 0], 4)).toEqual([1, 0, 0, 0]);
    expect(() => l2normalize([0, 0])).toThrow(EmbedDimensionError);
  });

  it("modelo ausente (404) não é repetido", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ error: "model not found" }), { status: 404 }));
    await expect(embedder().embedQuery("a")).rejects.toBeInstanceOf(EmbedModelMissingError);
    expect(calls).toHaveLength(1);
  });

  it("tenta de novo em falha de rede e conclui quando o Ollama volta", async () => {
    const calls = stubFetch(new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), ok([[1, 0, 0, 0]]));
    await expect(embedder().embedQuery("a")).resolves.toMatchObject({ vectors: [[1, 0, 0, 0]] });
    expect(calls).toHaveLength(3);
  });

  it("desiste depois de 3 tentativas e informa indisponibilidade", async () => {
    const calls = stubFetch(new Error("ECONNREFUSED"));
    await expect(embedder().embedQuery("a")).rejects.toBeInstanceOf(EmbedUnavailableError);
    expect(calls).toHaveLength(3);
  });

  it("timeout vira erro com código de uso 'timeout'", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    stubFetch(timeout);
    await expect(embedder().embedQuery("a")).rejects.toMatchObject({ usageCode: "timeout" });
  });

  it("saúde: modelo presente, ausente e Ollama fora (com cache)", async () => {
    stubFetch(new Response(JSON.stringify({ models: [{ name: "bge-m3:latest" }] }), { status: 200 }));
    const present = embedder();
    expect(await present.health()).toEqual({ available: true, reason: null });
    stubFetch(new Response(JSON.stringify({ models: [{ name: "qwen3.5:4b" }] }), { status: 200 }));
    expect(await embedder().health()).toEqual({ available: false, reason: "modelo_ausente" });
    stubFetch(new Error("down"));
    expect(await embedder().health()).toEqual({ available: false, reason: "ollama_indisponivel" });
    // o resultado fica guardado: o fetch derrubado não muda a resposta já em cache
    expect(await present.health()).toEqual({ available: true, reason: null });
  });
});

describe("vetor como parâmetro de SQL", () => {
  it("só números formatados, nunca texto", () => {
    expect(vectorLiteral([0.5, -1, 2e-7])).toBe("[0.5,-1,2e-7]");
    expect(vectorLiteral([Number.NaN])).toBe("[0]");
  });
});
