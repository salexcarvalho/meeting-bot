import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";

interface ResumoResponse {
  text: string;
  approved: number;
  pending: number;
}

// Resumo curto (só itens aprovados) para colar no Teams ou no e-mail.
export function ResumoDialog({ meetingId, open, onClose }: { meetingId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [resumo, setResumo] = useState<ResumoResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setResumo(null);
    setError("");
    api<ResumoResponse>(`/meetings/${meetingId}/resumo`)
      .then(setResumo)
      .catch((err) => setError(errorMessage(err)));
  }, [open, meetingId]);

  async function copy() {
    if (!resumo) return;
    try {
      await navigator.clipboard.writeText(resumo.text);
      toast("Resumo copiado.");
    } catch {
      toast("Não consegui copiar; selecione o texto e copie.", "error");
    }
  }

  return (
    <Dialog open={open} onClose={onClose} label="Resumo para enviar">
      <h2>Resumo para enviar</h2>
      {error && <p className="error-text">{error}</p>}
      {!resumo && !error && <p className="muted">Carregando…</p>}
      {resumo && (
        <>
          <p className="small muted">
            Só entram itens aprovados.
            {resumo.pending > 0 &&
              ` ${resumo.pending} ${resumo.pending === 1 ? "item ainda não revisado ficou" : "itens ainda não revisados ficaram"} de fora.`}
          </p>
          <label htmlFor="resumo-texto" className="sr-only">Texto do resumo</label>
          <textarea id="resumo-texto" readOnly rows={16} value={resumo.text} style={{ width: "100%" }} />
        </>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" onClick={onClose}>Fechar</button>
        <button type="button" className="primary" onClick={copy} disabled={!resumo}>Copiar resumo</button>
      </div>
    </Dialog>
  );
}
