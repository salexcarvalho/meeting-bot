import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../api";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";

export function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = String(form.get("next") ?? "");
    if (next !== String(form.get("confirm") ?? "")) return setError("A confirmação não confere.");
    setBusy(true);
    setError("");
    try {
      await api("/auth/password", {
        method: "POST",
        json: { currentPassword: form.get("current"), newPassword: next },
      });
      toast("Senha alterada. Outras sessões foram encerradas.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} label="Trocar senha">
      <form onSubmit={submit}>
        <h2>Trocar senha</h2>
        <label>
          Senha atual
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
        <label>
          Nova senha (mín. 10 caracteres)
          <input name="next" type="password" autoComplete="new-password" minLength={10} required />
        </label>
        <label>
          Confirmar nova senha
          <input name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={busy}>Salvar</button>
        </div>
      </form>
    </Dialog>
  );
}
