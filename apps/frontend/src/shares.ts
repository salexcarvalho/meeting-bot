import type { MeetingAccessEvent, MeetingListItem, MeetingSummary, ShareAccess } from "@meeting-bot/contracts";

// Compartilhamento (specs/005): textos e a mescla do evento difundido `meeting`, que é igual para todos
// e por isso NÃO traz os campos por espectador (access, ownerName, shareCount, shareUnseen).

export const ACCESS_LABEL: Record<ShareAccess, string> = { read: "leitura", edit: "edição" };

const SHARED_BY_ME = "shared_by_me";

export type ListScope = "all" | "mine" | "shared" | typeof SHARED_BY_ME;

/** Escopo da lista na URL (`?escopo=`) e no backend (`scope=`). */
export const SCOPES: { key: string; scope: ListScope; label: string }[] = [
  { key: "", scope: "all", label: "Todas" },
  { key: "minhas", scope: "mine", label: "Minhas" },
  { key: "compartilhadas", scope: "shared", label: "Compartilhadas comigo" },
  { key: "por-mim", scope: SHARED_BY_ME, label: "Compartilhadas por mim" },
];

export function scopeOf(key: string): ListScope {
  return SCOPES.find((s) => s.key === key)?.scope ?? "all";
}

/** O item pertence ao escopo escolhido? (para decidir se um evento ao vivo entra na lista) */
export function inScope(item: MeetingListItem, scope: ListScope): boolean {
  if (scope === "mine") return item.access === "owner";
  if (scope === "shared") return item.access !== "owner";
  if (scope === SHARED_BY_ME) return item.access === "owner" && (item.shareCount ?? 0) > 0;
  return true;
}

/**
 * Aplica um resumo difundido a um item da lista preservando o que é por espectador. Sem item anterior só dá
 * para montar o item se o usuário é o dono; para reunião de outra pessoa devolve null (recarregue a lista).
 */
export function mergeSummary(
  prev: MeetingListItem | undefined,
  summary: MeetingSummary,
  selfUsername: string,
): MeetingListItem | null {
  if (prev) return { ...summary, access: prev.access, ownerName: prev.ownerName, shareCount: prev.shareCount, shareUnseen: prev.shareUnseen };
  if (summary.createdBy !== selfUsername) return null;
  return { ...summary, access: "owner", ownerName: null, shareCount: 0, shareUnseen: false };
}

export interface ListFilters {
  projectId: string;
  status: string;
  scope: ListScope;
}

const whenOf = (m: MeetingSummary) => m.startedAt ?? m.scheduledStart ?? m.createdAt;

function matches(item: MeetingListItem, f: ListFilters): boolean {
  if (f.projectId && item.project?.id !== f.projectId) return false;
  if (f.status && !f.status.split(",").includes(item.status)) return false;
  return inScope(item, f.scope);
}

/** Aplica o resumo difundido de uma reunião à lista; `reload` pede recarregar quando não dá para montar o item. */
export function applySummary(
  list: MeetingListItem[] | null,
  summary: MeetingSummary,
  selfUsername: string,
  filters: ListFilters,
): { list: MeetingListItem[] | null; reload: boolean } {
  if (!list) return { list, reload: false };
  const prev = list.find((m) => m.id === summary.id);
  const item = mergeSummary(prev, summary, selfUsername);
  if (!item) return { list, reload: true };
  if (prev) return { list: list.map((m) => (m.id === item.id ? item : m)), reload: false };
  if (!matches(item, filters)) return { list, reload: false };
  return { list: [item, ...list].sort((a, b) => whenOf(b).localeCompare(whenOf(a))), reload: false };
}

/** Aplica um evento direcionado `meeting_access` à lista: entra, muda de nível ou sai, sem recarregar. */
export function applyAccessEvent(
  list: MeetingListItem[] | null,
  msg: MeetingAccessEvent,
  filters: ListFilters,
): MeetingListItem[] | null {
  if (!list) return list;
  if (msg.change === "revoked" || msg.change === "deleted") return list.filter((m) => m.id !== msg.meetingId);
  if (msg.change === "changed") {
    return list.map((m) => (m.id === msg.meetingId && msg.access ? { ...m, access: msg.access } : m));
  }
  const item = msg.meeting;
  if (!item) return list;
  if (list.some((m) => m.id === item.id)) return list.map((m) => (m.id === item.id ? item : m));
  if (!matches(item, filters)) return list;
  return [item, ...list].sort((a, b) => whenOf(b).localeCompare(whenOf(a)));
}
