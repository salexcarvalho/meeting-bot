import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TOKEN = "teste-".repeat(8);
const SOURCE = "aurora-outlook";
const DAY = "2031-03-10";
const OTHER_DAY = "2031-03-11";
// 02:30Z do dia 11 = 23:30 do dia 10 em São Paulo (UTC-3)
const NOITE = { start: "2031-03-11T02:30:00Z", end: "2031-03-11T03:00:00Z" };
const teamsLink = (n: string) => `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${n}%40thread.v2/0`;

// Agenda enviada pela Aurora (POST /api/agent/calendar/import), em nome do dono do agente.
describe.skipIf(!enabled)("importação da agenda pela Aurora (HTTP + Postgres)", async () => {
  vi.stubEnv("AGENT_OWNER", "au-dono");

  const { pool, createUser } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { hashPassword } = await import("../../src/auth");
  const { createApp } = await import("../../src/app");
  const { invalidateHostOwner } = await import("../../src/recording/owner");
  const { createScheduled, cancelScheduled, setSkip, importIcs } = await import("../../src/calendar/service");

  const servers: Server[] = [];
  let owner = "";
  let outro = "";

  // Cada servidor tem o próprio limite de taxa: o teste de limite não atrapalha os demais.
  async function serve(): Promise<string> {
    const server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const send = (base: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}/api/agent/calendar/import`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> }));

  const hour = (day: string, h: number) => `${day}T${String(h).padStart(2, "0")}:00:00-03:00`;
  const ev = (uid: string, h: number, extra: Record<string, unknown> = {}) => ({
    uid, title: `Reunião ${uid}`, start: hour(DAY, h), end: hour(DAY, h + 1), ...extra,
  });
  const payload = (events: unknown[], date = DAY) => ({ source: SOURCE, date, events });

  // Reuniões da origem de um dia (UTC-3, sem horário de verão em 2031).
  async function auroraRows(day: string) {
    const { rows } = await pool.query(
      `SELECT id, title, status, platform, url, source, ical_uid, recurrence_key, skip_recording, extract_items,
              import_source, import_removed_at, created_by
         FROM meetings
        WHERE import_source = $1 AND scheduled_start >= $2::timestamptz AND scheduled_start < $2::timestamptz + interval '1 day'
        ORDER BY scheduled_start`,
      [SOURCE, `${day}T00:00:00-03:00`],
    );
    return rows;
  }
  const byUid = <T extends { ical_uid: string }>(rows: T[], uid: string): T => rows.find((r) => r.ical_uid === uid)!;
  const countAll = async () => (await pool.query(`SELECT count(*)::int AS n FROM meetings`)).rows[0].n as number;

  beforeAll(async () => {
    await migrate(pool);
    const hash = await hashPassword("senha-forte-123");
    owner = (await createUser("au-dono", hash, { role: "SUPER_ADMIN" })).id;
    outro = (await createUser("au-outra", hash, { role: "USER" })).id;
    invalidateHostOwner();
  });

  afterAll(async () => {
    servers.forEach((s) => s.close());
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("sem token ou com token errado: 401, e o errado fica no audit_log", async () => {
    const base = await serve();
    const failures = async () =>
      (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE kind = 'agent_auth_failed'`)).rows[0].n as number;
    const before = await failures();
    const total = await countAll();

    expect((await send(base, payload([ev("x", 9)]), null)).status).toBe(401);
    expect((await send(base, payload([ev("x", 9)]), "token-errado-".repeat(4))).status).toBe(401);

    await vi.waitFor(async () => expect(await failures()).toBe(before + 2));
    expect(await countAll()).toBe(total);
  });

  it("rejeita corpo inválido: mais de 100 eventos, origem desconhecida, data impossível, sem lista", async () => {
    const base = await serve();
    const total = await countAll();
    const many = Array.from({ length: 101 }, (_, i) => ev(`m${i}`, 9));

    const tooMany = await send(base, payload(many));
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.json)).toMatch(/100 eventos/);
    expect((await send(base, { ...payload([]), source: "outra" })).status).toBe(400);
    expect((await send(base, payload([], "2031-02-31"))).status).toBe(400);
    expect((await send(base, { source: SOURCE, date: DAY })).status).toBe(400);
    expect((await send(base, { ...payload([]), confirmEmpty: "sim" })).status).toBe(400);
    expect(await countAll()).toBe(total);
  });

  it("importa no nome do dono, é idempotente e usa o fuso da aplicação para definir o dia", async () => {
    const base = await serve();
    // 02:30Z do dia 11 = 23:30 do dia 10 em São Paulo
    const lateNight = ev("noite", 23, NOITE);
    const body = payload([ev("a", 9, { teams: teamsLink("a1"), organizer: "Ana" }), ev("b", 14, { location: "Sala 3" }), lateNight]);

    const first = await send(base, body);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ source: SOURCE, date: DAY, created: 3, updated: 0, removed: 0, unchanged: 0 });

    const rows = await auroraRows(DAY);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.created_by === owner && r.source === "ics" && r.status === "scheduled")).toBe(true);
    expect(byUid(rows, "a")).toMatchObject({ platform: "teams", url: teamsLink("a1"), skip_recording: false, extract_items: false });
    expect(byUid(rows, "a").recurrence_key).toBe(""); // evento único: mesma chave do .ics

    const total = await countAll();
    const second = await send(base, body);
    expect(second.json).toMatchObject({ created: 0, updated: 0, removed: 0, unchanged: 3 });
    expect(await countAll()).toBe(total);
    expect((await auroraRows(DAY)).map((r) => r.id)).toEqual(rows.map((r) => r.id));

    const audited = await pool.query(`SELECT detail, user_id FROM audit_log WHERE kind = 'agent_calendar_import' ORDER BY id DESC LIMIT 1`);
    expect(audited.rows[0].user_id).toBe(owner);
    expect(audited.rows[0].detail).toMatchObject({ source: SOURCE, date: DAY, mode: "events", unchanged: 3 });
    expect(JSON.stringify(audited.rows[0].detail)).not.toContain("Reunião");
  });

  it("reimportar atualiza dados sem desfazer o que o usuário escolheu na reunião", async () => {
    const base = await serve();
    const before = await auroraRows(DAY);
    const a = byUid(before, "a");
    await setSkip(a.id, true); // "Não gravar"
    await pool.query(`UPDATE meetings SET extract_items = true WHERE id = $1`, [a.id]);

    const res = await send(base, payload([ev("a", 9, { title: "Reunião a (renomeada)", teams: teamsLink("a1") }), ev("b", 14), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ created: 0, updated: 1 });

    const after = byUid(await auroraRows(DAY), "a");
    expect(after.id).toBe(a.id);
    expect(after.title).toBe("Reunião a (renomeada)");
    expect(after).toMatchObject({ status: "skipped", skip_recording: true, extract_items: true });
    // campos que o envio deixou vazio (local da reunião b) não são apagados
    expect(byUid(await auroraRows(DAY), "b")).toMatchObject({ title: "Reunião b" });
    const loc = await pool.query(`SELECT location FROM meetings WHERE ical_uid = 'b' AND created_by = $1`, [owner]);
    expect(loc.rows[0].location).toBe("Sala 3");
  });

  it("evento que sumiu da lista é cancelado; outro dia, reunião manual e cancelamento do usuário ficam intactos", async () => {
    const base = await serve();
    // evento de outro dia, enviado no próprio dia
    const otherDay = { uid: "outro-dia", title: "Outro dia", start: hour(OTHER_DAY, 10), end: hour(OTHER_DAY, 11) };
    expect((await send(base, payload([otherDay], OTHER_DAY))).status).toBe(200);

    const manual = await createScheduled({ title: "Manual", start: hour(DAY, 16), durationMinutes: 30, skipRecording: false }, owner);
    const before = await auroraRows(DAY);
    const b = byUid(before, "b");
    // "a" e "noite" ficam; "b" some
    const res = await send(base, payload([ev("a", 9), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ removed: 1, created: 0 });

    const after = await auroraRows(DAY);
    expect(byUid(after, "b")).toMatchObject({ id: b.id, status: "cancelled" });
    expect(byUid(after, "b").import_removed_at).not.toBeNull();
    expect(byUid(after, "a").status).toBe("skipped");
    expect(byUid(await auroraRows(OTHER_DAY), "outro-dia").status).toBe("scheduled");
    expect((await pool.query(`SELECT status FROM meetings WHERE id = $1`, [manual.id])).rows[0].status).toBe("scheduled");

    // lista vazia confirmada no dia seguinte cancela só o que é da origem naquele dia
    const empty = await send(base, { ...payload([], OTHER_DAY), confirmEmpty: true });
    expect(empty.json).toMatchObject({ removed: 1 });
    expect((await pool.query(`SELECT status FROM meetings WHERE id = $1`, [manual.id])).rows[0].status).toBe("scheduled");
    expect(byUid(await auroraRows(DAY), "a").status).toBe("skipped");
  });

  it("evento que volta à lista reativa; cancelamento feito pelo usuário continua cancelado", async () => {
    const base = await serve();
    const rows = await auroraRows(DAY);
    // o usuário cancela "noite" pela interface
    await cancelScheduled(byUid(rows, "noite").id, "one");

    const res = await send(base, payload([ev("a", 9), ev("b", 14), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ created: 0, updated: 1 });

    const after = await auroraRows(DAY);
    expect(byUid(after, "b").status).toBe("scheduled");
    expect(byUid(after, "b").import_removed_at).toBeNull();
    expect(byUid(after, "a").status).toBe("skipped"); // "Não gravar" preservado
    expect(byUid(after, "noite").status).toBe("cancelled");
    expect(byUid(after, "noite").import_removed_at).toBeNull();
  });

  it("status cancelado no envio cancela o evento existente e não cria um novo", async () => {
    const base = await serve();
    const total = await countAll();
    const res = await send(base, payload([ev("a", 9, { status: "cancelled" }), ev("b", 14), ev("novo-cancelado", 18, { status: "canceled" }), ev("noite", 23, NOITE)]));
    expect(res.json).toMatchObject({ cancelled: 1, ignored: 1, created: 0 });
    expect(await countAll()).toBe(total);
    expect(byUid(await auroraRows(DAY), "a").status).toBe("cancelled");
  });

  it("aceita .ics no lugar da lista de eventos e reconhece evento único já importado do mesmo uid", async () => {
    const base = await serve();
    const ICS_DAY = "2031-03-12";
    const ics = (uid: string, summary: string, start: string, end: string) =>
      ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//teste//PT", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:20310301T120000Z`,
        `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

    // 09:00-03:00 = 12:00Z; o .ics importado antes pela tela (chave de recorrência vazia) não pode duplicar
    const imp = await importIcs([{ name: "antes.ics", text: ics("ics-1@teste", "Do .ics", "20310312T120000Z", "20310312T130000Z") }], owner);
    expect(imp.created).toBe(1);
    const before = await countAll();
    const res = await send(base, { source: SOURCE, date: ICS_DAY, ics: ics("ics-1@teste", "Do .ics", "20310312T120000Z", "20310312T130000Z") });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: 0, removed: 0, unchanged: 1 });
    expect(await countAll()).toBe(before);

    const novo = await send(base, { source: SOURCE, date: ICS_DAY, ics: ics("ics-2@teste", "Outro .ics", "20310312T180000Z", "20310312T190000Z") });
    expect(novo.json).toMatchObject({ created: 1 });

    // a reunião vinda da tela não é da origem Aurora: o envio não a cancela
    const manual = await pool.query(`SELECT status, import_source FROM meetings WHERE ical_uid = 'ics-1@teste' AND created_by = $1`, [owner]);
    expect(manual.rows[0]).toMatchObject({ status: "scheduled", import_source: null });
    await send(base, { ...payload([], ICS_DAY), confirmEmpty: true });
    expect((await pool.query(`SELECT status FROM meetings WHERE ical_uid = 'ics-1@teste' AND created_by = $1`, [owner])).rows[0].status).toBe("scheduled");
  });

  const icsOf = (uid: string, summary: string, start: string, end: string, extra: string[] = []) =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//teste//PT", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20310301T120000Z",
      `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, ...extra, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  const rowOf = async (uid: string) =>
    (await pool.query(`SELECT id, status, title, ical_sequence, recurrence_key FROM meetings WHERE ical_uid = $1 AND created_by = $2`, [uid, owner])).rows;
  const lastFailure = async () =>
    (await pool.query(`SELECT detail, user_id FROM audit_log WHERE kind = 'agent_calendar_import_failed' ORDER BY id DESC LIMIT 1`)).rows[0];

  it("convite de .ics com sequência > 0 é atualizado e cancelado pela Aurora sem rebaixar a sequência", async () => {
    const base = await serve();
    const day = "2031-03-13"; // 09:00-03:00 = 12:00Z
    await importIcs([{ name: "seq.ics", text: icsOf("seq@teste", "Convite", "20310313T120000Z", "20310313T130000Z", ["SEQUENCE:3"]) }], owner);
    expect((await rowOf("seq@teste"))[0]).toMatchObject({ ical_sequence: 3, status: "scheduled" });

    const renamed = await send(base, payload([{ uid: "seq@teste", title: "Convite renomeado", start: hour(day, 9), end: hour(day, 10) }], day));
    expect(renamed.json).toMatchObject({ updated: 1, unchanged: 0, created: 0 });
    expect((await rowOf("seq@teste"))[0]).toMatchObject({ title: "Convite renomeado", ical_sequence: 3, status: "scheduled" });

    const cancel = await send(base, payload([{ uid: "seq@teste", title: "Convite renomeado", start: hour(day, 9), end: hour(day, 10), status: "cancelled" }], day));
    expect(cancel.json).toMatchObject({ cancelled: 1 });
    expect((await rowOf("seq@teste"))[0]).toMatchObject({ status: "cancelled", ical_sequence: 3 });
  });

  it("evento da Aurora importado depois como .ics não duplica (e a série marcada usa o início como chave)", async () => {
    const base = await serve();
    const day = "2031-03-14";
    expect((await send(base, payload([{ uid: "au-ics@teste", title: "Pela Aurora", start: hour(day, 9), end: hour(day, 10) }], day))).json).toMatchObject({ created: 1 });
    const before = await countAll();

    const imp = await importIcs([{ name: "depois.ics", text: icsOf("au-ics@teste", "Pela Aurora", "20310314T120000Z", "20310314T130000Z") }], owner);
    expect(imp.created).toBe(0);
    expect(await countAll()).toBe(before);
    expect(await rowOf("au-ics@teste")).toHaveLength(1);

    // ocorrência de série: chave = início em ISO, idempotente
    const serie = { uid: "serie@teste", title: "Série", start: hour(day, 15), end: hour(day, 16), recurring: true };
    expect((await send(base, payload([serie], day))).json).toMatchObject({ created: 1 });
    expect((await send(base, payload([serie], day))).json).toMatchObject({ created: 0, unchanged: 1 });
    expect((await rowOf("serie@teste"))[0].recurrence_key).toBe(new Date(hour(day, 15)).toISOString());
  });

  it("evento único sem a marca de série não puxa a reunião de outro dia com o mesmo uid", async () => {
    const base = await serve();
    const d1 = "2031-03-17";
    const d2 = "2031-03-18";
    const e = (day: string) => ({ uid: "repete@teste", title: "Repete", start: hour(day, 9), end: hour(day, 10) });
    await send(base, payload([e(d1)], d1));
    expect((await send(base, payload([e(d2)], d2))).json).toMatchObject({ created: 1, updated: 0 });
    expect(await rowOf("repete@teste")).toHaveLength(2);
  });

  it("não cancela por sumiço reunião passada, perdida, em andamento ou já gravada", async () => {
    const base = await serve();
    const day = "2031-03-19";
    const uids = ["fut-sched", "fut-missed", "fut-recording", "fut-done", "fut-transcribing", "fut-queued"];
    await send(base, payload([...uids, "keep"].map((u, i) => ({ uid: u, title: u, start: hour(day, 8 + i), end: hour(day, 9 + i) })), day));
    for (const [u, st] of [["fut-missed", "missed"], ["fut-recording", "recording"], ["fut-done", "done"], ["fut-transcribing", "transcribing"], ["fut-queued", "queued"]]) {
      await pool.query(`UPDATE meetings SET status = $1 WHERE ical_uid = $2 AND created_by = $3`, [st, u, owner]);
    }
    const res = await send(base, { source: SOURCE, date: day, events: [{ uid: "keep", title: "keep", start: hour(day, 14), end: hour(day, 15) }] });
    expect(res.json).toMatchObject({ removed: 1 }); // só a "fut-sched" (agendada, futura)
    const status = async (u: string) => (await rowOf(u))[0].status;
    const seen: Record<string, string> = {};
    for (const u of uids) seen[u] = await status(u);
    // o banco é compartilhado com outros arquivos de teste: não deixa reunião "em andamento" para trás
    await pool.query(`UPDATE meetings SET status = 'done' WHERE ical_uid = ANY($1) AND status IN ('recording', 'transcribing', 'queued')`, [uids]);
    expect(seen["fut-sched"]).toBe("cancelled");
    expect(seen["fut-missed"]).toBe("missed");
    expect(seen["fut-recording"]).toBe("recording");
    expect(seen["fut-done"]).toBe("done");
    expect(seen["fut-transcribing"]).toBe("transcribing");
    expect(seen["fut-queued"]).toBe("queued");
  });

  it("dia passado: reuniões sumidas da lista ficam como estão", async () => {
    const base = await serve();
    const past = "2020-05-04";
    const e = (uid: string, h: number) => ({ uid, title: uid, start: hour(past, h), end: hour(past, h + 1) });
    await send(base, payload([e("p1", 9), e("p2", 11)], past));
    // mesmo marcada como agendada, o início já passou: não é cancelada
    await pool.query(`UPDATE meetings SET status = 'scheduled' WHERE ical_uid = 'p2' AND created_by = $1`, [owner]);
    const res = await send(base, payload([e("p1", 9)], past));
    expect(res.json).toMatchObject({ removed: 0 });
    expect((await rowOf("p1"))[0].status).toBe("missed");
    expect((await rowOf("p2"))[0].status).toBe("scheduled");
  });

  it("lista vazia só cancela o dia com confirmEmpty; sem ele devolve 200 com aviso e não remove nada", async () => {
    const base = await serve();
    const day = "2031-03-20";
    await send(base, payload([{ uid: "vz1", title: "Vazio 1", start: hour(day, 9), end: hour(day, 10) }], day));

    const semConfirmar = await send(base, payload([], day));
    expect(semConfirmar.status).toBe(200);
    expect(semConfirmar.json).toMatchObject({ removed: 0, created: 0, updated: 0, cancelled: 0, removalSkipped: "empty_without_confirm" });
    expect((await rowOf("vz1"))[0].status).toBe("scheduled");

    const falso = await send(base, { ...payload([], day), confirmEmpty: false });
    expect(falso.json).toMatchObject({ removed: 0, removalSkipped: "empty_without_confirm" });

    // .ics sem eventos também conta como lista vazia
    const icsVazio = await send(base, { source: SOURCE, date: day, ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//PT\r\nEND:VCALENDAR\r\n" });
    expect(icsVazio.json).toMatchObject({ removed: 0, removalSkipped: "empty_without_confirm" });
    expect((await rowOf("vz1"))[0].status).toBe("scheduled");

    const confirmada = await send(base, { ...payload([], day), confirmEmpty: true });
    expect(confirmada.json).toMatchObject({ removed: 1 });
    expect(confirmada.json.removalSkipped).toBeUndefined();
    expect((await rowOf("vz1"))[0].status).toBe("cancelled");
  });

  it("evento fora do dia é ignorado sem derrubar os outros, e seu uid protege a linha existente", async () => {
    const base = await serve();
    const day = "2031-03-21";
    const other = "2031-03-22";
    const e = (uid: string, d: string, h: number) => ({ uid, title: `Evento ${uid}`, start: hour(d, h), end: hour(d, h + 1) });
    await send(base, payload([e("fz-a", day, 9), e("fz-b", day, 11)], day));

    // fz-b veio com o dia trocado (fuso errado): ignorado, e a linha existente de fz-b não é cancelada
    const res = await send(base, payload([e("fz-a", day, 9), e("fz-b", other, 11), e("fz-c", day, 15)], day));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: 1, unchanged: 1, ignored: 1, removed: 0, ignoredEvents: [{ uid: "fz-b", reason: "outside_date" }] });
    expect((await rowOf("fz-b"))[0].status).toBe("scheduled");
    expect(await rowOf("fz-c")).toHaveLength(1);

    // todos com o dia trocado: não conta como lista vazia e não remove nenhuma linha desses uids
    const todos = await send(base, payload([e("fz-a", other, 9), e("fz-b", other, 11), e("fz-c", other, 15)], day));
    expect(todos.json).toMatchObject({ created: 0, ignored: 3, removed: 0 });
    expect(todos.json.removalSkipped).toBeUndefined();
    expect((await rowOf("fz-a"))[0].status).toBe("scheduled");
  });

  it("falhas do envio vão para o audit_log só com motivo e contagens, e o erro de .ics tem mensagem fixa", async () => {
    const base = await serve();
    const segredo = "Título Confidencial XPTO";

    const invalid = await send(base, { source: SOURCE, date: DAY, events: [{ uid: "z", title: segredo, start: "sem-data", end: "x" }] });
    expect(invalid.status).toBe(400);
    await vi.waitFor(async () => expect((await lastFailure()).detail).toMatchObject({ reason: "invalid_body" }));
    const f1 = await lastFailure();
    expect(f1.detail).toMatchObject({ reason: "invalid_body", mode: "events", events: 1, field: "events.0.start" });
    expect(JSON.stringify(f1.detail)).not.toContain("Confidencial");

    const badIcs = await send(base, { source: SOURCE, date: DAY, ics: `${segredo} não é calendário` });
    expect(badIcs.status).toBe(400);
    expect(badIcs.json).toEqual({ error: "Arquivo .ics inválido." });
    await vi.waitFor(async () => expect((await lastFailure()).detail).toMatchObject({ reason: "rejected" }));
    const f2 = await lastFailure();
    expect(f2).toMatchObject({ user_id: owner, detail: { reason: "rejected", mode: "ics", status: 400 } });
    expect(JSON.stringify(f2.detail)).not.toContain("Confidencial");
  });

  it("sem dono do agente: 503 e falha auditada", async () => {
    const base = await serve();
    await pool.query(`UPDATE users SET active = false WHERE id = $1`, [owner]);
    invalidateHostOwner();
    try {
      const total = await countAll();
      const res = await send(base, payload([{ uid: "sd", title: "Sem dono", start: hour(DAY, 9), end: hour(DAY, 10) }]));
      expect(res.status).toBe(503);
      expect(res.json.error).toMatch(/AGENT_OWNER/);
      expect(await countAll()).toBe(total);
      await vi.waitFor(async () => expect((await lastFailure()).detail).toMatchObject({ reason: "no_owner", events: 1 }));
      expect(JSON.stringify((await lastFailure()).detail)).not.toContain("Sem dono");
    } finally {
      await pool.query(`UPDATE users SET active = true WHERE id = $1`, [owner]);
      invalidateHostOwner();
    }
  });

  it("corpo acima do limite do servidor responde 413 com mensagem clara", async () => {
    const base = await serve();
    const res = await send(base, { source: SOURCE, date: DAY, ics: "x".repeat(300_000) });
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: "Corpo da requisição excede o limite." });
  });

  it("nunca grava para outro usuário além do dono do agente", async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE import_source = $1 AND created_by <> $2`, [SOURCE, owner]);
    expect(rows[0].n).toBe(0);
    expect(outro).not.toBe(owner);
  });

  it("limita a taxa de envios", async () => {
    const base = await serve();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await send(base, payload([], "2031-04-01"))).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
