import { useState, type FormEvent } from "react";
import { UserCheck } from "lucide-react";
import type { MeResponse } from "@meeting-bot/contracts";
import { CardHead } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { formatDateTime } from "../../format";
import { useMeMutation, type SetMe } from "./shared";

export function TeamsAccountCard({ me, setMe, readOnly }: { me: MeResponse; setMe: SetMe; readOnly: boolean }) {
  const account = me.teamsAccount;
  const { busy, run } = useMeMutation(setMe);
  const toast = useToast();
  const [name, setName] = useState(account.accountName ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);

  async function connect(e: FormEvent) {
    e.preventDefault();
    if (!file) return toast("Escolha o arquivo da sessão (teams-session.json).", "error");
    const form = new FormData();
    form.append("accountName", name);
    form.append("file", file, file.name);
    const ok = await run("/me/agent/teams-account", { method: "PUT", form }, "Conta do agente conectada.");
    if (ok) {
      setFile(null);
      setInputKey((k) => k + 1);
    }
  }

  return (
    <form className="card" onSubmit={connect}>
      <CardHead title="Conta do agente no Teams" icon={UserCheck} />
      <p className="card-desc">
        Sem conta, o assistente entra no Teams como convidado sem conta. Com uma conta só do agente, ele entra logado e
        aparece com o nome dela. Use uma conta dedicada, nunca a sua.
      </p>

      {account.connected ? (
        <p className="small">
          <span className={`badge ${account.problem ? "error" : account.expired ? "warn" : "ok"}`}>
            {account.problem ? "Não usada" : account.expired ? "Sessão vencida" : "Conectada"}
          </span>{" "}
          <strong>{account.accountName}</strong>
          {account.updatedAt && <span className="muted"> · sessão de {formatDateTime(account.updatedAt)}</span>}
        </p>
      ) : (
        <p className="small muted">Nenhuma conta conectada: o assistente entra como convidado.</p>
      )}
      {account.problem && <div className="banner error">{account.problem} O assistente entra como convidado enquanto isso.</div>}
      {account.expired && !account.problem && (
        <div className="banner warn">
          A última entrada caiu para convidado porque a sessão venceu. Gere e envie a sessão de novo.
        </div>
      )}

      <label>
        Nome da conta no Teams
        <input
          value={name}
          maxLength={60}
          disabled={busy || readOnly}
          onChange={(e) => setName(e.target.value)}
          placeholder='Ex.: Ata do Sérgio'
        />
        <span className="field-hint">Precisa dizer que é a ata (ex.: "Ata do Sérgio"). Ajuste na conta da Microsoft se preciso.</span>
      </label>
      <label>
        Arquivo da sessão
        <input
          key={inputKey}
          type="file"
          accept="application/json,.json"
          disabled={busy || readOnly}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <details className="small">
        <summary>Como gerar o arquivo</summary>
        <ol>
          <li>
            Na máquina com o projeto: <code>npm run teams:login</code>.
          </li>
          <li>No navegador que abrir, entre com a conta do agente e escolha "Manter conectado".</li>
          <li>Volte ao terminal, aperte Enter e envie o <code>teams-session.json</code> aqui.</li>
          <li>Apague o arquivo depois: a sessão fica guardada cifrada, só neste sistema.</li>
        </ol>
        <p className="muted">A senha nunca passa por aqui. A sessão dura enquanto a Microsoft a mantiver; se vencer, repita.</p>
      </details>
      <div className="save-bar">
        {account.connected && (
          <button
            type="button"
            disabled={busy || readOnly}
            onClick={() => void run("/me/agent/teams-account", { method: "DELETE" }, "Conta do agente removida.")}
          >
            Remover conta
          </button>
        )}
        <button className="primary" disabled={busy || readOnly || !file || name.trim().length < 2}>
          {busy ? "Enviando…" : account.connected ? "Trocar sessão" : "Conectar conta"}
        </button>
      </div>
    </form>
  );
}
