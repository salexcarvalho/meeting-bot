import type { MeetingStatus, StatusLabel } from "@meeting-bot/contracts";

const TONE: Record<StatusLabel, string> = {
  Próxima: "info",
  "Em andamento": "live",
  Transcrevendo: "warn",
  Processando: "warn",
  Concluída: "ok",
  "Não gravada": "",
  Cancelada: "",
  Erro: "error",
};

const DETAIL: Partial<Record<MeetingStatus, string>> = {
  joining: "entrando",
  waiting_admission: "aguardando admissão",
  stopping: "finalizando",
  queued: "na fila",
};

export function StatusBadge({ status, label }: { status: MeetingStatus; label: StatusLabel }) {
  const detail = DETAIL[status];
  return (
    <span className={`badge ${TONE[label]}`} title={status}>
      {label}
      {detail ? ` · ${detail}` : ""}
    </span>
  );
}
