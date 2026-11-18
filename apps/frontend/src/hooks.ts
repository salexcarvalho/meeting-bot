import { useCallback, useEffect, useState } from "react";
import type { LiveServerMessage, Project, UserLookupItem } from "@meeting-bot/contracts";
import { api, errorMessage } from "./api";
import { live } from "./live";

export function useProjects(): { projects: Project[]; reload: () => void } {
  const [projects, setProjects] = useState<Project[]>([]);
  const reload = useCallback(() => {
    api<{ projects: Project[] }>("/projects")
      .then((r) => setProjects(r.projects))
      .catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  return { projects, reload };
}

export const LOOKUP_MIN_CHARS = 3;
export const LOOKUP_DEBOUNCE_MS = 300;

export interface UserLookupState {
  users: UserLookupItem[];
  loading: boolean;
  error: string;
  /** a busca foi feita para o texto atual (distingue "sem resultado" de "ainda não buscou") */
  searched: boolean;
}

const LOOKUP_IDLE: UserLookupState = { users: [], loading: false, error: "", searched: false };

/** Busca de usuário para compartilhar: espera 300 ms de pausa, exige 3 caracteres e cancela a busca anterior. */
export function useUserLookup(query: string, enabled = true): UserLookupState {
  const [state, setState] = useState<UserLookupState>(LOOKUP_IDLE);
  const text = query.trim();
  useEffect(() => {
    if (!enabled || text.length < LOOKUP_MIN_CHARS) {
      setState(LOOKUP_IDLE);
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: "" }));
    const timer = window.setTimeout(() => {
      api<{ users: UserLookupItem[] }>(`/users/lookup?q=${encodeURIComponent(text)}`, { signal: controller.signal })
        .then((r) => setState({ users: r.users, loading: false, error: "", searched: true }))
        .catch((err) => {
          if (controller.signal.aborted) return;
          setState({ users: [], loading: false, error: errorMessage(err), searched: true });
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text, enabled]);
  return state;
}

export function useLive(handler: (msg: LiveServerMessage) => void, deps: unknown[]): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => live.on(handler), deps);
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
