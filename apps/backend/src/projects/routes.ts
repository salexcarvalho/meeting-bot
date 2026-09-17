import { ProjectInput, type Project } from "@meeting-bot/contracts";
import { requirePermission, visibleMeetingsSql } from "../authz";
import { pool } from "../db";
import type { User } from "../types";
import { features } from "../features";
import { parseBody, wrap } from "../routes";

function cleanKeywords(keywords: string[] | undefined): string[] {
  return [...new Set((keywords ?? []).map((k) => k.trim()).filter(Boolean))];
}

// A contagem só inclui reuniões que o usuário pode ver (o catálogo de projetos é compartilhado).
async function getProject(id: string, user: User): Promise<Project | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.keywords, count(m.id) FILTER (WHERE ${visibleMeetingsSql(user, "m", 2)})::int AS meeting_count
     FROM projects p LEFT JOIN meetings m ON m.project_id = p.id
     WHERE p.id = $1 GROUP BY p.id`,
    [id, user.id],
  );
  const r = rows[0];
  return r ? { id: r.id, name: r.name, keywords: r.keywords, meetingCount: r.meeting_count } : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

features.authedRouters.push((router) => {
  router.get(
    "/projects",
    wrap(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.keywords,
                count(m.id) FILTER (WHERE ${visibleMeetingsSql(req.user!, "m", 1)})::int AS meeting_count
         FROM projects p LEFT JOIN meetings m ON m.project_id = p.id
         GROUP BY p.id ORDER BY lower(p.name)`,
        [req.user!.id],
      );
      const projects: Project[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        keywords: r.keywords,
        meetingCount: r.meeting_count,
      }));
      res.json({ projects });
    }),
  );

  router.post(
    "/projects",
    requirePermission("meetings.manage"),
    wrap(async (req, res) => {
      const input = parseBody(ProjectInput, req, res);
      if (!input) return;
      try {
        const { rows } = await pool.query(`INSERT INTO projects (name, keywords) VALUES ($1, $2) RETURNING id`, [
          input.name,
          cleanKeywords(input.keywords),
        ]);
        res.status(201).json(await getProject(rows[0].id, req.user!));
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ error: "Já existe um projeto com esse nome." });
        throw err;
      }
    }),
  );

  router.patch(
    "/projects/:id",
    requirePermission("projects.manage"),
    wrap(async (req, res) => {
      const input = parseBody(ProjectInput.partial(), req, res);
      if (!input) return;
      const current = await getProject(String(req.params.id), req.user!);
      if (!current) return res.status(404).json({ error: "Projeto não encontrado." });
      try {
        await pool.query(`UPDATE projects SET name = $2, keywords = $3 WHERE id = $1`, [
          current.id,
          input.name ?? current.name,
          input.keywords ? cleanKeywords(input.keywords) : current.keywords,
        ]);
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ error: "Já existe um projeto com esse nome." });
        throw err;
      }
      res.json(await getProject(current.id, req.user!));
    }),
  );

  router.delete(
    "/projects/:id",
    requirePermission("projects.manage"),
    wrap(async (req, res) => {
      const { rowCount } = await pool.query(`DELETE FROM projects WHERE id = $1`, [String(req.params.id)]);
      if (!rowCount) return res.status(404).json({ error: "Projeto não encontrado." });
      res.status(204).end();
    }),
  );
});
