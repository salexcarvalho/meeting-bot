import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Harness, Json } from "./tarefas-harness";
import { seedUsage } from "./uso-harness";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const MONTH = "2026-01";
const ANA_TITLE = "Reunião sigilosa da Ana up-1";

// Painel do usuário: totais que fecham com as linhas, paginação, filtros e isolamento entre usuários.
describe.skipIf(!enabled)("painel de uso do usuário e isolamento (Postgres + HTTP)", async () => {
  const { startHarness } = await import("./tarefas-harness");
  let h: Harness;
  let anaMeeting: string;
  let biaMeeting: string;

  const me = (who: string, query = "") => h.call(who, "GET", `/usage/me?month=${MONTH}${query}`);

  beforeAll(async () => {
    h = await startHarness([
      ["up-ana", "USER", "Ana"],
      ["up-bia", "USER", "Bia"],
      ["up-leo", "VIEWER", "Leo"],
    ]);
    anaMeeting = await h.seedMeeting("up-ana", { title: ANA_TITLE });
    biaMeeting = await h.seedMeeting("up-bia", { title: "Reunião da Bia up-2" });
    const ana = h.ids["up-ana"];
    const bia = h.ids["up-bia"];
    const m = anaMeeting;
    await seedUsage(h.pool, { at: "2026-01-10T12:00:00Z", user: ana, meeting: m, purpose: "ata", provider: "openrouter", model: "anthropic/claude-sonnet-5", input: 1000, output: 200, cost: 0.05, duration: 4000 });
    await seedUsage(h.pool, { at: "2026-01-10T13:00:00Z", user: ana, meeting: m, purpose: "itens", provider: "ollama", model: "qwen", input: 500, output: 50, compute: 3000, duration: 3500 });
    // 02:00Z de 11/01 ainda é 23:00 do dia 10 em São Paulo: o agrupamento por dia usa o fuso da aplicação
    await seedUsage(h.pool, { at: "2026-01-11T02:00:00Z", user: ana, meeting: m, purpose: "ata", provider: "claude", model: "claude-sonnet-5", input: 2000, output: 100, duration: 9000 });
    await seedUsage(h.pool, { at: "2026-01-11T09:00:00Z", user: ana, meeting: m, purpose: "ata", provider: "openrouter", success: false, error: "http_402", duration: 300 });
    await seedUsage(h.pool, { at: "2026-01-12T09:00:00Z", user: ana, meeting: m, category: "asr", purpose: "asr_final", provider: "deepgram", model: "deepgram/nova-3", audio: 600, cost: 0.01, duration: 2000 });
    await seedUsage(h.pool, { at: "2026-01-12T10:00:00Z", user: ana, meeting: m, category: "asr", purpose: "asr_final", provider: "whisper", audio: 1800, compute: 100000, duration: 120000 });
    // fora do período (um dia antes do mês) e de outro usuário
    await seedUsage(h.pool, { at: "2026-01-01T01:00:00Z", user: ana, meeting: m, purpose: "ata", input: 99999, output: 1 });
    await seedUsage(h.pool, { at: "2026-01-10T12:00:00Z", user: bia, meeting: biaMeeting, purpose: "ata", input: 7, output: 1, cost: 0.5 });
    // da instância (sem dono)
    await seedUsage(h.pool, { at: "2026-01-10T12:00:00Z", purpose: "outro", input: 4242, output: 1 });
    // a reunião da Ana é compartilhada com a Bia: o consumo continua sendo da Ana
    await h.share(anaMeeting, "up-bia", "read");
  });

  afterAll(async () => {
    await h.stop();
  });

  it("totais do período fecham com a soma das linhas (SC-002) e custo nulo não vira zero", async () => {
    const res = await me("up-ana");
    expect(res.status).toBe(200);
    expect(res.json.period.month).toBe(MONTH);
    expect(res.json.totals).toMatchObject({
      calls: 6,
      failedCalls: 1,
      inputTokens: 3500,
      outputTokens: 350,
      pricedCalls: 2,
      audioSeconds: 2400,
      durationMs: 138800,
      computeMs: 103000,
    });
    expect(res.json.totals.costUsd).toBeCloseTo(0.06, 8);
    expect(res.json.retention).toEqual({ usageDays: 730, auditDays: 365 });
  });

  it("a soma de cada agrupamento é igual ao total", async () => {
    const { json } = await me("up-ana");
    for (const groups of ["byPurpose", "byProvider", "byModel", "byDay"]) {
      const sum = (key: string) => (json[groups] as Json[]).reduce((s, g) => s + g[key], 0);
      expect(sum("calls"), groups).toBe(json.totals.calls);
      expect(sum("inputTokens"), groups).toBe(json.totals.inputTokens);
      expect(sum("audioSeconds"), groups).toBe(json.totals.audioSeconds);
      expect(sum("failedCalls"), groups).toBe(json.totals.failedCalls);
    }
    expect(json.byPurpose.map((g: Json) => g.key).sort()).toEqual(["asr_final", "ata", "itens"]);
    expect(json.byProvider.find((g: Json) => g.key === "claude")).toMatchObject({ label: "Claude (assinatura)", costUsd: null, inputTokens: 2000 });
  });

  it("agrupa por dia no fuso da aplicação (23h de São Paulo ainda é o dia 10)", async () => {
    const { json } = await me("up-ana");
    const day10 = json.byDay.find((g: Json) => g.key === "2026-01-10");
    expect(day10).toMatchObject({ label: "10/01", calls: 3, inputTokens: 3500 });
    expect(json.byDay.map((g: Json) => g.key)).toEqual(["2026-01-10", "2026-01-11", "2026-01-12"]);
  });

  it("ASR: minutos locais × externos, custo só no externo", async () => {
    const { json } = await me("up-ana");
    expect(json.asr.local).toEqual({ audioSeconds: 1800, computeMs: 100000, calls: 1 });
    expect(json.asr.external.audioSeconds).toBe(600);
    expect(json.asr.external.calls).toBe(1);
    expect(json.asr.external.costUsd).toBeCloseTo(0.01, 8);
  });

  it("reuniões que mais consumiram: só as dele, com o título dele", async () => {
    const { json } = await me("up-ana");
    expect(json.topMeetings).toHaveLength(1);
    expect(json.topMeetings[0]).toMatchObject({ meetingId: anaMeeting, title: ANA_TITLE, calls: 6 });
  });

  it("lista de chamadas pagina por cursor sem repetir nem pular", async () => {
    const seen: number[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const res = await h.call("up-ana", "GET", `/usage/me/calls?month=${MONTH}&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.json.items.map((c: Json) => c.id));
      if (!res.json.nextCursor) break;
      cursor = encodeURIComponent(res.json.nextCursor);
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    const first = await h.call("up-ana", "GET", `/usage/me/calls?month=${MONTH}&limit=100`);
    expect(first.json.items.map((c: Json) => c.id)).toEqual(seen);
    expect(first.json.items[0].at > first.json.items[5].at).toBe(true);
    expect(first.json.items.find((c: Json) => c.errorCode)).toMatchObject({ success: false, errorCode: "http_402", meetingTitle: ANA_TITLE });
  });

  it("filtros de falha, finalidade e provedor", async () => {
    const base = `/usage/me/calls?month=${MONTH}`;
    const errors = await h.call("up-ana", "GET", `${base}&status=error`);
    expect(errors.json.items).toHaveLength(1);
    expect(errors.json.items[0].errorCode).toBe("http_402");
    expect((await h.call("up-ana", "GET", `${base}&status=ok`)).json.items).toHaveLength(5);
    expect((await h.call("up-ana", "GET", `${base}&purpose=itens`)).json.items).toHaveLength(1);
    expect((await h.call("up-ana", "GET", `${base}&provider=deepgram`)).json.items[0]).toMatchObject({ category: "asr", audioSeconds: 600 });
  });

  it("período, filtro e cursor inválidos dão 400", async () => {
    expect((await h.call("up-ana", "GET", "/usage/me?month=2026-13")).status).toBe(400);
    expect((await h.call("up-ana", "GET", `/usage/me?month=${MONTH}&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`)).status).toBe(400);
    expect((await h.call("up-ana", "GET", "/usage/me?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z")).status).toBe(400);
    expect((await h.call("up-ana", "GET", "/usage/me?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z")).status).toBe(400);
    expect((await h.call("up-ana", "GET", `/usage/me/calls?month=${MONTH}&status=talvez`)).status).toBe(400);
    expect((await h.call("up-ana", "GET", `/usage/me/calls?month=${MONTH}&cursor=lixo`)).status).toBe(400);
    expect((await h.call("up-ana", "GET", `/usage/me/calls?month=${MONTH}&limit=101`)).status).toBe(400);
  });

  it("intervalo livre inclui só o que cai nele", async () => {
    const res = await h.call("up-ana", "GET", "/usage/me?from=2026-01-10T00:00:00Z&to=2026-01-11T00:00:00Z");
    expect(res.json.period.month).toBeNull();
    expect(res.json.totals.calls).toBe(2);
  });

  it("período sem consumo devolve tudo zerado (estado vazio)", async () => {
    const res = await h.call("up-ana", "GET", "/usage/me?month=2025-06");
    expect(res.json.totals).toMatchObject({ calls: 0, inputTokens: 0, costUsd: null, computeMs: null, audioSeconds: 0 });
    expect(res.json.byDay).toEqual([]);
    expect(res.json.topMeetings).toEqual([]);
  });

  describe("isolamento entre usuários (SC-003)", () => {
    it("a Bia vê só o que é dela, mesmo com a reunião da Ana compartilhada", async () => {
      const bia = await me("up-bia");
      expect(bia.json.totals).toMatchObject({ calls: 1, inputTokens: 7 });
      expect(bia.json.topMeetings.map((t: Json) => t.meetingId)).toEqual([biaMeeting]);
      const text = JSON.stringify(bia.json);
      expect(text).not.toContain(ANA_TITLE);
      expect(text).not.toContain(anaMeeting);
      const calls = await h.call("up-bia", "GET", `/usage/me/calls?month=${MONTH}`);
      expect(calls.json.items.map((c: Json) => c.meetingId)).toEqual([biaMeeting]);
      expect(JSON.stringify(calls.json)).not.toContain(ANA_TITLE);
    });

    it("a Ana não vê a Bia nem a instância", async () => {
      const ana = await me("up-ana");
      expect(ana.json.totals.inputTokens).toBe(3500);
      expect(JSON.stringify(ana.json)).not.toContain("Reunião da Bia");
    });

    it("leitor sem consumo recebe zeros", async () => {
      const leo = await me("up-leo");
      expect(leo.status).toBe(200);
      expect(leo.json.totals.calls).toBe(0);
    });

    it("parâmetro extra userId e caixa alta na URL não abrem dados de outro usuário", async () => {
      const spoof = await me("up-bia", `&userId=${h.ids["up-ana"]}&user_id=${h.ids["up-ana"]}`);
      expect(spoof.json.totals.calls).toBe(1);
      expect((await h.call("up-bia", "GET", `/USAGE/ME?month=${MONTH}`)).status).toBe(404);
      expect((await h.call(null, "GET", `/usage/me?month=${MONTH}`)).status).toBe(401);
    });

    it("mutação: sem o filtro user_id o isolamento é violado e o teste percebe", async () => {
      const { userScope } = await import("../../src/usage/queries");
      const { totals } = await import("../../src/usage/aggregate");
      const period = { from: new Date("2026-01-01T03:00:00Z"), to: new Date("2026-02-01T03:00:00Z"), month: MONTH };
      const real = await totals(userScope(h.ids["up-bia"], period));
      expect(real.calls).toBe(1);
      const mutated = { ...userScope(h.ids["up-bia"], period), where: "$1::uuid IS NOT NULL AND l.at >= $2 AND l.at < $3" };
      const leaked = await totals(mutated);
      expect(leaked.calls).toBeGreaterThan(1);
      expect(() => expect(leaked.calls).toBe(1)).toThrow();
    });
  });
});
