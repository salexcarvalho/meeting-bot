import { rateLimit } from "express-rate-limit";
import type { UserLookupItem } from "@meeting-bot/contracts";
import { requirePermission } from "../authz";
import { pool } from "../db";
import { features } from "../features";
import { wrap } from "../routes";
import { FROM_ACCENTS, LOOKUP_LIMIT_PER_MINUTE, LOOKUP_MAX_RESULTS, lookupPattern, TO_ACCENTS } from "./lookupPattern";

// Busca mínima de usuário para o diálogo de compartilhar (specs/005, decisão Q2 = A): quem tem meetings.manage
// acha pessoas ativas por prefixo (usuário ou nome), com no mínimo 3 caracteres, no máximo 8 resultados,
// só id/usuário/nome/canEdit e limite de taxa por usuário. Nunca e-mail, papéis ou estado de login.

const SEARCH_SQL = `
  WITH cand AS (
    SELECT u.id, u.username,
           COALESCE(NULLIF(u.display_name, ''), NULLIF(u.real_name, ''), u.username) AS name,
           lower(translate(u.username, '${FROM_ACCENTS}', '${TO_ACCENTS}')) AS f_user,
           lower(translate(concat_ws(' ', u.real_name, u.display_name), '${FROM_ACCENTS}', '${TO_ACCENTS}')) AS f_name,
           EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                    WHERE ur.user_id = u.id AND rp.permission_key = 'meetings.read') AS can_read,
           EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                    WHERE ur.user_id = u.id AND rp.permission_key = 'meetings.manage') AS can_edit
      FROM users u
     WHERE u.active AND u.id <> $2
  )
  SELECT id, username, name, can_edit
    FROM cand
   WHERE can_read
     AND (f_user LIKE $1 ESCAPE '\\' OR f_name LIKE $1 ESCAPE '\\' OR f_name LIKE ('% ' || $1) ESCAPE '\\')
   ORDER BY name, username
   LIMIT ${LOOKUP_MAX_RESULTS}`;

export async function lookupUsers(pattern: string, requesterId: string): Promise<UserLookupItem[]> {
  const { rows } = await pool.query(SEARCH_SQL, [pattern, requesterId]);
  return rows.map((r) => ({ id: r.id, username: r.username, name: r.name, canEdit: r.can_edit }));
}

const lookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: LOOKUP_LIMIT_PER_MINUTE,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Por usuário (a rota exige sessão); sem sessão cai num balde único, que o requireAuth já barrou.
  keyGenerator: (req) => `lookup:${req.user?.id ?? "anon"}`,
  message: { error: "Muitas buscas. Tente de novo em instantes." },
});

features.authedRouters.push((router) => {
  router.get(
    "/users/lookup",
    requirePermission("meetings.manage"),
    lookupLimiter,
    wrap(async (req, res) => {
      const pattern = lookupPattern(req.query.q);
      if (!pattern) return res.status(400).json({ error: "Digite ao menos 3 caracteres." });
      res.json({ users: await lookupUsers(pattern, req.user!.id) });
    }),
  );
});
