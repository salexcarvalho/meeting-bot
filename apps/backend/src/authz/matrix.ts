import { PERMISSION_KEYS, PERMISSIONS, ROLE_KEYS, ROLE_LABELS, type Permission, type RoleKey } from "@meeting-bot/contracts";

// Papéis de sistema (docs/analise/plataforma-multiusuario.md §8). Permissões de conteúdo valem só para
// recursos próprios ou compartilhados; ler conteúdo alheio exige meetings.read_all, que nenhum papel
// recebe por padrão (pergunta Q2 em aberto).
const OWN_CONTENT: Permission[] = [
  "meetings.read",
  "meetings.manage",
  "transcripts.read",
  "transcripts.delete",
  "documents.generate",
  "documents.read",
  "agents.read",
  "agents.manage",
  "settings.manage",
];

const USER_ADMIN: Permission[] = ["users.read", "users.create", "users.update", "users.deactivate", "users.reset"];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  SUPER_ADMIN: PERMISSION_KEYS.filter((p) => p !== "meetings.read_all"),
  ADMIN: [...OWN_CONTENT, ...USER_ADMIN, "projects.manage", "audit.read"],
  USER: OWN_CONTENT,
  VIEWER: ["meetings.read", "transcripts.read", "documents.read", "agents.read", "settings.manage"],
};

/** Papéis que só um SUPER_ADMIN pode conceder, alterar ou remover (e cujos donos só ele gerencia). */
export const PRIVILEGED_ROLES: RoleKey[] = ["SUPER_ADMIN", "ADMIN"];

export function permissionsFor(roles: readonly RoleKey[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return out;
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

// SQL idempotente que sincroniza o catálogo com o código a cada boot.
export function rbacSeedStatements(): string[] {
  const perms = Object.entries(PERMISSIONS)
    .map(([key, desc]) => `(${q(key)}, ${q(desc)})`)
    .join(", ");
  const roles = ROLE_KEYS.map((k) => `(${q(k)}, ${q(ROLE_LABELS[k])})`).join(", ");
  const pairs = ROLE_KEYS.flatMap((role) => ROLE_PERMISSIONS[role].map((p) => `(${q(role)}, ${q(p)})`)).join(", ");
  return [
    `INSERT INTO permissions (key, description) VALUES ${perms}
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
    `DELETE FROM permissions WHERE key NOT IN (${PERMISSION_KEYS.map(q).join(", ")})`,
    `INSERT INTO roles (key, name) VALUES ${roles} ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name`,
    `WITH wanted(role_key, permission_key) AS (VALUES ${pairs})
     INSERT INTO role_permissions (role_id, permission_key)
       SELECT r.id, w.permission_key FROM wanted w JOIN roles r ON r.key = w.role_key
     ON CONFLICT DO NOTHING`,
    `WITH wanted(role_key, permission_key) AS (VALUES ${pairs})
     DELETE FROM role_permissions rp USING roles r
      WHERE rp.role_id = r.id AND r.system
        AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.role_key = r.key AND w.permission_key = rp.permission_key)`,
    // Bootstrap: base sem nenhum papel atribuído → o usuário mais antigo vira SUPER_ADMIN, os demais USER.
    `WITH none AS (SELECT NOT EXISTS (SELECT 1 FROM user_roles) AS empty),
          ranked AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM users)
     INSERT INTO user_roles (user_id, role_id)
       SELECT ranked.id, r.id FROM ranked, none, roles r
        WHERE none.empty AND r.key = CASE WHEN ranked.n = 1 THEN 'SUPER_ADMIN' ELSE 'USER' END`,
  ];
}
