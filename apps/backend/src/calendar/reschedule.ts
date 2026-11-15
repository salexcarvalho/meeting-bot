import type { PoolClient } from "pg";
import type { Occurrence } from "./ics";

// Remarcação dentro do dia (agenda enviada por assistente externo): a ocorrência de série usa o início como chave
// de recorrência, então mover 10h para 15h gera uma chave nova. Sem este passo a linha antiga seria cancelada e uma
// nova criada, perdendo o que o usuário escolheu ("Não gravar", itens, projeto, links e descrição manuais).
// Aqui a linha antiga ganha a chave nova; a aplicação normal do envio então atualiza início, fim e demais dados.

export interface DayRow {
  id: string;
  uid: string;
  key: string;
  start: Date;
  /** pode ser remarcada: é da origem do envio, ainda não começou e está agendada ou como "não gravar" */
  movable: boolean;
}

function matches(row: DayRow, o: Occurrence): boolean {
  return (
    row.key === o.recurrenceKey ||
    row.key === o.start.toISOString() ||
    (row.key === "" && row.start.getTime() === o.start.getTime())
  );
}

async function loadDayRows(
  client: PoolClient,
  ownerId: string,
  source: string,
  range: { start: Date; end: Date },
  movableStatuses: string[],
  series: Occurrence[],
): Promise<DayRow[]> {
  const uids = [...new Set(series.map((o) => o.uid))];
  const keys = series.map((o) => o.recurrenceKey);
  const { rows } = await client.query(
    `SELECT id, ical_uid, recurrence_key, scheduled_start,
            (import_source = $2 AND scheduled_start > now() AND scheduled_start >= $3 AND scheduled_start < $4
             AND status = ANY($5)) AS movable
       FROM meetings
      WHERE created_by = $1 AND ical_uid = ANY($6::text[])
        AND ((scheduled_start >= $3 AND scheduled_start < $4) OR recurrence_key = ANY($7::text[]))
      ORDER BY scheduled_start, id`,
    [ownerId, source, range.start, range.end, movableStatuses, uids, keys],
  );
  return rows.map((r) => ({
    id: r.id,
    uid: r.ical_uid,
    key: r.recurrence_key,
    start: r.scheduled_start,
    movable: Boolean(r.movable),
  }));
}

// Pareia, por uid e em ordem de início, as linhas movíveis sem evento correspondente com os eventos de série
// sem linha. Devolve id da linha -> chave nova.
export function pairByUid(rows: DayRow[], events: Occurrence[]): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const uid of new Set(events.map((e) => e.uid))) {
    const mine = rows.filter((r) => r.uid === uid);
    const sent = events.filter((e) => e.uid === uid);
    const orphanRows = mine.filter((r) => r.movable && !sent.some((e) => matches(r, e)));
    const orphanEvents = sent
      .filter((e) => e.recurrenceKey !== "" && !e.cancelled && !mine.some((r) => matches(r, e)))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    orphanRows.forEach((row, i) => {
      if (orphanEvents[i]) pairs.set(row.id, orphanEvents[i].recurrenceKey);
    });
  }
  return pairs;
}

export async function pairReschedules(
  client: PoolClient,
  ownerId: string,
  source: string,
  range: { start: Date; end: Date },
  movableStatuses: string[],
  occurrences: Occurrence[],
): Promise<number> {
  const series = occurrences.filter((o) => o.recurrenceKey !== "");
  if (series.length === 0) return 0;
  const rows = await loadDayRows(client, ownerId, source, range, movableStatuses, series);
  const pairs = pairByUid(rows, occurrences);
  for (const [id, key] of pairs) {
    await client.query(`UPDATE meetings SET recurrence_key = $2 WHERE id = $1`, [id, key]);
  }
  return pairs.size;
}
