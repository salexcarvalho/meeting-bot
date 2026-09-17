import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { formatDateTime } from "../format";
import { Markdown } from "./Markdown";
import { useToast } from "./Toast";

interface AtaResponse {
  markdown: string | null;
  generatedAt: string | null;
  hasAnalysis: boolean;
}

export function AtaView({ meetingId, version, waitingText }: { meetingId: string; version: string; waitingText: string }) {
  const toast = useToast();
  const [ata, setAta] = useState<AtaResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<AtaResponse>(`/meetings/${meetingId}/ata`)
      .then((a) => {
        setAta(a);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)));
  }, [meetingId]);

  useEffect(load, [load, version]);

  async function copy() {
    if (!ata?.markdown) return;
    try {
      await navigator.clipboard.writeText(ata.markdown);
      toast("Ata copiada.");
    } catch {
      toast("Não consegui copiar; use o download.", "error");
    }
  }

  if (error) return <p className="error-text">{error}</p>;
  if (!ata) return <p className="muted">Carregando…</p>;
  if (!ata.markdown) return <p className="muted">{waitingText}</p>;
  return (
    <>
      <div className="row between" style={{ marginBottom: 8 }}>
        <span className="small muted">
          {ata.generatedAt ? `Análise de ${formatDateTime(ata.generatedAt)}; itens no estado atual.` : "Ata da versão anterior."}
        </span>
        <div className="row">
          <button type="button" className="small" onClick={load}>Atualizar</button>
          <button type="button" className="small" onClick={copy}>Copiar</button>
          <a className="button small" href={`/api/meetings/${meetingId}/ata.md`} download>Baixar .md</a>
        </div>
      </div>
      <Markdown source={ata.markdown} />
    </>
  );
}
