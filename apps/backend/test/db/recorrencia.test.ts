import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { User } from "../../src/types";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("recorrência manual (Postgres)", async () => {
  const { pool, createUser, getMeeting } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  const { createScheduled, cancelScheduled } = await import("../../src/calendar/service");
  const { extendActiveSeries } = await import("../../src/calendar/seriesExtend");

  let user: User;
  beforeAll(async () => {
    await migrate(pool);
    user = await createUser("recorrencia-teste", "hash");
  });
  afterAll(() => pool.end());

  it("gera 1ª leva, estende pelo job e para quando a série é cancelada", async () => {
    const start = new Date(Date.now() + 24 * 3_600_000); // amanhã
    const first = await createScheduled(
      {
        title: "Daily do time",
        start: start.toISOString(),
        durationMinutes: 30,
        recurrence: { freq: "daily", interval: 1, until: null },
      },
      user.id,
    );
    expect(first.series_id).toBeTruthy();

    const before = await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE series_id = $1`, [first.series_id]);
    expect(before.rows[0].n).toBeGreaterThan(1); // já materializou vários dias (horizonte de 180 dias)
    const initialCount = before.rows[0].n;

    // Avança o "agora" bem além do horizonte original: o job precisa criar mais ocorrências.
    await extendActiveSeries(new Date(start.getTime() + 200 * 86_400_000));
    const afterExtend = await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE series_id = $1`, [first.series_id]);
    expect(afterExtend.rows[0].n).toBeGreaterThan(initialCount);

    // Rodar de novo não duplica (ON CONFLICT via índice único série+início).
    await extendActiveSeries(new Date(start.getTime() + 200 * 86_400_000));
    const afterExtendAgain = await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE series_id = $1`, [first.series_id]);
    expect(afterExtendAgain.rows[0].n).toBe(afterExtend.rows[0].n);

    // Cancela a partir da primeira ocorrência: todo o resto da série deve ficar cancelado.
    const cancelled = await cancelScheduled(first.id, "series");
    expect(cancelled.length).toBe(afterExtendAgain.rows[0].n);
    expect(cancelled.every((m) => m.status === "cancelled")).toBe(true);

    // O job não deve reviver uma série cancelada.
    await extendActiveSeries(new Date(start.getTime() + 400 * 86_400_000));
    const afterCancelExtend = await pool.query(`SELECT count(*)::int AS n FROM meetings WHERE series_id = $1`, [first.series_id]);
    expect(afterCancelExtend.rows[0].n).toBe(afterExtendAgain.rows[0].n);

    const reloaded = await getMeeting(first.id);
    expect(reloaded?.status).toBe("cancelled");
  });

  it("cancelar só uma ocorrência não mexe nas outras da série", async () => {
    const start = new Date(Date.now() + 48 * 3_600_000);
    const first = await createScheduled(
      {
        title: "Revisão semanal",
        start: start.toISOString(),
        durationMinutes: 60,
        recurrence: { freq: "weekly", interval: 1, until: new Date(start.getTime() + 30 * 86_400_000).toISOString() },
      },
      user.id,
    );
    const { rows } = await pool.query(
      `SELECT id FROM meetings WHERE series_id = $1 ORDER BY scheduled_start`,
      [first.series_id],
    );
    expect(rows.length).toBeGreaterThan(1);

    const cancelled = await cancelScheduled(first.id, "one");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].id).toBe(first.id);

    const remaining = await pool.query(
      `SELECT status FROM meetings WHERE series_id = $1 AND id <> $2`,
      [first.series_id, first.id],
    );
    expect(remaining.rows.every((r) => r.status !== "cancelled")).toBe(true);
  });
});
