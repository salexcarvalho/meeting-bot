import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/security/audit", () => ({ audit: vi.fn() }));

const dir = mkdtempSync(path.join(tmpdir(), "asr-externo-"));
const wav = path.join(dir, "fala.wav");

beforeAll(() => {
  // 3 s de tom: basta para o ffmpeg gerar o Opus enviado.
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "16000", wav]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function load(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("../src/asr/openrouter");
}

describe("parse da resposta", () => {
  it("usa segments quando existem e agrupa words quando não", async () => {
    const { parseSttResponse, wordsToSegments } = await load({});
    expect(parseSttResponse({ segments: [{ start: 1, end: 2, text: " oi ", speaker: 0 }] }, 10)).toEqual([
      { start: 1, end: 2, text: "oi", speaker: "0" },
    ]);
    const words = [
      { word: "bom", start: 0, end: 0.3, speaker: 0 },
      { word: "dia", start: 0.35, end: 0.6, speaker: 0 },
      { word: "olá", start: 0.7, end: 1, speaker: 1 },
      { word: "tudo", start: 3, end: 3.2, speaker: 1 },
    ];
    expect(wordsToSegments(words)).toEqual([
      { start: 0, end: 0.6, text: "bom dia", speaker: "0" },
      { start: 0.7, end: 1, text: "olá", speaker: "1" },
      { start: 3, end: 3.2, text: "tudo", speaker: "1" },
    ]);
    expect(parseSttResponse({ text: "só texto", duration: 5 }, 10)).toEqual([
      { start: 0, end: 5, text: "só texto", speaker: null },
    ]);
  });
});

describe("configuração", () => {
  it("ASR_PROVIDER=openrouter sem ALLOW_EXTERNAL_ASR falha no boot", async () => {
    await expect(load({ ASR_PROVIDER: "openrouter" })).rejects.toThrow(/ALLOW_EXTERNAL_ASR=true/);
  });

  it("sem a flag, o status é null e a transcrição é recusada", async () => {
    const mod = await load({});
    expect(mod.externalAsrStatus()).toBeNull();
    await expect(
      mod.transcribeFileExternal("m", { path: wav, channel: "mixed", diarize: false }, { language: "pt" }, () => {}),
    ).rejects.toThrow(/desabilitado/);
  });

  it("com a flag e sem chave, fica indisponível", async () => {
    const mod = await load({ ALLOW_EXTERNAL_ASR: "true" });
    expect(mod.externalAsrStatus()).toEqual({ model: "deepgram/nova-3", available: false, isDefault: false });
  });
});

describe("transcribeFileExternal", () => {
  it("envia Opus em base64 com diarização e numera falantes", async () => {
    const mod = await load({ ALLOW_EXTERNAL_ASR: "true", OPENROUTER_API_KEY: "sk-teste", ASR_PROVIDER: "openrouter" });
    const calls: { url: string; body: Record<string, any>; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: JSON.parse(String(init.body)),
          auth: new Headers(init.headers).get("authorization"),
        });
        return Response.json({
          text: "a b",
          segments: [
            { start: 0.5, end: 1.2, text: "Bom dia.", speaker: 3 },
            { start: 1.4, end: 2.5, text: "Olá.", speaker: 1 },
            { start: 2.6, end: 2.9, text: "Tudo bem?", speaker: 3 },
          ],
          usage: { seconds: 3, cost: 0.0002 },
        });
      }),
    );
    const progress: number[] = [];
    const result = await mod.transcribeFileExternal(
      "meeting-1",
      { path: wav, channel: "remote", diarize: true },
      { language: "pt" },
      (p) => progress.push(p),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(calls[0].auth).toBe("Bearer sk-teste");
    expect(calls[0].body.model).toBe("deepgram/nova-3");
    expect(calls[0].body.input_audio.format).toBe("ogg");
    expect(Buffer.from(calls[0].body.input_audio.data, "base64").subarray(0, 4).toString()).toBe("OggS");
    expect(calls[0].body.provider).toEqual({ options: { deepgram: { diarize: true, smart_format: true } } });
    expect(result.diarized).toBe(true);
    expect(result.segments.map((s) => s.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
    expect(result.duration).toBeCloseTo(3, 0);
    expect(progress).toEqual([1]);
    expect(mod.externalAsrStatus()?.isDefault).toBe(true);
  });

  it("repete sem opções do provedor quando recusadas e falha em 401 sem repetir", async () => {
    const mod = await load({ ALLOW_EXTERNAL_ASR: "true", OPENROUTER_API_KEY: "sk-teste" });
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length === 1) return Response.json({ error: { message: "unknown option diarize" } }, { status: 400 });
        return Response.json({ text: "ok", duration: 3 });
      }),
    );
    const result = await mod.transcribeFileExternal("m", { path: wav, channel: "remote", diarize: true }, { language: "pt" }, () => {});
    expect(bodies).toHaveLength(2);
    expect(bodies[1].provider).toBeUndefined();
    expect(result.segments).toEqual([{ start: 0, end: 3, text: "ok", speaker: null }]);

    const unauthorized = vi.fn(async () => Response.json({ error: { message: "bad key" } }, { status: 401 }));
    vi.stubGlobal("fetch", unauthorized);
    await expect(
      mod.transcribeFileExternal("m", { path: wav, channel: "mic", diarize: false }, { language: "pt" }, () => {}),
    ).rejects.toThrow(/401: bad key/);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});
