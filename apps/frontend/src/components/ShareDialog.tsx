import { useCallback, useEffect, useId, useState } from "react";
import { Share2, Trash2, X } from "lucide-react";
import type {
  ShareAccess,
  ShareEntry,
  ShareListResponse,
  ShareMutationResponse,
  ShareScope,
  UserLookupItem,
} from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { LOOKUP_MIN_CHARS, useUserLookup } from "../hooks";
import { ACCESS_LABEL } from "../shares";
import { formatDateTime } from "../format";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

function Avatar({ name }: Readonly<{ name: string }>) {
  return (
    <span className="avatar-initials" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

const SMALL_MUTED = "small muted";

/** Alcance em série: "só esta" (padrão) ou "esta e as próximas". Só aparece quando a reunião tem série. */
function ScopePicker({
  following,
  value,
  onChange,
}: Readonly<{ following: number; value: ShareScope; onChange: (v: ShareScope) => void }>) {
  const name = useId();
  return (
    <fieldset className="share-scope">
      <legend>Alcance</legend>
      <label className="check">
        <input type="radio" name={name} checked={value === "occurrence"} onChange={() => onChange("occurrence")} />
        Só esta ocorrência
      </label>
      <label className="check">
        <input type="radio" name={name} checked={value === "following"} onChange={() => onChange("following")} />
        Esta e as próximas já na agenda
      </label>
      {value === "following" && (
        <p className={SMALL_MUTED} role="status">
          Vale para {following} ocorrência(s). Ocorrências passadas ficam de fora, e as criadas depois não herdam o acesso.
        </p>
      )}
    </fieldset>
  );
}

function LevelSelect({
  value,
  canEdit,
  label,
  onChange,
  disabled,
}: Readonly<{ value: ShareAccess; canEdit: boolean; label: string; onChange: (v: ShareAccess) => void; disabled?: boolean }>) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ShareAccess)}>
      <option value="read">Leitura</option>
      <option value="edit" disabled={!canEdit}>
        Edição{canEdit ? "" : " (indisponível)"}
      </option>
    </select>
  );
}

function SearchBox({
  onPick,
  excluded,
}: Readonly<{ onPick: (u: UserLookupItem) => void; excluded: Set<string> }>) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const lookup = useUserLookup(query);
  const results = lookup.users.filter((u) => !excluded.has(u.id));
  const short = query.trim().length > 0 && query.trim().length < LOOKUP_MIN_CHARS;
  return (
    <div className="share-search">
      <label htmlFor={`${listId}-q`}>Buscar pessoa (nome ou usuário)</label>
      <input
        id={`${listId}-q`}
        type="search"
        autoComplete="off"
        autoFocus
        value={query}
        maxLength={64}
        placeholder="Digite ao menos 3 letras"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div aria-live="polite" className={SMALL_MUTED}>
        {short && `Digite ao menos ${LOOKUP_MIN_CHARS} caracteres.`}
        {lookup.loading && "Buscando…"}
        {!lookup.loading && lookup.searched && !lookup.error && results.length === 0 && "Ninguém encontrado."}
        {lookup.error && <span className="error-text">{lookup.error}</span>}
      </div>
      <ul id={listId} role="listbox" aria-label="Resultados da busca" className="share-results">
        {results.map((u) => (
          <li key={u.id} role="option" aria-selected="false">
            <button
              type="button"
              onClick={() => {
                onPick(u);
                setQuery("");
              }}
            >
              <Avatar name={u.name} />
              <span>
                {u.name} <span className="muted">@{u.username}</span>
              </span>
              <span className="badge small">{u.canEdit ? "leitura ou edição" : "só leitura"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShareRow({
  entry,
  busy,
  onChange,
  onRemove,
}: Readonly<{
  entry: ShareEntry;
  busy: boolean;
  onChange: (access: ShareAccess) => void;
  onRemove: () => void;
}>) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="share-row">
      <Avatar name={entry.name} />
      <div className="share-who">
        <strong>{entry.name}</strong> <span className="muted">@{entry.username}</span>
        <div className={`${SMALL_MUTED} row`}>
          <span>desde {formatDateTime(entry.grantedAt)}</span>
          {!entry.seen && <span className="badge small">ainda não abriu</span>}
          {!entry.active && <span className="badge warn small">Desativado</span>}
          {entry.access === "edit" && entry.effectiveAccess === "read" && (
            <span className="badge warn small" title="O papel atual da pessoa só permite ler">só leitura efetiva</span>
          )}
        </div>
      </div>
      {confirming ? (
        <div className="share-confirm" role="group" aria-label={`Remover o acesso de ${entry.name}`}>
          <span className="small">Remover o acesso de {entry.name}?</span>
          <button type="button" className="small" onClick={() => setConfirming(false)}>Cancelar</button>
          <button type="button" className="small danger solid" disabled={busy} onClick={onRemove}>Remover</button>
        </div>
      ) : (
        <div className="row">
          <LevelSelect
            value={entry.access}
            canEdit
            label={`Nível de ${entry.name}`}
            disabled={busy}
            onChange={onChange}
          />
          <button type="button" className="icon" aria-label={`Remover o acesso de ${entry.name}`} onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      )}
    </li>
  );
}

/** Diálogo de compartilhamento (só o dono): busca, nível, alcance em série, lista de acessos, troca e remoção. */
export function ShareDialog({
  open,
  onClose,
  meetingId,
  title,
  onChanged,
}: Readonly<{ open: boolean; onClose: () => void; meetingId: string; title: string; onChanged?: () => void }>) {
  const toast = useToast();
  const [data, setData] = useState<ShareListResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<UserLookupItem | null>(null);
  const [access, setAccess] = useState<ShareAccess>("read");
  const [scope, setScope] = useState<ShareScope>("occurrence");

  const load = useCallback(() => {
    api<ShareListResponse>(`/meetings/${meetingId}/shares`)
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)));
  }, [meetingId]);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setPicked(null);
    setAccess("read");
    setScope("occurrence");
    load();
  }, [open, load]);

  async function run<T>(fn: () => Promise<T>, success: (r: T) => string) {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      toast(success(result));
      load();
      onChanged?.();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function grant() {
    if (!picked) return;
    const ok = await run(
      () => api<ShareMutationResponse>(`/meetings/${meetingId}/shares`, { method: "POST", json: { userId: picked.id, access, scope } }),
      (r) => `${picked.name} agora tem acesso de ${ACCESS_LABEL[access]}${r.affected > 1 ? ` a ${r.affected} reuniões` : ""}.`,
    );
    if (ok) setPicked(null);
  }

  const change = (entry: ShareEntry, next: ShareAccess) =>
    run(
      () => api<ShareMutationResponse>(`/meetings/${meetingId}/shares/${entry.userId}`, { method: "PUT", json: { access: next, scope } }),
      () => `${entry.name} agora tem acesso de ${ACCESS_LABEL[next]}.`,
    );

  const remove = (entry: ShareEntry) =>
    run(
      () => api(`/meetings/${meetingId}/shares/${entry.userId}?scope=${scope}`, { method: "DELETE" }),
      () => `Acesso de ${entry.name} removido.`,
    );

  const shares = data?.shares ?? [];
  const taken = new Set(shares.map((s) => s.userId));

  return (
    <Dialog open={open} onClose={onClose} label="Compartilhar reunião" className="share-dialog">
      <div className="dialog-head row between">
        <h2>
          <Share2 aria-hidden="true" size={18} /> Compartilhar
        </h2>
        <button type="button" className="icon" aria-label="Fechar" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <p className={SMALL_MUTED}>«{title}»</p>
      <p className="banner info small">
        Quem receber verá o link, os participantes, a transcrição e o áudio desta reunião. Só você gerencia o acesso.
      </p>

      <SearchBox onPick={setPicked} excluded={taken} />

      {picked && (
        <div className="share-pick" role="group" aria-label="Novo acesso">
          <Avatar name={picked.name} />
          <strong>{picked.name}</strong> <span className="muted">@{picked.username}</span>
          <LevelSelect value={access} canEdit={picked.canEdit} label="Nível do novo acesso" onChange={setAccess} />
          <button type="button" className="primary" disabled={busy} onClick={() => void grant()}>
            Compartilhar
          </button>
          <button type="button" onClick={() => setPicked(null)}>Cancelar</button>
        </div>
      )}
      {picked && !picked.canEdit && <p className={SMALL_MUTED}>Esta pessoa só pode receber leitura.</p>}

      {data?.series && <ScopePicker following={data.series.following} value={scope} onChange={setScope} />}

      <div aria-live="polite">
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>

      <h3 className="share-heading">Quem tem acesso</h3>
      {!data && !error && <p className={SMALL_MUTED}>Carregando…</p>}
      {data && shares.length === 0 && <p className={SMALL_MUTED}>Só você tem acesso a esta reunião.</p>}
      {shares.length > 0 && (
        <ul className="share-list" aria-label="Quem tem acesso">
          {shares.map((s) => (
            <ShareRow key={s.userId} entry={s} busy={busy} onChange={(next) => void change(s, next)} onRemove={() => void remove(s)} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}
