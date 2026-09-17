import { randomUUID } from "crypto";
import type { AgentLlmJob, AgentLlmResult } from "@meeting-bot/contracts";

// Fila em memória dos pedidos de geração que o host-agent executa com o CLI da assinatura
// (claude/codex). O host-agent busca por long-poll em /api/agent/llm/next e devolve em
// /api/agent/llm/:id/result. Nada vai para o banco: se o backend reinicia, o pipeline também.

export class HostJobError extends Error {}

type NewJob = Omit<AgentLlmJob, "id">;

interface Entry {
  job: AgentLlmJob;
  claimed: boolean;
  resolve: (result: AgentLlmResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface HostJobQueueOptions {
  /** tempo para o host-agent pegar o pedido antes de desistir */
  claimTimeoutMs: number;
  /** folga além do timeout do próprio CLI */
  graceMs: number;
}

export class HostJobQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly opts: HostJobQueueOptions = { claimTimeoutMs: 45_000, graceMs: 60_000 }) {}

  get size(): number {
    return this.entries.size;
  }

  submit(input: NewJob): Promise<AgentLlmResult> {
    const job: AgentLlmJob = { ...input, id: randomUUID() };
    return new Promise<AgentLlmResult>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(job.id, "O host-agent não pegou o pedido (está ligado nesta máquina?)."),
        this.opts.claimTimeoutMs,
      );
      this.entries.set(job.id, { job, claimed: false, resolve, reject, timer });
      this.waiting.slice().forEach((wake) => wake());
    });
  }

  /** Próximo pedido não entregue; espera até `waitMs` por um novo. */
  async next(waitMs: number, signal?: AbortSignal): Promise<AgentLlmJob | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const entry = [...this.entries.values()].find((e) => !e.claimed);
      if (entry) {
        entry.claimed = true;
        clearTimeout(entry.timer);
        const limit = entry.job.timeoutSeconds * 1000 + this.opts.graceMs;
        entry.timer = setTimeout(() => this.fail(entry.job.id, "O CLI não respondeu a tempo."), limit);
        return entry.job;
      }
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return null;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", wake);
          const i = this.waiting.indexOf(wake);
          if (i >= 0) this.waiting.splice(i, 1);
          resolve();
        };
        const timer = setTimeout(wake, left);
        signal?.addEventListener("abort", wake, { once: true });
        this.waiting.push(wake);
      });
    }
  }

  /** Resultado do host-agent. Falso se o pedido não existe mais (expirou ou não foi entregue). */
  complete(id: string, result: AgentLlmResult): boolean {
    const entry = this.entries.get(id);
    if (!entry || !entry.claimed) return false;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  /** Devolve à fila um pedido entregue a uma conexão que caiu antes de receber. */
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.claimed) return;
    entry.claimed = false;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.fail(id, "O host-agent não pegou o pedido (está ligado nesta máquina?)."),
      this.opts.claimTimeoutMs,
    );
    this.waiting.slice().forEach((wake) => wake());
  }

  /** Cancela tudo (host-agent trocou de dono, backend encerrando). */
  failAll(message: string): void {
    for (const id of [...this.entries.keys()]) this.fail(id, message);
  }

  private fail(id: string, message: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new HostJobError(message));
  }
}

export const hostJobs = new HostJobQueue();
