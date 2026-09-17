import { useCallback, useEffect, useState } from "react";
import type { LiveServerMessage, Project } from "@meeting-bot/contracts";
import { api } from "./api";
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
