import { Link } from "react-router";
import type { ChatCitationValue } from "@meeting-bot/contracts";
import { targetPath } from "../searchUi";

/**
 * Marcador [n] da resposta (variante "inline") ou o chip completo da lista de fontes ("full",
 * com reunião, data e horário). Os dois levam ao trecho citado na reunião.
 */
export function CitationChip({ citation, variant = "inline" }: { citation: ChatCitationValue; variant?: "inline" | "full" }) {
  const full = variant === "full";
  return (
    <Link
      className={`citation-chip${full ? " full" : ""}`}
      to={targetPath(citation.target)}
      title={citation.label}
      aria-label={`Fonte ${citation.ref}: ${citation.label}`}
    >
      {full ? `[${citation.ref}] ${citation.label}` : `[${citation.ref}]`}
    </Link>
  );
}
