import type {
  SearchHitValue,
  SearchIndexStatusValue,
  SearchModeValue,
  SearchSemanticReason,
  SearchTargetValue,
  SnippetPartValue,
} from "@meeting-bot/contracts";

// Textos e utilitários compartilhados pela busca, pelo chat e pela página da reunião.

export const MODE_LABELS: Record<SearchModeValue, string> = {
  hybrid: "Híbrido (texto e semântico)",
  text: "Só texto",
  semantic: "Só semântico",
};

const SEMANTIC_REASON_TEXT: Record<SearchSemanticReason, string> = {
  ollama_indisponivel: "o modelo local (Ollama) não está respondendo",
  modelo_ausente: "o modelo de busca semântica não está instalado",
  sem_pgvector: "o banco de dados não tem a extensão pgvector",
  desligada: "a busca semântica está desligada neste servidor",
  indexando: "as reuniões ainda estão sendo indexadas",
};

export function semanticReasonText(reason: SearchSemanticReason | null | undefined): string {
  return reason ? SEMANTIC_REASON_TEXT[reason] : "motivo não informado";
}

const CHAT_UNAVAILABLE_TEXT: Record<string, string> = {
  desligado: "o chat está desligado neste servidor",
  ollama_indisponivel: "o modelo local (Ollama) está indisponível",
};

export function chatUnavailableText(reason: string | null | undefined): string {
  return (reason && CHAT_UNAVAILABLE_TEXT[reason]) || "indisponível no momento";
}

export const INDEX_BADGES: Record<SearchIndexStatusValue, { label: string; tone: string; hint: string }> = {
  indexed: { label: "Indexada para busca", tone: "ok", hint: "Texto e busca semântica disponíveis para esta reunião." },
  text_ready: { label: "Indexada por texto", tone: "info", hint: "Só a busca por texto está disponível; a semântica ainda não." },
  pending: { label: "Indexando…", tone: "", hint: "Na fila para entrar na busca." },
  indexing: { label: "Indexando…", tone: "", hint: "Entrando na busca agora." },
  failed: { label: "Falha na indexação", tone: "error", hint: "Não foi possível indexar esta reunião para a busca." },
};

export function matchedByLabel(matchedBy: SearchHitValue["matchedBy"]): string {
  const text = matchedBy.includes("text");
  const semantic = matchedBy.includes("semantic");
  if (text && semantic) return "encontrado por texto e semântica";
  return semantic ? "encontrado por semântica" : "encontrado por texto";
}

/** Link da interface para o trecho (contrato rest-api.md, "Navegação"). */
export function targetPath(target: SearchTargetValue): string {
  const params = new URLSearchParams();
  const entries: [string, string | null][] = [
    ["seg", target.kind === "transcript" && target.segmentId !== null ? String(target.segmentId) : null],
    ["t", target.kind === "transcript" && target.start !== null ? String(Math.round(target.start * 10) / 10) : null],
    ["item", target.kind === "item" ? target.itemId : null],
    ["adr", target.kind === "adr" ? target.adrId : null],
  ];
  for (const [key, value] of entries) if (value) params.set(key, value);
  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  return `/reunioes/${target.meetingId}${suffix}`;
}

export interface KeyedSnippetPart extends SnippetPartValue {
  key: number;
}

/** Chave estável por posição no texto (sem usar índice de array). */
export function keyedSnippet(parts: SnippetPartValue[]): KeyedSnippetPart[] {
  let offset = 0;
  return parts.map((part) => {
    const keyed = { ...part, key: offset };
    offset += part.text.length + 1;
    return keyed;
  });
}

export interface MeetingGroup {
  meeting: SearchHitValue["meeting"];
  hits: SearchHitValue[];
}

/** Agrupa por reunião mantendo a ordem de relevância da primeira ocorrência. */
export function groupByMeeting(hits: SearchHitValue[]): MeetingGroup[] {
  const groups = new Map<string, MeetingGroup>();
  for (const hit of hits) {
    const group = groups.get(hit.meeting.id);
    if (group) group.hits.push(hit);
    else groups.set(hit.meeting.id, { meeting: hit.meeting, hits: [hit] });
  }
  return [...groups.values()];
}
