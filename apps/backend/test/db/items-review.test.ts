import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ValidItem } from "../../src/agent/evidence";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("revisão de itens e ADRs (Postgres)", async () => {
  const { pool } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const service = await import("../../src/items/service");
  const transcripts = await import("../../src/repo/transcripts");
  const { evidenceRemapper } = await import("../../src/agent/module");

  let userId = "";
  let meetingId = "";
  let liveSegment = 0;

  const aiItem = (description: string, over: Partial<ValidItem> = {}): ValidItem => ({
    type: "decisao",
    description,
    owner: null,
    due: null,
    attributes: {},
    evidence: [{ segmentId: liveSegment, start: 10, end: 14, channel: "remote", quote: "trecho" }],
    ...over,
  });

  const history = async (itemId: string) => (await service.getHistory(itemId))!;

  beforeAll(async () => {
    await migrate(pool);
    const u = await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ('revisor', 'x') RETURNING id`,
    );
    userId = u.rows[0].id;
    const m = await pool.query(
      `INSERT INTO meetings (title, platform, status, source) VALUES ('Teste', 'none', 'done', 'manual') RETURNING id`,
    );
    meetingId = m.rows[0].id;
    const [seg] = await transcripts.insertLiveSegments(meetingId, [
      { channel: "remote", speaker: "Remoto", text: "vamos usar filas na integração", start: 10, end: 14 },
    ]);
    liveSegment = seg.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("cria item de IA proposto com evidência e histórico; sem evidência não cria", async () => {
    const res = await service.createAiItems(meetingId, [aiItem("Usar filas na integração com o SUS"), aiItem("Sem prova", { evidence: [] })], "live");
    expect(res).toEqual({ created: 1, merged: 0 });
    const [item] = await service.listItems(meetingId);
    expect(item.reviewStatus).toBe("proposto");
    expect(item.origin).toBe("live");
    expect(item.evidence).toEqual([{ segmentId: liveSegment, start: 10, end: 14, channel: "remote", quote: "trecho" }]);
    expect((await history(item.id)).map((h) => h.action)).toEqual(["created"]);
  });

  it("duplicado vira evidência extra (merged) e não repete a mesma evidência", async () => {
    const other = { segmentId: null, start: 40, end: 44, channel: "remote" as const, quote: null };
    const res = await service.createAiItems(
      meetingId,
      [aiItem("Usar filas na integração do SUS", { evidence: [other] }), aiItem("Usar filas na integração com SUS")],
      "final",
    );
    expect(res).toEqual({ created: 0, merged: 1 });
    const [item] = await service.listItems(meetingId);
    expect(item.evidence).toHaveLength(2);
    expect((await history(item.id)).map((h) => h.action)).toEqual(["created", "merged"]);
  });

  it("edição grava só os campos alterados e ignora patch sem mudança", async () => {
    const [item] = await service.listItems(meetingId);
    await service.editItem(item.id, { description: "Usar filas (RabbitMQ) na integração", owner: null }, userId);
    await service.editItem(item.id, { description: "Usar filas (RabbitMQ) na integração" }, userId);
    const edits = (await history(item.id)).filter((h) => h.action === "edited");
    expect(edits).toHaveLength(1);
    expect(edits[0].before).toEqual({ description: "Usar filas na integração com o SUS" });
    expect(edits[0].after).toEqual({ description: "Usar filas (RabbitMQ) na integração" });
    expect(edits[0].actor?.username).toBe("revisor");
    const edited = (await service.getItem(item.id))!;
    expect(edited.reviewStatus).toBe("proposto");
  });

  it("categoria some ao trocar risco por outro tipo", async () => {
    await service.createAiItems(
      meetingId,
      [aiItem("Certificado do SUS pode atrasar a entrega", { type: "risco", attributes: { categoria: "prazo" } })],
      "live",
    );
    const risco = (await service.listItems(meetingId)).find((i) => i.type === "risco")!;
    const changed = await service.editItem(risco.id, { type: "pendencia" }, userId);
    expect(changed.attributes.categoria).toBeNull();
  });

  it("transições válidas e inválidas", async () => {
    const [item] = await service.listItems(meetingId);
    const approved = await service.reviewItem(item.id, "approve", userId);
    expect(approved.reviewStatus).toBe("aprovado");
    expect(approved.reviewedBy).toBe("revisor");
    await expect(service.reviewItem(item.id, "approve", userId)).rejects.toMatchObject({ status: 409 });
    await expect(service.reviewItem(item.id, "reject", userId)).rejects.toMatchObject({ status: 409 });
    const reopened = await service.reviewItem(item.id, "reopen", userId);
    expect(reopened.reviewStatus).toBe("proposto");
    expect(reopened.reviewedBy).toBeNull();
    const rejected = await service.reviewItem(item.id, "reject", userId);
    expect(rejected.reviewStatus).toBe("rejeitado");
    await expect(service.reviewItem(item.id, "reopen", userId)).resolves.toMatchObject({ reviewStatus: "proposto" });
    const actions = (await history(item.id)).map((h) => h.action);
    expect(actions.slice(-4)).toEqual(["approved", "reopened", "rejected", "reopened"]);
  });

  it("item rejeitado absorve duplicado em silêncio", async () => {
    const [item] = await service.listItems(meetingId);
    await service.reviewItem(item.id, "reject", userId);
    const before = (await history(item.id)).length;
    const res = await service.createAiItems(
      meetingId,
      [aiItem("Usar filas (RabbitMQ) na integração", { evidence: [{ segmentId: null, start: 90, end: 95, channel: "remote", quote: null }] })],
      "final",
    );
    expect(res).toEqual({ created: 0, merged: 0 });
    expect((await history(item.id)).length).toBe(before);
  });

  it("item manual nasce aprovado", async () => {
    const item = await service.createManualItem(meetingId, { type: "pendencia", description: "Enviar a proposta", owner: "Ana" }, userId);
    expect(item.reviewStatus).toBe("aprovado");
    expect(item.origin).toBe("manual");
    expect(item.owner).toBe("Ana");
    expect((await history(item.id))[0].actor?.username).toBe("revisor");
  });

  it("mergeInto move evidência e apaga só propostos do mesmo tipo", async () => {
    await service.createAiItems(
      meetingId,
      [
        aiItem("Adotar CQRS no portal da secretaria", { type: "decisao_arquitetural", evidence: [{ segmentId: null, start: 100, end: 104, channel: "remote", quote: null }] }),
        aiItem("Separar leitura e escrita com base dedicada", { type: "decisao_arquitetural", evidence: [{ segmentId: null, start: 200, end: 204, channel: "remote", quote: null }] }),
      ],
      "live",
    );
    const arch = (await service.listItems(meetingId)).filter((i) => i.type === "decisao_arquitetural");
    expect(arch).toHaveLength(2);
    const manual = (await service.listItems(meetingId)).find((i) => i.origin === "manual")!;
    const removed = await service.mergeInto(meetingId, arch[0].id, [arch[1].id, manual.id]);
    expect(removed).toEqual([arch[1].id]);
    const kept = (await service.getItem(arch[0].id))!;
    expect(kept.evidence.map((e) => e.start)).toEqual([100, 200]);
    expect(await service.getItem(manual.id)).not.toBeNull();
  });

  it("ADR recebe número só ao aprovar, sem duplicar em aprovações concorrentes", async () => {
    const [arch] = (await service.listItems(meetingId)).filter((i) => i.type === "decisao_arquitetural");
    const other = await service.createManualItem(meetingId, { type: "decisao_arquitetural", description: "Usar mensageria gerenciada" }, userId);
    const data = { title: "Filas", context: "c", problem: "p", alternatives: [], decision: "d", consequences: "q", risks: ["r"] };
    const a1 = (await service.upsertSuggestedAdr(meetingId, arch.id, data))!;
    const a2 = (await service.upsertSuggestedAdr(meetingId, other.id, { ...data, title: "Mensageria" }))!;
    expect(a1.number).toBeNull();
    expect(a1.code).toBeNull();
    const [r1, r2] = await Promise.all([service.reviewAdr(a1.id, "approve", userId), service.reviewAdr(a2.id, "approve", userId)]);
    expect(new Set([r1.number, r2.number])).toEqual(new Set([1, 2]));
    expect([r1.code, r2.code].sort()).toEqual(["ADR-001", "ADR-002"]);

    const rejected = await service.reviewAdr(a1.id, "reject", userId);
    expect(rejected.status).toBe("rejeitado");
    expect(rejected.number).toBe(r1.number);

    // Sugestão nova não sobrescreve ADR revisado.
    expect(await service.upsertSuggestedAdr(meetingId, arch.id, { ...data, title: "Outro" })).toBeNull();
    const again = await service.reviewAdr(a1.id, "approve", userId);
    expect(again.number).toBe(r1.number);
  });

  it("edição de ADR vai para o histórico do item e protege contra nova sugestão", async () => {
    const item = await service.createManualItem(meetingId, { type: "decisao_arquitetural", description: "Cache distribuído" }, userId);
    const data = { title: "Cache", context: "", problem: "", alternatives: [], decision: "", consequences: "", risks: [] };
    const adr = (await service.upsertSuggestedAdr(meetingId, item.id, data))!;
    const edited = await service.editAdr(adr.id, { title: "Cache com Redis", risks: ["custo"] }, userId);
    expect(edited.title).toBe("Cache com Redis");
    const h = (await history(item.id)).find((e) => e.action === "adr_edited")!;
    expect(h.before).toEqual({ title: "Cache", risks: [] });
    expect(h.after).toEqual({ title: "Cache com Redis", risks: ["custo"] });
    expect(await service.upsertSuggestedAdr(meetingId, item.id, { ...data, title: "IA" })).toBeNull();
  });

  it("passe final remapeia a evidência ao vivo e registra no histórico", async () => {
    const m = await pool.query(
      `INSERT INTO meetings (title, platform, status, source) VALUES ('Remap', 'none', 'done', 'manual') RETURNING id`,
    );
    const id = m.rows[0].id;
    const [live] = await transcripts.insertLiveSegments(id, [
      { channel: "remote", speaker: "Remoto", text: "texto ao vivo", start: 30, end: 36 },
    ]);
    await service.createAiItems(
      id,
      [aiItem("Migrar o banco em outubro", { evidence: [{ segmentId: live.id, start: 30, end: 36, channel: "remote", quote: null }] })],
      "live",
    );
    const finals = await transcripts.replaceWithFinal(
      id,
      [
        { channel: "remote", speaker: "Speaker 1", text: "a", start: 0, end: 29 },
        { channel: "remote", speaker: "Speaker 1", text: "texto final", start: 29.5, end: 37 },
      ],
      evidenceRemapper,
    );
    const [item] = await service.listItems(id);
    expect(item.evidence[0].segmentId).toBe(finals[1].id);
    expect((await history(item.id)).map((h) => h.action)).toContain("evidence_remapped");
    const left = await pool.query(`SELECT count(*)::int AS n FROM transcript_segments WHERE meeting_id = $1 AND pass = 'live'`, [id]);
    expect(left.rows[0].n).toBe(0);
  });

  it("gerar de novo apaga só o que a IA propôs e ninguém tocou; repetido de revisado é absorvido", async () => {
    const m = await pool.query(
      `INSERT INTO meetings (title, platform, status, source) VALUES ('Regerar', 'none', 'done', 'manual') RETURNING id`,
    );
    const id = m.rows[0].id;
    const texts = {
      intocado: "Publicar o portal na nuvem pública",
      editado: "Criptografar os backups semanais",
      aprovado: "Adotar mensageria entre os módulos",
      rejeitado: "Trocar o banco por um NoSQL",
      reaberto: "Congelar escopo até a homologação",
      comAdr: "Separar leitura e escrita no cadastro",
      dupAprovado: "Usar mensageria para integrar módulos distintos",
      dupRejeitado: "Migrar o banco para NoSQL em breve",
    };
    await service.createAiItems(
      id,
      Object.entries(texts).map(([k, d]) => aiItem(d, { type: k === "comAdr" ? "decisao_arquitetural" : "decisao" })),
      "final",
    );
    const byText = async () => new Map((await service.listItems(id)).map((i) => [i.description, i]));
    let items = await byText();
    expect(items.size).toBe(8);
    const get = (key: keyof typeof texts) => items.get(texts[key])!;
    await service.editItem(get("editado").id, { owner: "Ana" }, userId);
    await service.reviewItem(get("aprovado").id, "approve", userId);
    await service.reviewItem(get("rejeitado").id, "reject", userId);
    await service.reviewItem(get("reaberto").id, "approve", userId);
    await service.reviewItem(get("reaberto").id, "reopen", userId);
    const cqrs = await service.upsertSuggestedAdr(id, get("comAdr").id, {
      title: "CQRS", context: "", problem: "", alternatives: [], decision: "", consequences: "", risks: [],
    });
    await service.reviewAdr(cqrs!.id, "approve", userId);
    const manual = await service.createManualItem(id, { type: "decisao", description: "Revisar o contrato com o fornecedor" }, userId);
    const semTocar = await service.createAiItems(id, [aiItem("Rodar testes de carga antes da entrega", { type: "decisao_arquitetural" })], "live");
    expect(semTocar.created).toBe(1);
    items = await byText();
    await service.upsertSuggestedAdr(id, items.get("Rodar testes de carga antes da entrega")!.id, {
      title: "Carga", context: "", problem: "", alternatives: [], decision: "", consequences: "", risks: [],
    });

    const removed = await service.clearUnreviewedAiItems(id);
    const left = await byText();
    expect(removed).toHaveLength(4);
    expect([...left.keys()].sort()).toEqual(
      [texts.editado, texts.aprovado, texts.rejeitado, texts.reaberto, texts.comAdr, manual.description].sort(),
    );
    // ADR sugerido do item apagado sai junto; o aprovado fica
    const adrs = await service.listAdrs(id);
    expect(adrs.map((a) => a.title)).toEqual(["CQRS"]);

    // nova geração: repetidos de revisados
    const later = { segmentId: null, start: 50, end: 55, channel: "remote" as const, quote: null };
    await service.createAiItems(
      id,
      [aiItem(texts.dupAprovado, { evidence: [later] }), aiItem(texts.dupRejeitado, { evidence: [later] })],
      "final",
    );
    const fresh = await byText();
    const aprovado = fresh.get(texts.aprovado)!;
    expect(await service.mergeInto(id, aprovado.id, [fresh.get(texts.dupAprovado)!.id])).toHaveLength(1);
    expect(await service.mergeInto(id, fresh.get(texts.rejeitado)!.id, [fresh.get(texts.dupRejeitado)!.id])).toHaveLength(1);
    // revisado nunca é removido
    expect(await service.mergeInto(id, fresh.get(texts.editado)!.id, [aprovado.id])).toEqual([]);
    const after = await byText();
    expect(after.has(texts.dupAprovado)).toBe(false);
    expect(after.has(texts.dupRejeitado)).toBe(false);
    expect(after.get(texts.aprovado)!.evidence).toHaveLength(2);
    expect(after.get(texts.rejeitado)!.evidence).toHaveLength(1);
    expect((await history(aprovado.id)).map((h) => h.action)).toContain("merged");
  });
});
