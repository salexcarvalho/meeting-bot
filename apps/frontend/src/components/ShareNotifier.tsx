import type { MeetingAccessEvent } from "@meeting-bot/contracts";
import { useLive } from "../hooks";
import { ACCESS_LABEL } from "../shares";
import { useToast } from "./Toast";

/** Texto do aviso de uma mudança de acesso; null quando não há o que avisar (lote, ou saída voluntária). */
export function accessNotice(msg: MeetingAccessEvent, onThatPage: boolean): string | null {
  if (msg.silent) return null;
  const who = msg.by ?? "Alguém";
  const level = msg.access ? ACCESS_LABEL[msg.access] : "";
  switch (msg.change) {
    case "granted":
      return `${who} compartilhou «${msg.title ?? "uma reunião"}» com você (${level}).`;
    case "changed":
      return `${who} alterou seu acesso a «${msg.title ?? "uma reunião"}» para ${level}.`;
    case "revoked":
      if (msg.by === null) return null; // o próprio usuário saiu da reunião
      return onThatPage ? "Seu acesso a esta reunião foi removido." : "Seu acesso a uma reunião foi removido.";
    default:
      return "A reunião foi excluída pelo dono.";
  }
}

// Avisos dentro do app (decisão Q3 = A): nada sai da máquina. Fica montado enquanto há sessão.
export function ShareNotifier() {
  const toast = useToast();
  useLive(
    (msg) => {
      if (msg.type !== "meeting_access") return;
      const text = accessNotice(msg, globalThis.location.pathname.endsWith(`/reunioes/${msg.meetingId}`));
      if (text) toast(text);
    },
    [toast],
  );
  return null;
}
