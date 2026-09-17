import { useState, type FormEvent } from "react";
import { AudioLines, Eye, EyeOff } from "lucide-react";
import { api, errorMessage } from "../api";
import type { Session } from "../session";

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

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
              <span className="password-field">
                <input
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="ghost password-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Esconder senha" : "Mostrar senha"}
                  aria-pressed={showPassword}
                  title={showPassword ? "Esconder senha" : "Mostrar senha"}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary block" disabled={busy}>
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </form>
          <button type="button" className="link auth-help-link" onClick={() => setShowHelp((v) => !v)} aria-expanded={showHelp}>
            Esqueceu sua senha?
          </button>
          {showHelp && (
            <div className="auth-help small" role="note">
              <p>
                Não há recuperação por e-mail: nada sai desta máquina. Peça a um administrador para redefinir em
                <strong> Configurações &gt; Usuários</strong>.
              </p>
              <p>Se você é o único administrador, redefina no servidor:</p>
              <code>docker compose exec backend npm run user:passwd -- seu-usuario</code>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
