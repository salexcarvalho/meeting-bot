import { useState, type FormEvent } from "react";
import { AudioLines } from "lucide-react";
import { api, errorMessage } from "../api";
import type { Session } from "../session";

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const session = await api<Session>("/auth/login", {
        method: "POST",
        json: { username: form.get("username"), password: form.get("password") },
      });
      onLogin(session);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <aside className="auth-aside" aria-hidden="true">
        <div className="brand">
          <span className="brand-mark">
            <AudioLines size={20} />
          </span>
          <span className="brand-name">Agente de Reuniões</span>
        </div>
        <p className="auth-quote">Agenda, gravação, transcrição e ata — tudo nesta máquina.</p>
        <p className="auth-aside-foot">Itens gerados pela IA ficam como propostos até a sua revisão.</p>
        <AudioLines className="auth-watermark" size={384} strokeWidth={1.25} />
      </aside>
      <main className="auth-main">
        <div className="auth-form">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <AudioLines size={20} />
            </span>
            <span className="brand-name">Agente de Reuniões</span>
          </div>
          <h1>Entrar</h1>
          <p className="muted" style={{ marginBottom: 24 }}>Tudo roda nesta máquina. Entre com seu usuário.</p>
          <form onSubmit={submit}>
            <label>
              Usuário
              <input name="username" autoComplete="username" required autoFocus />
            </label>
            <label>
              Senha
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary block" disabled={busy}>
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
