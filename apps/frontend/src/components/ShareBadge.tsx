import { Eye, Pencil, Sparkles, Users } from "lucide-react";
import type { MeetingListItem } from "@meeting-bot/contracts";
import { ACCESS_LABEL } from "../shares";

type Props = Pick<MeetingListItem, "access" | "ownerName" | "shareCount" | "shareUnseen">;

// Selo de reunião compartilhada. O nível aparece em texto e em ícone (nunca só por cor).
export function ShareBadge({ access, ownerName, shareCount, shareUnseen }: Readonly<Partial<Props> & Pick<Props, "access">>) {
  if (access === "owner") {
    if (!shareCount) return null;
    return (
      <span className="badge info small" title="Você é o dono e compartilhou esta reunião">
        <Users aria-hidden="true" size={12} /> Compartilhada com {shareCount}
      </span>
    );
  }
  const Icon = access === "edit" ? Pencil : Eye;
  const level = ACCESS_LABEL[access];
  const label = ownerName ? `Compartilhada por ${ownerName} · ${level}` : `Compartilhada · ${level}`;
  return (
    <>
      <span className="badge info small" title={access === "edit" ? "Você pode editar itens e falantes" : "Você só pode ler"}>
        <Icon aria-hidden="true" size={12} /> {label}
      </span>
      {shareUnseen && (
        <span className="badge primary small">
          <Sparkles aria-hidden="true" size={12} /> Nova
        </span>
      )}
    </>
  );
}
