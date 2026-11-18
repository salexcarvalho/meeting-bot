import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_SPEAKER_PREFIX, type Speaker } from "@meeting-bot/contracts";

// Nome ao vivo (spec 006, US3): o segmento do canal `mixed` sai com o nome de quem falava, sem tocar no banco.
const inserted = vi.hoisted(() => ({ rows: [] as { channel: string; speaker: string | null; start: number; end: number; text: string }[] }));
const published = vi.hoisted(() => ({ events: [] as { segments?: { speaker: string | null; speakerName: string | null }[] }[] }));
const worker = vi.hoisted(() => ({ segments: [] as { start: number; end: number; text: string }[] }));

vi.mock("../src/asr/workerClient", () => ({
  WorkerUnavailableError: class WorkerUnavailableError extends Error {},
  transcribeChunk: async () => ({ segments: worker.segments, speech_seconds: 10, duration: 20, elapsed: 1 }),
}));
vi.mock("../src/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../src/live/hub", () => ({ hub: { publishToMeeting: (_id: string, e: never) => published.events.push(e) } }));
vi.mock("../src/recording/glossary", () => ({ glossaryFor: async () => "" }));
vi.mock("../src/usage/liveAsr", () => ({ liveAsrUsage: { add: () => undefined, flush: () => undefined } }));
vi.mock("../src/repo/transcripts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/repo/transcripts")>()),
  getSpeakers: async (): Promise<Speaker[]> => [],
  insertLiveSegments: async (_id: string, segments: (typeof inserted.rows)[number][]) => {
    inserted.rows.push(...segments);
    return segments.map((s, i) => ({ id: i + 1, pass: "live" as const, ...s }));
  },
}));

const MEETING = "11111111-1111-1111-1111-111111111111";
const SECOND = 32_000;

async function run(channel: "mixed" | "mic" | "remote", offsetSeconds = 100) {
  const { liveSession } = await import("../src/recording/liveSession");
  const session = liveSession(MEETING, channel);
  const chunk = { offsetBytes: offsetSeconds * SECOND, pcm: Buffer.alloc(20 * SECOND), silent: false, cutAt: Date.now() };
  await (session as unknown as { process(c: typeof chunk): Promise<boolean> }).process(chunk);
}

describe("rótulo ao vivo com o nome da chamada", () => {
  beforeEach(async () => {
    inserted.rows = [];
    published.events = [];
    const { closeLiveSessions } = await import("../src/recording/liveSession");
    closeLiveSessions(MEETING);
    const { dropTimeline } = await import("../src/recording/speakerTimeline");
    dropTimeline(MEETING);
  });

  it("trecho quase todo sobre uma pessoa sai com o nome; a fala é exibida com o nome limpo", async () => {
    const { timelineFor } = await import("../src/recording/speakerTimeline");
    const timeline = timelineFor(MEETING);
    timeline.addEdge("m", "Maria Souza", true, 120);
    timeline.addEdge("m", "Maria Souza", false, 134);
    worker.segments = [{ start: 21, end: 33, text: "Bom dia a todos." }];
    await run("mixed");
    expect(inserted.rows[0].speaker).toBe(`${LIVE_SPEAKER_PREFIX}Maria Souza`);
    expect(published.events[0].segments?.[0]).toMatchObject({ speaker: "live:Maria Souza", speakerName: "Maria Souza" });
  });

  it("sem maioria (duas pessoas alternando), sai sem rótulo, como hoje", async () => {
    const { timelineFor } = await import("../src/recording/speakerTimeline");
    const timeline = timelineFor(MEETING);
    timeline.addEdge("m", "Maria", true, 121);
    timeline.addEdge("m", "Maria", false, 125);
    timeline.addEdge("j", "João", true, 125.5);
    timeline.addEdge("j", "João", false, 130);
    worker.segments = [{ start: 20, end: 40, text: "Conversa cruzada." }];
    await run("mixed");
    expect(inserted.rows[0].speaker).toBeNull();
  });

  it("sem linha do tempo, nada muda; canais mic e remote ficam intactos", async () => {
    worker.segments = [{ start: 21, end: 33, text: "Oi." }];
    await run("mixed");
    expect(inserted.rows[0].speaker).toBeNull();

    const { timelineFor } = await import("../src/recording/speakerTimeline");
    const timeline = timelineFor(MEETING);
    timeline.addEdge("m", "Maria", true, 100);
    timeline.addEdge("m", "Maria", false, 140);
    await run("mic");
    await run("remote");
    expect(inserted.rows.slice(1).map((r) => r.speaker)).toEqual(["user", "Remoto"]);
  });
});

describe("resolvedor do rótulo ao vivo", () => {
  it("remove o prefixo live: e devolve o nome; rótulo ao vivo sem nome não vira falante", async () => {
    const { speakerNameResolver } = await import("../src/repo/transcripts");
    const nameOf = speakerNameResolver([]);
    expect(nameOf("live:Maria Souza")).toBe("Maria Souza");
    expect(nameOf("live:")).toBeNull();
    expect(nameOf("Speaker 1")).toBe("Speaker 1");
    expect(nameOf(null)).toBeNull();
  });
});

describe("agente ao vivo", () => {
  it("o prompt da janela mostra o nome de quem falou (e '?' só sem nome, como hoje)", async () => {
    const { formatWindow } = await import("../src/agent/prompts");
    const { text } = formatWindow([
      { id: 1, channel: "mixed", start: 5, end: 9, speakerName: "Maria Souza", text: "Vamos aprovar o desenho." },
      { id: 2, channel: "mixed", start: 10, end: 12, speakerName: null, text: "Certo." },
    ]);
    expect(text).toContain("Maria Souza: Vamos aprovar o desenho.");
    expect(text).toContain("?: Certo.");
  });
});
