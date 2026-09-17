import { afterAll, describe, expect, it } from "vitest";

describe.skipIf(!process.env.LEGACY_MIGRATION_CHECK)("migração sobre o banco legado", async () => {
  const { pool } = await import("../../src/db");
  const { migrate } = await import("../../src/schema");
  afterAll(() => pool.end());

  it("é aditiva, idempotente e faz os backfills", async () => {
    const before = await pool.query(`SELECT id, status, platform, audio_path, ata_markdown FROM meetings ORDER BY id`);
    await migrate(pool);
    await migrate(pool);
    const after = await pool.query(`SELECT id, status, platform, audio_path, ata_markdown, source FROM meetings ORDER BY id`);
    expect(after.rows.map(({ source: _s, ...r }) => r)).toEqual(before.rows);
    for (const r of after.rows) expect(r.source).toBe(r.platform === "upload" ? "upload" : "bot");
    const audio = await pool.query(`SELECT m.id, a.format FROM meetings m JOIN meeting_audio a ON a.meeting_id = m.id`);
    const withAudio = before.rows.filter((r) => r.audio_path).length;
    expect(audio.rows).toHaveLength(withAudio);
    const segs = await pool.query(`SELECT DISTINCT channel, pass FROM transcript_segments`);
    for (const r of segs.rows) expect(r).toEqual({ channel: "mixed", pass: "final" });
    const projects = await pool.query(`SELECT count(*)::int AS n FROM projects`);
    expect(projects.rows[0].n).toBe(5);

    // plataforma multiusuário: todo usuário ganha papel; o mais antigo vira SUPER_ADMIN
    const roles = await pool.query(
      `SELECT u.username, array_agg(r.key) AS roles FROM users u
         JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        GROUP BY u.id, u.created_at ORDER BY u.created_at, u.id`,
    );
    const users = await pool.query(`SELECT count(*)::int AS n FROM users`);
    expect(roles.rows).toHaveLength(users.rows[0].n);
    if (roles.rows.length) expect(roles.rows[0].roles).toEqual(["SUPER_ADMIN"]);
    for (const r of roles.rows.slice(1)) expect(r.roles).toEqual(["USER"]);
    const active = await pool.query(`SELECT bool_and(active) AS all_active FROM users`);
    expect(active.rows[0].all_active ?? true).toBe(true);
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'meetings' AND indexname LIKE 'uq_meetings_ical%'`);
    expect(idx.rows.map((r) => r.indexname)).toEqual(["uq_meetings_ical_owner"]);
    const perms = await pool.query(`SELECT count(*)::int AS n FROM role_permissions`);
    expect(perms.rows[0].n).toBeGreaterThan(20);
    console.log(`legado: ${before.rows.length} reuniões, ${withAudio} com áudio, segmentos ${JSON.stringify(segs.rows)}`);
  });
});
