import type {
  ChatRequestInput,
  ChatResponseValue,
  SearchKindValue,
  SearchMeetingStatusValue,
  SearchModeValue,
  SearchResponseValue,
  SearchStatusValue,
} from "@meeting-bot/contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal } = {},
): Promise<T> {
  const init: RequestInit = { method: opts.method ?? "GET", credentials: "same-origin", signal: opts.signal };
  if (opts.json !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  } else if (opts.form) {
    init.body = opts.form;
  }
  const res = await fetch(`/api${path}`, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/login")) unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(String(body.error ?? `Erro ${res.status}`), res.status, body);
  }
  return body as T;
}

/** Falha que não precisa de aviso (ex.: marcar como visto): descarta sem função vazia. */
export const ignoreError = (): undefined => undefined;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- busca e chat (specs/003-busca-chat) ----------

export interface SearchParams {
  q: string;
  mode?: SearchModeValue;
  kind?: SearchKindValue[];
  projectId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponseValue> {
  const query = new URLSearchParams({ q: params.q });
  const optional: [string, string | undefined][] = [
    ["mode", params.mode],
    ["kind", params.kind?.join(",")],
    ["projectId", params.projectId],
    ["from", params.from],
    ["to", params.to],
    ["limit", params.limit?.toString()],
    ["offset", params.offset?.toString()],
  ];
  for (const [key, value] of optional) if (value) query.set(key, value);
  return api<SearchResponseValue>(`/search?${query}`, { signal });
}

/** Estado geral do índice, ou o de uma reunião quando `meetingId` é informado (404 = fora do alcance). */
export function searchStatus(meetingId?: undefined, signal?: AbortSignal): Promise<SearchStatusValue>;
export function searchStatus(meetingId: string, signal?: AbortSignal): Promise<SearchMeetingStatusValue>;
export function searchStatus(meetingId?: string, signal?: AbortSignal): Promise<SearchStatusValue | SearchMeetingStatusValue> {
  const suffix = meetingId ? `?meetingId=${encodeURIComponent(meetingId)}` : "";
  return api<SearchStatusValue | SearchMeetingStatusValue>(`/search/status${suffix}`, { signal });
}

/** Sem `meetingId`, enfileira todas as reuniões do próprio usuário. */
export function searchReindex(meetingId?: string): Promise<{ queued: number }> {
  return api<{ queued: number }>("/search/reindex", { method: "POST", json: meetingId ? { meetingId } : {} });
}

export function searchChat(request: ChatRequestInput, signal?: AbortSignal): Promise<ChatResponseValue> {
  return api<ChatResponseValue>("/search/chat", { method: "POST", json: request, signal });
}
