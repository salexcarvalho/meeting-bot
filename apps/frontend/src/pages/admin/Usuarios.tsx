import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Pencil, Power, RotateCcw, UserPlus, Users } from "lucide-react";
import { ROLE_KEYS, ROLE_LABELS, type AdminUser, type RoleKey, type UserProfile } from "@meeting-bot/contracts";
import { api, errorMessage } from "../../api";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { initials } from "../../components/shell/Sidebar";
import { useToast } from "../../components/Toast";
import { EmptyState, PageHeader, SkeletonLines } from "../../components/ui";
import { formatDateTime } from "../../format";
import { useCan, useSession } from "../../session";

const PRIVILEGED: RoleKey[] = ["SUPER_ADMIN", "ADMIN"];
const MIN_PASSWORD = 10;

const ROLE_HINTS: Record<RoleKey, string> = {
  SUPER_ADMIN: "tudo, inclusive administradores e provedores de IA",
  ADMIN: "gerencia usuários comuns e o catálogo de projetos",
  USER: "suas reuniões, agente e configurações",
  VIEWER: "só lê o que for compartilhado com ele",
};

type Pending =
  | { kind: "edit"; user: AdminUser }
  | { kind: "password"; user: AdminUser }
  | { kind: "toggle"; user: AdminUser }
  | { kind: "reset"; user: AdminUser }
  | { kind: "create" }
  | null;

export function Usuarios() {
  const toast = useToast();
  const can = useCan();
  const session = useSession();
  const isSuper = session.roles.includes("SUPER_ADMIN");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ users: AdminUser[] }>("/admin/users")
      .then((r) => {
        setUsers(r.users);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);
  useEffect(load, [load]);

  const manageable = (u: AdminUser) => isSuper || !u.roles.some((r) => PRIVILEGED.includes(r));
  const close = () => setPending(null);

  async function mutate(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      toast(message);
      close();
      load();
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <PageHeader
        title="Usuários"
        description="Contas, papéis e acesso. Cada usuário só vê as próprias reuniões e as compartilhadas com ele."
        actions={
          can("users.create") && (
            <button type="button" className="primary" onClick={() => setPending({ kind: "create" })}>
              <UserPlus aria-hidden="true" /> Novo usuário
            </button>
          )
        }
      />
      <section className="card flush">
        <div className="card-head">
          <h2>
            <Users size={16} /> {users ? `${users.length} usuário(s)` : "Usuários"}
          </h2>
        </div>
        {error && <div className="banner error" style={{ margin: "12px 20px" }}>{error}</div>}
        {!users && !error && (
          <div style={{ padding: "8px 20px 20px" }}>
            <SkeletonLines lines={4} />
          </div>
        )}
        {users && users.length === 0 && (
          <div style={{ padding: 20 }}>
            <EmptyState icon={Users} title="Nenhum usuário" />
          </div>
        )}
        {users && users.length > 0 && (
          <div className="table-wrap">
            <table className="simple">
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Papel</th>
                  <th>Situação</th>
                  <th className="hide-sm">Último acesso</th>
                  <th className="hide-sm num">Reuniões</th>
                  <th><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === session.user.id;
                  const allowed = manageable(u);
                  return (
                    <tr key={u.id} className={u.active ? "" : "inactive"}>
                      <td>
                        <div className="row" style={{ flexWrap: "nowrap" }}>
                          <span className="avatar" aria-hidden="true">
                            {u.hasAvatar ? <img src={`/api/admin/users/${u.id}/avatar?v=${u.avatarVersion}`} alt="" /> : initials(u.name)}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div className="cell-title">
                              {u.name} {self && <span className="badge">você</span>}
                            </div>
                            <div className="cell-sub">@{u.username}{u.realName && u.realName !== u.name ? ` · ${u.realName}` : ""}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {u.roles.map((r) => (
                          <span key={r} className={`badge ${PRIVILEGED.includes(r) ? "primary" : ""}`}>{ROLE_LABELS[r]}</span>
                        ))}
                      </td>
                      <td>
                        <span className={`badge ${u.active ? "ok" : "error"}`}>{u.active ? "Ativo" : "Desativado"}</span>
                      </td>
                      <td className="hide-sm tabular">{u.lastSeenAt ? formatDateTime(u.lastSeenAt) : <span className="muted">nunca</span>}</td>
                      <td className="hide-sm num tabular">{u.meetingCount}</td>
                      <td>
                        <div className="row row-actions">
                          {can("users.update") && allowed && (
                            <button type="button" className="ghost icon" title="Editar" aria-label={`Editar ${u.username}`} onClick={() => setPending({ kind: "edit", user: u })}>
                              <Pencil aria-hidden="true" />
                            </button>
                          )}
                          {can("users.reset") && allowed && (
                            <button type="button" className="ghost icon" title="Redefinir senha" aria-label={`Redefinir senha de ${u.username}`} onClick={() => setPending({ kind: "password", user: u })}>
                              <KeyRound aria-hidden="true" />
                            </button>
                          )}
                          {can("users.reset") && allowed && (
                            <button type="button" className="ghost icon" title="Restaurar configurações padrão" aria-label={`Restaurar configurações de ${u.username}`} onClick={() => setPending({ kind: "reset", user: u })}>
                              <RotateCcw aria-hidden="true" />
                            </button>
                          )}
                          {can("users.deactivate") && allowed && !self && (
                            <button
                              type="button"
                              className={`ghost icon ${u.active ? "danger" : ""}`}
                              title={u.active ? "Desativar" : "Reativar"}
                              aria-label={`${u.active ? "Desativar" : "Reativar"} ${u.username}`}
                              onClick={() => setPending({ kind: "toggle", user: u })}
                            >
                              <Power aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CreateUserDialog
        open={pending?.kind === "create"}
        busy={busy}
        allowPrivileged={isSuper}
        onClose={close}
        onSubmit={(body) => mutate(() => api<UserProfile>("/admin/users", { method: "POST", json: body }), "Usuário criado.")}
      />
      {pending?.kind === "edit" && (
        <EditUserDialog
          user={pending.user}
          busy={busy}
          self={pending.user.id === session.user.id}
          allowPrivileged={isSuper}
          onClose={close}
          onSubmit={(body) => mutate(() => api(`/admin/users/${pending.user.id}`, { method: "PATCH", json: body }), "Usuário atualizado.")}
        />
      )}
      {pending?.kind === "password" && (
        <PasswordResetDialog
          user={pending.user}
          busy={busy}
          onClose={close}
          onSubmit={(password) =>
            mutate(
              () => api(`/admin/users/${pending.user.id}/reset-password`, { method: "POST", json: { password } }),
              "Senha redefinida. As sessões abertas desse usuário foram encerradas.",
            )
          }
        />
      )}
      <ConfirmDialog
        open={pending?.kind === "toggle"}
        title={pending?.kind === "toggle" && pending.user.active ? "Desativar usuário?" : "Reativar usuário?"}
        message={
          pending?.kind === "toggle" && pending.user.active
            ? `${pending.user.name} perde o acesso agora (as sessões abertas são encerradas). Os dados dele continuam guardados.`
            : "O usuário volta a poder entrar com a senha atual."
        }
        confirmLabel={pending?.kind === "toggle" && pending.user.active ? "Desativar" : "Reativar"}
        danger={pending?.kind === "toggle" && pending.user.active}
        onClose={close}
        onConfirm={() => {
          if (pending?.kind !== "toggle") return;
          const { user } = pending;
          void mutate(
            () => api(`/admin/users/${user.id}`, { method: "PATCH", json: { active: !user.active } }),
            user.active ? "Usuário desativado." : "Usuário reativado.",
          );
        }}
      />
      <ConfirmDialog
        open={pending?.kind === "reset"}
        title="Restaurar configurações padrão?"
        message="As preferências de reunião e de documentação desse usuário voltam ao padrão. Perfil, agente e reuniões não mudam."
        confirmLabel="Restaurar"
        onClose={close}
        onConfirm={() => {
          if (pending?.kind !== "reset") return;
          void mutate(() => api(`/admin/users/${pending.user.id}/reset-settings`, { method: "POST" }), "Configurações restauradas.");
        }}
      />
    </main>
  );
}

function RolePicker({
  value,
  onChange,
  allowPrivileged,
  disabled,
  name,
}: {
  value: RoleKey;
  onChange: (role: RoleKey) => void;
  allowPrivileged: boolean;
  disabled?: boolean;
  name: string;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>Papel</legend>
      {ROLE_KEYS.map((r) => (
        <label key={r} className="checkbox role-option">
          <input
            type="radio"
            name={name}
            checked={value === r}
            disabled={!allowPrivileged && PRIVILEGED.includes(r)}
            onChange={() => onChange(r)}
          />
          <span>
            <strong>{ROLE_LABELS[r]}</strong> <span className="muted small">— {ROLE_HINTS[r]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function PasswordFields({ onValid }: { onValid: (password: string | null) => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const problem = a.length < MIN_PASSWORD ? `Mínimo de ${MIN_PASSWORD} caracteres.` : a !== b ? "As senhas não conferem." : "";
  useEffect(() => onValid(problem ? null : a), [a, problem, onValid]);
  return (
    <>
      <label>
        Senha
        <input type="password" autoComplete="new-password" value={a} minLength={MIN_PASSWORD} required onChange={(e) => setA(e.target.value)} />
      </label>
      <label>
        Confirme a senha
        <input
          type="password"
          autoComplete="new-password"
          value={b}
          required
          aria-invalid={Boolean(b) && a !== b}
          onChange={(e) => setB(e.target.value)}
        />
        {(a || b) && problem && <span className="field-hint error-text">{problem}</span>}
      </label>
    </>
  );
}

function CreateUserDialog({
  open,
  busy,
  allowPrivileged,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  allowPrivileged: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [role, setRole] = useState<RoleKey>("USER");
  const [password, setPassword] = useState<string | null>(null);
  const onValid = useCallback((p: string | null) => setPassword(p), []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!password) return;
    const data = new FormData(e.currentTarget);
    const ok = await onSubmit({
      username: String(data.get("username") ?? ""),
      realName: String(data.get("realName") ?? ""),
      displayName: String(data.get("displayName") ?? ""),
      password,
      role,
    });
    if (ok) setRole("USER");
  }
  return (
    <Dialog open={open} onClose={onClose} label="Novo usuário">
      <form onSubmit={submit}>
        <h2>Novo usuário</h2>
        <label>
          Usuário (login)
          <input name="username" required pattern="[a-z0-9._\-]{3,32}" maxLength={32} autoComplete="off" placeholder="ex.: socio" />
          <span className="field-hint">3 a 32 letras minúsculas, números, ponto, hífen ou sublinhado.</span>
        </label>
        <div className="grid-2 tight">
          <label>
            Nome real
            <input name="realName" maxLength={120} />
          </label>
          <label>
            Nome de exibição
            <input name="displayName" maxLength={60} />
          </label>
        </div>
        <PasswordFields onValid={onValid} />
        <RolePicker name="novo-papel" value={role} onChange={setRole} allowPrivileged={allowPrivileged} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy || !password}>{busy ? "Criando…" : "Criar usuário"}</button>
        </div>
      </form>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  busy,
  self,
  allowPrivileged,
  onClose,
  onSubmit,
}: {
  user: AdminUser;
  busy: boolean;
  self: boolean;
  allowPrivileged: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [realName, setRealName] = useState(user.realName ?? "");
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [role, setRole] = useState<RoleKey>(user.roles[0] ?? "USER");
  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (realName !== (user.realName ?? "")) body.realName = realName;
    if (displayName !== (user.displayName ?? "")) body.displayName = displayName;
    if (!self && (user.roles.length !== 1 || user.roles[0] !== role)) body.roles = [role];
    if (Object.keys(body).length === 0) return onClose();
    void onSubmit(body);
  }
  return (
    <Dialog open onClose={onClose} label={`Editar ${user.username}`}>
      <form onSubmit={submit}>
        <h2>Editar @{user.username}</h2>
        <div className="grid-2 tight">
          <label>
            Nome real
            <input value={realName} maxLength={120} onChange={(e) => setRealName(e.target.value)} />
          </label>
          <label>
            Nome de exibição
            <input value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        </div>
        <RolePicker name="editar-papel" value={role} onChange={setRole} allowPrivileged={allowPrivileged} disabled={self} />
        {self && <p className="field-hint">Você não pode alterar o próprio papel.</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordResetDialog({
  user,
  busy,
  onClose,
  onSubmit,
}: {
  user: AdminUser;
  busy: boolean;
  onClose: () => void;
  onSubmit: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const onValid = useCallback((p: string | null) => setPassword(p), []);
  return (
    <Dialog open onClose={onClose} label={`Redefinir senha de ${user.username}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void onSubmit(password);
        }}
      >
        <h2>Redefinir senha de @{user.username}</h2>
        <p className="muted small">As sessões abertas desse usuário serão encerradas. Passe a nova senha por um canal seguro.</p>
        <PasswordFields onValid={onValid} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy || !password}>{busy ? "Salvando…" : "Redefinir"}</button>
        </div>
      </form>
    </Dialog>
  );
}
