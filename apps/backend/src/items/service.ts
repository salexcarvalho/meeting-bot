import type { PoolClient } from "pg";
import {
  ItemAttributes,
  type Adr,
  type AdrPatch,
  type Item,
  type ItemHistoryEntry,
  type ItemOrigin,
  type ItemPatch,
  type NewItemInput,
  type ReviewStatus,
} from "@meeting-bot/contracts";
import { planAiItems, type DedupCandidate } from "../agent/dedup";
import type { EvidenceInput, ValidItem } from "../agent/evidence";
import { pool, withTransaction } from "../db";
import { hub } from "../live/hub";

// Itens da reunião: criação pela IA (US3), revisão humana (US5) e ADRs.

export class ItemError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Db = Pick<PoolClient, "query">;

const ITEM_COLUMNS = `i.id, i.meeting_id, i.type, i.description, i.owner, i.due, i.attributes, i.review_status,
  i.origin, i.generated_by, i.created_at, i.updated_at, i.reviewed_at, u.username AS reviewed_by_username`;

function mapItem(r: Record<string, any>, evidence: Item["evidence"]): Item {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    type: r.type,
    description: r.description,
    owner: r.owner,
    due: r.due,
    attributes: r.attributes ?? {},
    reviewStatus: r.review_status,
    origin: r.origin,
    evidence,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    reviewedBy: r.reviewed_by_username ?? null,
    reviewedAt: r.reviewed_at?.toISOString() ?? null,
    generatedBy: r.generated_by ?? null,
  };
}

async function loadItems(db: Db, where: string, params: unknown[]): Promise<Item[]> {
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM meeting_items i LEFT JOIN users u ON u.id = i.reviewed_by
     WHERE ${where} ORDER BY i.created_at, i.id`,
    params,
  );
  if (!rows.length) return [];
  const ev = await db.query(
    `SELECT item_id, segment_id, start_seconds, end_seconds, channel, quote FROM item_evidence
     WHERE item_id = ANY($1) ORDER BY start_seconds, id`,
    [rows.map((r) => r.id)],
  );
  const byItem = new Map<string, Item["evidence"]>();
  for (const e of ev.rows) {
    const list = byItem.get(e.item_id) ?? [];
    list.push({
      segmentId: e.segment_id === null ? null : Number(e.segment_id),
      start: Number(e.start_seconds),
      end: Number(e.end_seconds),
      channel: e.channel,
      quote: e.quote,
    });
    byItem.set(e.item_id, list);
  }
  return rows.map((r) => mapItem(r, byItem.get(r.id) ?? []));
}

export function listItems(meetingId: string): Promise<Item[]> {
  return loadItems(pool, "i.meeting_id = $1", [meetingId]);
}

export async function getItem(id: string, db: Db = pool): Promise<Item | null> {
  return (await loadItems(db, "i.id = $1", [id]))[0] ?? null;
}

export function getItemsByIds(ids: string[], db: Db = pool): Promise<Item[]> {
  if (!ids.length) return Promise.resolve([]);
  return loadItems(db, "i.id = ANY($1)", [ids]);
}

async function addHistory(
  db: Db,
  itemId: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  actorId: string | null,
): Promise<void> {
  await db.query(`INSERT INTO item_history (item_id, action, before, after, actor_id) VALUES ($1, $2, $3, $4, $5)`, [
    itemId,
    action,
    before,
    after,
    actorId,
  ]);
}

async function insertEvidence(db: Db, itemId: string, evidence: EvidenceInput[]): Promise<number> {
  let added = 0;
  for (const e of evidence) {
    const r = await db.query(
      `INSERT INTO item_evidence (item_id, segment_id, start_seconds, end_seconds, channel, quote)
       SELECT $1::uuid, $2::bigint, $3::numeric, $4::numeric, $5::text, $6::text
       WHERE NOT EXISTS (
         SELECT 1 FROM item_evidence WHERE item_id = $1::uuid AND segment_id IS NOT DISTINCT FROM $2::bigint
           AND ($2::bigint IS NOT NULL OR start_seconds = $3::numeric)
       )`,
      [itemId, e.segmentId, e.start, e.end, e.channel, e.quote],
    );
    added += r.rowCount ?? 0;
  }
  return added;
}

function publishItems(meetingId: string, items: Item[]): void {
  if (items.length) hub.publishToMeeting(meetingId, { type: "items", meetingId, items });
}

// ---------- criação pela IA ----------

export async function createAiItems(
  meetingId: string,
  items: ValidItem[],
  origin: Exclude<ItemOrigin, "manual">,
  generatedBy: string | null = null,
): Promise<{ created: number; merged: number }> {
  if (!items.length) return { created: 0, merged: 0 };
  const touched = new Set<string>();
  let created = 0;
  let merged = 0;
  await withTransaction(async (client) => {
    // Serializa criações da mesma reunião (ao vivo e pós-reunião).
    await client.query(`SELECT id FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
    const { rows } = await client.query(
      `SELECT id, type, description, review_status FROM meeting_items WHERE meeting_id = $1`,
      [meetingId],
    );
    const existing: DedupCandidate[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      description: r.description,
      reviewStatus: r.review_status,
    }));

    const ids = new Map<string, string>();
    for (const step of planAiItems(existing, items.filter((i) => i.evidence.length))) {
      const item = step.item;
      if (step.kind === "skip") continue;
      if (step.kind === "merge") {
        const target = ids.get(step.targetId) ?? step.targetId;
        const added = await insertEvidence(client, target, item.evidence);
        if (added) {
          await addHistory(client, target, "merged", null, { description: item.description, evidence: added, origin }, null);
          await client.query(`UPDATE meeting_items SET updated_at = now() WHERE id = $1`, [target]);
          touched.add(target);
          merged++;
        }
        continue;
      }
      const attributes = ItemAttributes.parse(item.attributes);
      const ins = await client.query(
        `INSERT INTO meeting_items (meeting_id, type, description, owner, due, attributes, review_status, origin, generated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'proposto', $7, $8) RETURNING id`,
        [meetingId, item.type, item.description, item.owner, item.due, attributes, origin, generatedBy],
      );
      const id: string = ins.rows[0].id;
      ids.set(step.ref, id);
      if (!(await insertEvidence(client, id, item.evidence))) throw new Error("item de IA sem evidência");
      await addHistory(
        client,
        id,
        "created",
        null,
        { type: item.type, description: item.description, owner: item.owner, due: item.due, origin, generatedBy },
        null,
      );
      touched.add(id);
      created++;
    }
  });
  publishItems(meetingId, await getItemsByIds([...touched]));
  return { created, merged };
}

// Consolidação: move a evidência dos removidos para o mantido e apaga os removidos.
export async function mergeInto(meetingId: string, keepId: string, removeIds: string[]): Promise<string[]> {
  const removed: string[] = [];
  let keptRejected = false;
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, type, description, review_status FROM meeting_items
       WHERE meeting_id = $1 AND id = ANY($2) FOR UPDATE`,
      [meetingId, [keepId, ...removeIds]],
    );
    const keep = rows.find((r) => r.id === keepId);
    if (!keep) return;
    // Repetido de um rejeitado só some; de um proposto ou aprovado, leva a evidência junto.
    keptRejected = keep.review_status === "rejeitado";
    for (const r of rows) {
      if (r.id === keepId || r.type !== keep.type || r.review_status !== "proposto") continue;
      if (!keptRejected) {
        const ev = await client.query(
          `SELECT segment_id AS "segmentId", start_seconds::float AS start, end_seconds::float AS "end", channel, quote
           FROM item_evidence WHERE item_id = $1`,
          [r.id],
        );
        await insertEvidence(client, keepId, ev.rows);
        await addHistory(client, keepId, "merged", null, { description: r.description, mergedItem: r.id }, null);
      }
      await client.query(`DELETE FROM meeting_items WHERE id = $1`, [r.id]);
      removed.push(r.id);
    }
    if (removed.length && !keptRejected) {
      await client.query(`UPDATE meeting_items SET updated_at = now() WHERE id = $1`, [keepId]);
    }
  });
  if (removed.length) {
    hub.publishToMeeting(meetingId, { type: "items_removed", meetingId, ids: removed });
    if (!keptRejected) publishItems(meetingId, await getItemsByIds([keepId]));
  }
  return removed;
}

/**
 * Gerar a ata de novo: apaga o que a IA propôs e ninguém tocou (com os ADRs sugeridos ligados).
 * Ficam aprovados, rejeitados, itens manuais, itens editados ou reabertos e decisões com ADR revisado.
 */
export async function clearUnreviewedAiItems(meetingId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `DELETE FROM meeting_items i
      WHERE i.meeting_id = $1 AND i.review_status = 'proposto' AND i.origin IN ('live', 'final')
        AND NOT EXISTS (
          SELECT 1 FROM item_history h
           WHERE h.item_id = i.id AND (h.actor_id IS NOT NULL OR h.action IN ('edited', 'reopened', 'adr_edited'))
        )
        AND NOT EXISTS (SELECT 1 FROM adrs a WHERE a.item_id = i.id AND a.status <> 'proposto')
      RETURNING i.id`,
    [meetingId],
  );
  const ids = rows.map((r) => r.id as string);
  if (ids.length) hub.publishToMeeting(meetingId, { type: "items_removed", meetingId, ids });
  return ids;
}

// ---------- revisão humana ----------

const EDITABLE_FIELDS = ["type", "description", "owner", "due", "attributes"] as const;

async function lockItem(client: PoolClient, id: string): Promise<Record<string, any>> {
  const { rows } = await client.query(`SELECT * FROM meeting_items WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new ItemError("Item não encontrado.", 404);
  return rows[0];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function editItem(id: string, patch: ItemPatch, actorId: string): Promise<Item> {
  const meetingId = await withTransaction(async (client) => {
    const row = await lockItem(client, id);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (patch[field] === undefined) continue;
      let value: unknown = patch[field];
      if (field === "attributes") value = ItemAttributes.parse({ ...(row.attributes ?? {}), ...(value as object) });
      if ((field === "owner" || field === "due") && typeof value === "string" && !value.trim()) value = null;
      const current = row[field];
      if (same(current, value)) continue;
      before[field] = current;
      after[field] = value;
      next[field] = value;
    }
    const type = (next.type ?? row.type) as string;
    if (type !== "risco" && next.attributes === undefined && row.attributes?.categoria) {
      before.attributes = row.attributes;
      next.attributes = after.attributes = { ...row.attributes, categoria: null };
    } else if (type !== "risco" && next.attributes && (next.attributes as ItemAttributes).categoria) {
      next.attributes = after.attributes = { ...(next.attributes as object), categoria: null };
    }
    const fields = Object.keys(next);
    if (fields.length) {
      const sets = fields.map((f, i) => `${f} = $${i + 2}`);
      await client.query(`UPDATE meeting_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, [
        id,
        ...fields.map((f) => next[f]),
      ]);
      await addHistory(client, id, "edited", before, after, actorId);
    }
    return row.meeting_id as string;
  });
  const item = (await getItem(id))!;
  publishItems(meetingId, [item]);
  return item;
}

const TRANSITIONS: Record<"approve" | "reject" | "reopen", { from: ReviewStatus[]; to: ReviewStatus; action: string }> = {
  approve: { from: ["proposto"], to: "aprovado", action: "approved" },
  reject: { from: ["proposto"], to: "rejeitado", action: "rejected" },
  reopen: { from: ["aprovado", "rejeitado"], to: "proposto", action: "reopened" },
};

export async function reviewItem(id: string, op: keyof typeof TRANSITIONS, actorId: string): Promise<Item> {
  const t = TRANSITIONS[op];
  const meetingId = await withTransaction(async (client) => {
    const row = await lockItem(client, id);
    if (!t.from.includes(row.review_status)) {
      throw new ItemError(`Não é possível ${op === "approve" ? "aprovar" : op === "reject" ? "rejeitar" : "reabrir"} um item ${row.review_status}.`, 409);
    }
    const reviewed = t.to === "proposto" ? [null, null] : [actorId, new Date()];
    await client.query(
      `UPDATE meeting_items SET review_status = $2, reviewed_by = $3, reviewed_at = $4, updated_at = now() WHERE id = $1`,
      [id, t.to, ...reviewed],
    );
    await addHistory(client, id, t.action, { reviewStatus: row.review_status }, { reviewStatus: t.to }, actorId);
    return row.meeting_id as string;
  });
  const item = (await getItem(id))!;
  publishItems(meetingId, [item]);
  return item;
}

export async function createManualItem(
  meetingId: string,
  input: NewItemInput & { evidence?: EvidenceInput[] },
  actorId: string,
): Promise<Item> {
  const id = await withTransaction(async (client) => {
    const exists = await client.query(`SELECT 1 FROM meetings WHERE id = $1`, [meetingId]);
    if (!exists.rowCount) throw new ItemError("Reunião não encontrada.", 404);
    const attributes = ItemAttributes.parse({
      ...(input.attributes ?? {}),
      categoria: input.type === "risco" ? (input.attributes?.categoria ?? null) : null,
    });
    const ins = await client.query(
      `INSERT INTO meeting_items (meeting_id, type, description, owner, due, attributes, review_status, origin,
         reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'aprovado', 'manual', $7, now()) RETURNING id`,
      [meetingId, input.type, input.description, input.owner || null, input.due || null, attributes, actorId],
    );
    const itemId: string = ins.rows[0].id;
    if (input.evidence?.length) await insertEvidence(client, itemId, input.evidence);
    await addHistory(
      client,
      itemId,
      "created",
      null,
      { type: input.type, description: input.description, owner: input.owner ?? null, due: input.due ?? null, origin: "manual" },
      actorId,
    );
    return itemId;
  });
  const item = (await getItem(id))!;
  publishItems(meetingId, [item]);
  return item;
}

export async function getHistory(itemId: string): Promise<ItemHistoryEntry[] | null> {
  const exists = await pool.query(`SELECT 1 FROM meeting_items WHERE id = $1`, [itemId]);
  if (!exists.rowCount) return null;
  const { rows } = await pool.query(
    `SELECT h.action, h.before, h.after, h.created_at, u.id AS actor_id, u.username
     FROM item_history h LEFT JOIN users u ON u.id = h.actor_id
     WHERE h.item_id = $1 ORDER BY h.created_at, h.id`,
    [itemId],
  );
  return rows.map((r) => ({
    action: r.action,
    before: r.before,
    after: r.after,
    actor: r.actor_id ? { id: r.actor_id, username: r.username } : null,
    createdAt: r.created_at.toISOString(),
  }));
}

// ---------- ADRs ----------

const ADR_LOCK = 73_100_002;

function mapAdr(r: Record<string, any>): Adr {
  return {
    id: r.id,
    itemId: r.item_id,
    meetingId: r.meeting_id,
    number: r.number,
    code: r.number ? `ADR-${String(r.number).padStart(3, "0")}` : null,
    title: r.title,
    context: r.context,
    problem: r.problem,
    alternatives: r.alternatives ?? [],
    decision: r.decision,
    consequences: r.consequences,
    risks: r.risks ?? [],
    status: r.status,
    approvedAt: r.approved_at?.toISOString() ?? null,
    generatedBy: r.generated_by ?? null,
  };
}

export async function listAdrs(meetingId: string): Promise<Adr[]> {
  const { rows } = await pool.query(`SELECT * FROM adrs WHERE meeting_id = $1 ORDER BY created_at, id`, [meetingId]);
  return rows.map(mapAdr);
}

export async function getAdr(id: string): Promise<Adr | null> {
  const { rows } = await pool.query(`SELECT * FROM adrs WHERE id = $1`, [id]);
  return rows[0] ? mapAdr(rows[0]) : null;
}

function publishAdr(adr: Adr): void {
  hub.publishToMeeting(adr.meetingId, { type: "adrs", meetingId: adr.meetingId, adrs: [adr] });
}

/** Por que um ADR não pode ser (re)gerado pela IA; null = pode. */
export async function adrLockReason(itemId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT a.status, a.approved_by,
            EXISTS (SELECT 1 FROM item_history h WHERE h.item_id = a.item_id AND h.action = 'adr_edited') AS edited
       FROM adrs a WHERE a.item_id = $1`,
    [itemId],
  );
  const adr = rows[0];
  if (!adr) return null;
  if (adr.status === "aprovado" || adr.approved_by) return "Este ADR já foi aprovado e não é gerado de novo.";
  if (adr.status === "rejeitado") return "Este ADR foi rejeitado e não é gerado de novo.";
  if (adr.edited) return "Este ADR foi editado à mão; a IA não sobrescreve edições.";
  return null;
}

// Sugestão da IA: cria ou atualiza enquanto não foi aprovado/rejeitado.
export async function upsertSuggestedAdr(
  meetingId: string,
  itemId: string,
  data: Required<AdrPatch>,
  generatedBy: string | null = null,
): Promise<Adr | null> {
  const { rows } = await pool.query(
    `INSERT INTO adrs (item_id, meeting_id, title, context, problem, alternatives, decision, consequences, risks, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (item_id) DO UPDATE SET
       title = EXCLUDED.title, context = EXCLUDED.context, problem = EXCLUDED.problem,
       alternatives = EXCLUDED.alternatives, decision = EXCLUDED.decision,
       consequences = EXCLUDED.consequences, risks = EXCLUDED.risks,
       generated_by = EXCLUDED.generated_by, updated_at = now()
     WHERE adrs.status = 'proposto' AND adrs.approved_by IS NULL
       AND NOT EXISTS (SELECT 1 FROM item_history h WHERE h.item_id = adrs.item_id AND h.action = 'adr_edited')
     RETURNING *`,
    [
      itemId,
      meetingId,
      data.title,
      data.context,
      data.problem,
      JSON.stringify(data.alternatives),
      data.decision,
      data.consequences,
      JSON.stringify(data.risks),
      generatedBy,
    ],
  );
  if (!rows[0]) return null;
  const adr = mapAdr(rows[0]);
  publishAdr(adr);
  return adr;
}

export async function editAdr(id: string, patch: AdrPatch, actorId: string): Promise<Adr> {
  await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM adrs WHERE id = $1 FOR UPDATE`, [id]);
    const row = rows[0];
    if (!row) throw new ItemError("ADR não encontrado.", 404);
    const columns: Record<keyof AdrPatch, string> = {
      title: "title",
      context: "context",
      problem: "problem",
      alternatives: "alternatives",
      decision: "decision",
      consequences: "consequences",
      risks: "risks",
    };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const key of Object.keys(columns) as (keyof AdrPatch)[]) {
      const value = patch[key];
      if (value === undefined || same(row[columns[key]], value)) continue;
      before[key] = row[columns[key]];
      after[key] = value;
      values.push(Array.isArray(value) ? JSON.stringify(value) : value);
      sets.push(`${columns[key]} = $${values.length}`);
    }
    if (!sets.length) return;
    await client.query(`UPDATE adrs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
    await addHistory(client, row.item_id, "adr_edited", before, after, actorId);
  });
  const adr = (await getAdr(id))!;
  publishAdr(adr);
  return adr;
}

export async function reviewAdr(id: string, op: "approve" | "reject", actorId: string): Promise<Adr> {
  await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [ADR_LOCK]);
    const { rows } = await client.query(`SELECT * FROM adrs WHERE id = $1 FOR UPDATE`, [id]);
    const row = rows[0];
    if (!row) throw new ItemError("ADR não encontrado.", 404);
    const to = op === "approve" ? "aprovado" : "rejeitado";
    if (row.status === to) return;
    let number: number | null = row.number;
    if (op === "approve" && number === null) {
      const max = await client.query(`SELECT COALESCE(MAX(number), 0) + 1 AS next FROM adrs`);
      number = Number(max.rows[0].next);
    }
    await client.query(
      `UPDATE adrs SET status = $2, number = $3, approved_by = $4, approved_at = $5, updated_at = now() WHERE id = $1`,
      [id, to, number, op === "approve" ? actorId : row.approved_by, op === "approve" ? new Date() : row.approved_at],
    );
    await addHistory(
      client,
      row.item_id,
      op === "approve" ? "adr_approved" : "adr_rejected",
      { status: row.status, number: row.number },
      { status: to, number },
      actorId,
    );
  });
  const adr = (await getAdr(id))!;
  publishAdr(adr);
  return adr;
}
