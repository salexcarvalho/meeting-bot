import type { MeetingSummary } from "@meeting-bot/contracts";

type LinkCheck = Pick<MeetingSummary, "source" | "status" | "skipRecording" | "url" | "scheduledEnd">;

/** Reunião da agenda a gravar, ainda por vir ou em andamento, sem link: o assistente não tem onde entrar. */
export function missingLink(m: LinkCheck, now = Date.now()): boolean {
  if (m.source !== "ics" && m.source !== "manual") return false;
  if (m.status !== "scheduled" || m.skipRecording || m.url) return false;
  return !m.scheduledEnd || new Date(m.scheduledEnd).getTime() > now;
}

/** Selo "Sem link" com a ação de colar o link (abre a edição da reunião); sem `onFix`, só o selo. */
export function NoLinkBadge({ meeting, onFix }: { meeting: LinkCheck; onFix?: () => void }) {
  if (!missingLink(meeting)) return null;
  return (
    <>
      <span className="badge warn" title="Sem link do Teams/Meet o assistente não entra sozinho">
        Sem link
      </span>
      {onFix && (
        <button type="button" className="small" onClick={onFix}>
          Adicionar link
        </button>
      )}
    </>
  );
}
