import { pool } from "../db";

// Termos que ajudam o Whisper (initial_prompt): título, projeto, participantes e projetos.
const cache = new Map<string, { at: number; text: string | undefined }>();
const TTL_MS = 60_000;

export async function glossaryFor(meetingId: string): Promise<string | undefined> {
  const hit = cache.get(meetingId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  const { rows } = await pool.query(
    `SELECT m.title, m.attendees, p.name AS project,
            (SELECT string_agg(name, ', ' ORDER BY name) FROM projects) AS projects
     FROM meetings m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = $1`,
    [meetingId],
  );
  const row = rows[0];
  let text: string | undefined;
  if (row) {
    const people = (Array.isArray(row.attendees) ? row.attendees : [])
      .map((a: { name?: string }) => a.name?.trim())
      .filter((n: string | undefined): n is string => Boolean(n && !n.includes("@")))
      .slice(0, 15);
    const parts = [
      `Reunião: ${row.title}.`,
      row.project ? `Projeto: ${row.project}.` : "",
      people.length ? `Participantes: ${people.join(", ")}.` : "",
      row.projects ? `Projetos: ${row.projects}.` : "",
    ];
    text = parts.filter(Boolean).join(" ").slice(0, 400) || undefined;
  }
  cache.set(meetingId, { at: Date.now(), text });
  return text;
}
