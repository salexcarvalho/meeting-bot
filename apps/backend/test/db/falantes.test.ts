import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

// Nome dos falantes pela chamada (spec 006): migração, casamento gravado no banco e regras do nome manual.
describe.skipIf(!enabled)("nome dos falantes pela chamada (Postgres)", async () => {
  const { pool } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const transcripts = await import("../../src/repo/transcripts");
  const activity = await import("../../src/repo/speakerActivity");
  const { applyCallNames, labelUndiarized, markSegmentModeSpeakers } = await import("../../src/meetings/applyCallNames");

  const newMeeting = async (title: string) =>
    (await pool.query(`INSERT INTO meetings (title, platform, status, source) VALUES ($1, 'teams', 'done', 'bot') RETURNING id`, [title]))
      .rows[0].id as string;

  const PEOPLE: [string, string, string][] = [
    ["Speaker 1", "id:a", "Maria Souza"],
    ["Speaker 2", "id:b", "João Lima"],
    ["Speaker 3", "id:c", "Ana Costa"],
  ];

  /** Final de uma reunião com 3 vozes em rodízio e a linha do tempo da chamada correspondente. */
  async function seedMeeting(title: string, opts: { skew?: number; labels?: string[]; withTimeline?: boolean } = {}) {
    const id = await newMeeting(title);
    const segments = [];
    const intervals = [];
    let t = 10;
    for (let round = 0; round < 5; round++) {
      for (const [i, [label, key, name]] of PEOPLE.entries()) {
        segments.push({ channel: "mixed" as const, speaker: opts.labels?.[i] ?? label, text: `fala ${round}`, start: t + 0.2, end: t + 7.8 });
        intervals.push({ key, name, start: t + (opts.skew ?? 0), end: t + 8 + (opts.skew ?? 0) });
        t += 9;
      }
    }
    await transcripts.replaceWithFinal(id, segments);
    if (opts.withTimeline !== false) await activity.insertActivity(id, "teams", intervals);
    return id;
  }

  const speakersOf = async (id: string) =>
    Object.fromEntries((await transcripts.getSpeakers(id)).map((s) => [s.label, s]));

  beforeAll(async () => {
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("migração", () => {
    it("é idempotente e converte renomeações antigas em 'manual'", async () => {
      const id = await newMeeting("legado");
      await pool.query(`INSERT INTO meeting_speakers (meeting_id, label, display_name) VALUES ($1, 'Speaker 1', 'Dr. Paulo'), ($1, 'Speaker 2', 'Speaker 2'), ($1, 'user', 'Sérgio')`, [id]);
      await migrate(pool);
      await migrate(pool);
      const rows = await speakersOf(id);
      expect(rows["Speaker 1"].nameSource).toBe("manual");
      expect(rows["Speaker 2"].nameSource).toBeNull();
      expect(rows.user.nameSource).toBeNull();
    });
  });

  describe("applyCallNames", () => {
    it("nomeia os três Speaker N com origem 'call' e confiança, e não toca no microfone", async () => {
      const id = await seedMeeting("três vozes");
      await pool.query(`INSERT INTO meeting_speakers (meeting_id, label, display_name) VALUES ($1, 'user', 'Sérgio') ON CONFLICT DO NOTHING`, [id]);
      const out = await applyCallNames(id);
      expect(out).toMatchObject({ applied: 3, skipped: 0, status: "ok" });
      const rows = await speakersOf(id);
      expect(rows["Speaker 1"]).toMatchObject({ displayName: "Maria Souza", nameSource: "call" });
      expect(rows["Speaker 2"].displayName).toBe("João Lima");
      expect(rows["Speaker 1"].nameConfidence).toBeGreaterThanOrEqual(0.75);
      expect(rows.user).toMatchObject({ displayName: "Sérgio", nameSource: null });
      const meta = await activity.readTimelineMeta(id);
      expect(meta).toMatchObject({ status: "ok" });
      expect(Math.abs(meta?.skewMs ?? 999)).toBeLessThanOrEqual(150);
    });

    it("nome manual nunca é sobrescrito, mesmo reaplicando; 'voltar' libera de novo", async () => {
      const id = await seedMeeting("manual prevalece");
      await applyCallNames(id);
      const renamed = await transcripts.renameSpeaker(id, "Speaker 2", "Dr. Paulo");
      expect(renamed).toMatchObject({ displayName: "Dr. Paulo", nameSource: "manual" });
      const again = await applyCallNames(id);
      expect(again).toMatchObject({ applied: 2, skipped: 1 });
      expect((await speakersOf(id))["Speaker 2"].displayName).toBe("Dr. Paulo");

      const back = await transcripts.renameSpeaker(id, "Speaker 2", "Speaker 2");
      expect(back).toMatchObject({ displayName: "Speaker 2", nameSource: null });
      expect(await applyCallNames(id)).toMatchObject({ applied: 3 });
      expect((await speakersOf(id))["Speaker 2"]).toMatchObject({ displayName: "João Lima", nameSource: "call" });
    });

    it("retranscrição refaz os nomes da chamada com a numeração nova e mantém o manual por rótulo", async () => {
      const id = await seedMeeting("retranscrição");
      await applyCallNames(id);
      await transcripts.renameSpeaker(id, "Speaker 3", "Convidada especial");
      // a numeração mudou: antes Maria era Speaker 1; agora é Speaker 2
      const swapped = (await transcripts.getSegments(id)).map((s) => ({
        channel: s.channel,
        speaker: s.speaker === "Speaker 1" ? "Speaker 2" : s.speaker === "Speaker 2" ? "Speaker 1" : s.speaker,
        text: s.text,
        start: s.start,
        end: s.end,
      }));
      await transcripts.replaceWithFinal(id, swapped);
      let rows = await speakersOf(id);
      expect(rows["Speaker 1"]).toMatchObject({ displayName: "Speaker 1", nameSource: null });
      expect(rows["Speaker 3"]).toMatchObject({ displayName: "Convidada especial", nameSource: "manual" });
      await applyCallNames(id);
      rows = await speakersOf(id);
      expect(rows["Speaker 1"].displayName).toBe("João Lima");
      expect(rows["Speaker 2"].displayName).toBe("Maria Souza");
      expect(rows["Speaker 3"].displayName).toBe("Convidada especial");
    });

    it("duas vozes da mesma pessoa recebem o mesmo nome", async () => {
      const id = await newMeeting("dois clusters");
      const segments = [];
      const intervals = [];
      let t = 10;
      for (let i = 0; i < 8; i++) {
        segments.push({ channel: "mixed" as const, speaker: i % 2 ? "Speaker 4" : "Speaker 1", text: "x", start: t + 0.2, end: t + 7.8 });
        intervals.push({ key: "id:a", name: "Maria Souza", start: t, end: t + 8 });
        segments.push({ channel: "mixed" as const, speaker: "Speaker 2", text: "y", start: t + 9.2, end: t + 16.8 });
        intervals.push({ key: "id:b", name: "João Lima", start: t + 9, end: t + 17 });
        t += 18;
      }
      await transcripts.replaceWithFinal(id, segments);
      await activity.insertActivity(id, "meet", intervals);
      await applyCallNames(id);
      const rows = await speakersOf(id);
      expect(rows["Speaker 1"].displayName).toBe("Maria Souza");
      expect(rows["Speaker 4"].displayName).toBe("Maria Souza");
    });

    it("linha do tempo que não bate com o áudio é descartada: nenhum nome, estado parcial", async () => {
      const id = await seedMeeting("sem correlação", { skew: 600 });
      expect(await applyCallNames(id)).toMatchObject({ applied: 0, status: "partial" });
      expect(await activity.readTimelineMeta(id)).toMatchObject({ status: "partial", reason: "low_correlation" });
      expect((await speakersOf(id))["Speaker 1"].nameSource).toBeNull();
    });

    it("leitura marcada indisponível, parcial por indicador preso ou sem dados: comportamento de hoje", async () => {
      const unavailable = await seedMeeting("indisponível");
      await activity.writeTimelineMeta(unavailable, { status: "unavailable", reason: "no_tiles", people: 0, intervals: 0 });
      expect(await applyCallNames(unavailable)).toMatchObject({ applied: 0, status: "unavailable" });
      const stuck = await seedMeeting("preso");
      await activity.writeTimelineMeta(stuck, { status: "partial", reason: "stuck", people: 3, intervals: 10 });
      expect(await applyCallNames(stuck)).toMatchObject({ applied: 0, status: "partial" });
      const none = await seedMeeting("sem assistente", { withTimeline: false });
      expect(await applyCallNames(none)).toMatchObject({ applied: 0, skipped: 0 });
      expect((await speakersOf(none))["Speaker 1"].displayName).toBe("Speaker 1");
    });

    it("apagar a reunião apaga a linha do tempo junto (cascade)", async () => {
      const id = await seedMeeting("cascade");
      expect((await activity.listActivity(id)).length).toBeGreaterThan(0);
      await pool.query(`DELETE FROM meetings WHERE id = $1`, [id]);
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM speaker_activity WHERE meeting_id = $1`, [id]);
      expect(rows[0].n).toBe(0);
    });
  });

  describe("sem diarização (modo por segmento)", () => {
    it("segmentos sem rótulo do canal mixed recebem o nome dominante e viram falantes da chamada", async () => {
      const id = await newMeeting("sem diarização");
      const raw = [];
      const intervals = [];
      let t = 10;
      for (let i = 0; i < 6; i++) {
        const [, key, name] = PEOPLE[i % 2];
        raw.push({ channel: "mixed" as const, speaker: null, text: `fala ${i}`, start: t + 0.2, end: t + 7.8 });
        intervals.push({ key, name, start: t, end: t + 8 });
        t += 9;
      }
      await activity.insertActivity(id, "teams", intervals);
      const labelled = await labelUndiarized(id, raw);
      expect(labelled.segments.map((s) => s.speaker)).toEqual(["Maria Souza", "João Lima", "Maria Souza", "João Lima", "Maria Souza", "João Lima"]);
      await transcripts.replaceWithFinal(id, labelled.segments);
      await markSegmentModeSpeakers(id, labelled.names);
      const rows = await speakersOf(id);
      expect(rows["Maria Souza"]).toMatchObject({ displayName: "Maria Souza", nameSource: "call" });
    });

    it("sem dados da chamada, os segmentos continuam sem rótulo", async () => {
      const id = await newMeeting("sem dados");
      const raw = [{ channel: "mixed" as const, speaker: null, text: "oi", start: 1, end: 5 }];
      const out = await labelUndiarized(id, raw);
      expect(out.segments).toEqual(raw);
      expect(out.names).toEqual([]);
    });

    it("canais mic e remote não são mexidos", async () => {
      const id = await seedMeeting("canais", { withTimeline: true });
      const raw = [
        { channel: "mic" as const, speaker: "user", text: "a", start: 10, end: 17 },
        { channel: "remote" as const, speaker: "Remoto", text: "b", start: 19, end: 26 },
      ];
      expect((await labelUndiarized(id, raw)).segments).toEqual(raw);
    });
  });

  describe("rótulos ao vivo", () => {
    it("o passe final apaga os segmentos ao vivo com rótulo live: e eles nunca entram em meeting_speakers", async () => {
      const id = await newMeeting("ao vivo");
      await transcripts.insertLiveSegments(id, [{ channel: "mixed", speaker: "live:Maria Souza", text: "bom dia", start: 1, end: 4 }]);
      expect((await transcripts.getSpeakers(id)).map((s) => s.label)).not.toContain("live:Maria Souza");
      const live = await transcripts.getSegments(id);
      expect(transcripts.speakerNameResolver([])(live[0].speaker)).toBe("Maria Souza");
      await transcripts.replaceWithFinal(id, [{ channel: "mixed", speaker: "Speaker 1", text: "bom dia", start: 1, end: 4 }]);
      const { rows } = await pool.query(`SELECT speaker FROM transcript_segments WHERE meeting_id = $1 ORDER BY pass`, [id]);
      expect(rows).toEqual([{ speaker: "Speaker 1" }]);
      expect((await transcripts.getSpeakers(id)).map((s) => s.label)).toEqual(["Speaker 1"]);
    });
  });
});
