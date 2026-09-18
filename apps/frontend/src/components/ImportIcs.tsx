import { useRef, useState, type DragEvent } from "react";
import type { ImportResult } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { useToast } from "./Toast";

function summary(r: ImportResult): string {
  const parts = [
    r.created && `${r.created} nova(s)`,
    r.updated && `${r.updated} atualizada(s)`,
    r.cancelled && `${r.cancelled} cancelada(s)`,
    r.unchanged && `${r.unchanged} sem mudança`,
    r.ignored && `${r.ignored} ignorada(s)`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nenhuma reunião encontrada.";
}

export function ImportIcs({ onImported }: { onImported: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => /\.ics$/i.test(f.name) || f.type === "text/calendar");
    if (!list.length) return toast("Selecione arquivos .ics.", "error");
    const form = new FormData();
    list.slice(0, 10).forEach((f) => form.append("files", f));
    setBusy(true);
    try {
      const r = await api<ImportResult>("/calendar/import", { method: "POST", form });
      setResult(r);
      const aviso = r.partialSeries.length ? " — sem a repetição da série, veja abaixo" : "";
      toast(summary(r) + aviso, r.errors.length ? "error" : "info");
      onImported();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  }

  return (
    <div>
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p>Arraste convites <strong>.ics</strong> do Outlook/Teams aqui</p>
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? "Importando…" : "Escolher arquivos"}
        </button>
        <input
          ref={input}
          type="file"
          accept=".ics,text/calendar"
          multiple
          hidden
          onChange={(e) => e.target.files && void upload(e.target.files)}
        />
      </div>
      {result && (
        <p className="small muted" style={{ marginTop: 8 }}>
          Última importação: {summary(result)}
          {result.partialSeries.length > 0 && (
            <span style={{ display: "block", marginTop: 4 }}>
              ⚠ {result.partialSeries.length === 1 ? "Uma reunião veio" : `${result.partialSeries.length} reuniões vieram`}{" "}
              só com a ocorrência do dia, sem a repetição ({result.partialSeries.join(", ")}). No Outlook, abra a
              reunião, escolha <strong>Toda a série</strong> e salve como iCalendar — assim a agenda recebe os
              próximos 31 dias.
            </span>
          )}
          {result.errors.map((e) => (
            <span key={e.file} className="error-text" style={{ display: "block" }}>
              {e.file}: {e.message}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
