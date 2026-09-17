import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  EgressBlockedError,
  installEgressGuard,
  isAllowedEndpoint,
  isAllowedHost,
  type BlockedRequest,
} from "../src/security/egress";

describe("egress guard (LOCAL_ONLY)", () => {
  const realFetch = globalThis.fetch;
  let inner: ReturnType<typeof vi.fn>;
  let blocked: Mock<(req: BlockedRequest) => void>;
  let uninstall: () => void;

  beforeEach(() => {
    inner = vi.fn(async () => new Response("ok"));
    globalThis.fetch = inner as unknown as typeof fetch;
    blocked = vi.fn();
    uninstall = installEgressGuard({ allowlist: ["ollama", "worker-gpu", "localhost", "127.0.0.1"], onBlocked: blocked });
  });

  afterEach(() => {
    uninstall();
    globalThis.fetch = realFetch;
  });

  it("deixa passar hosts permitidos", async () => {
    const res = await fetch("http://ollama:11434/api/ps");
    expect(await res.text()).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(blocked).not.toHaveBeenCalled();
  });

  it("aceita Request e URL como entrada", async () => {
    await fetch(new URL("http://worker-gpu:8000/health"));
    await fetch(new Request("http://127.0.0.1:3000/healthz"));
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("bloqueia host externo e audita", async () => {
    await expect(fetch("https://api.anthropic.com/v1/messages", { method: "POST" })).rejects.toThrow(
      /bloqueado \(LOCAL_ONLY\)/,
    );
    expect(inner).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith({ host: "api.anthropic.com", method: "POST", protocol: "https:" });
  });

  it("lança erro tipado", async () => {
    await expect(fetch("https://example.com")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("não aceita sufixos parecidos", () => {
    const allow = ["ollama", "localhost"];
    expect(isAllowedHost("ollama", allow)).toBe(true);
    expect(isAllowedHost("OLLAMA", allow)).toBe(true);
    expect(isAllowedHost("ollama.evil.com", allow)).toBe(false);
    expect(isAllowedHost("evil-localhost", allow)).toBe(false);
  });
});

describe("egress guard — exceção de ASR externo", () => {
  const realFetch = globalThis.fetch;
  let inner: Mock<typeof fetch>;
  let blocked: Mock<(req: BlockedRequest) => void>;
  let uninstall: () => void;

  beforeEach(() => {
    inner = vi.fn(async () => new Response("ok"));
    globalThis.fetch = inner as unknown as typeof fetch;
    blocked = vi.fn();
    uninstall = installEgressGuard({
      allowlist: ["ollama"],
      endpoints: [{ host: "openrouter.ai", pathPrefix: "/api/v1/audio/transcriptions" }],
      onBlocked: blocked,
    });
  });

  afterEach(() => {
    uninstall();
    globalThis.fetch = realFetch;
  });

  it("libera só o endpoint de transcrição em https", async () => {
    await fetch("https://openrouter.ai/api/v1/audio/transcriptions", { method: "POST" });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("bloqueia outros caminhos do mesmo host (ex.: LLM)", async () => {
    await expect(fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST" })).rejects.toThrow(EgressBlockedError);
    await expect(fetch("https://openrouter.ai/api/v1/audio/transcriptions-x")).rejects.toThrow(EgressBlockedError);
    await expect(fetch("https://openrouter.ai/api/v1/audio/transcriptions/../../chat/completions")).rejects.toThrow(
      EgressBlockedError,
    );
    expect(inner).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledTimes(3);
  });

  it("bloqueia http, credenciais na URL e subdomínios", async () => {
    await expect(fetch("http://openrouter.ai/api/v1/audio/transcriptions")).rejects.toThrow(EgressBlockedError);
    await expect(fetch("https://x:y@openrouter.ai/api/v1/audio/transcriptions")).rejects.toThrow(EgressBlockedError);
    await expect(fetch("https://evil.openrouter.ai.example.com/api/v1/audio/transcriptions")).rejects.toThrow(
      EgressBlockedError,
    );
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("isAllowedEndpoint", () => {
  it("compara caminho exato ou subcaminho", () => {
    const endpoints = [{ host: "openrouter.ai", pathPrefix: "/api/v1/audio/transcriptions" }];
    expect(isAllowedEndpoint(new URL("https://OpenRouter.ai/api/v1/audio/transcriptions"), endpoints)).toBe(true);
    expect(isAllowedEndpoint(new URL("https://openrouter.ai/api/v1/audio"), endpoints)).toBe(false);
  });
});
