import type { AgentLlmResult, SubscriptionLlm } from "@meeting-bot/contracts";
import { z } from "zod";
import { audit } from "../security/audit";
import { classifyError } from "../usage/errorCode";
import { ownerOfMeeting } from "../usage/recorder";
import { HostJobError, type HostJobQueue } from "./hostJobs";
import { toJsonSchema } from "./schema";
import { UsageMeter, type Generation, type GenerateRequest, type LLMProvider } from "./provider";

// Geração com a assinatura pessoal (Constituição 1.4.0, princípio I): o host-agent roda o CLI
// oficial (claude -p / codex exec) isolado, sem ferramentas, com o login do dono da máquina.
// O backend nunca vê credenciais; recebe só o JSON, que é validado de novo aqui.

export interface HostCliSettings {
  provider: SubscriptionLlm;
  /** vazio = modelo padrão do CLI */
  model: string;
  timeoutSeconds: number;
}

export class SubscriptionLlmError extends Error {}

/** O CLI desistiu de encaixar a resposta no schema: é resposta inválida, não falha do CLI. */
const OUTPUT_RETRIES = /max_structured_output_retries/i;

const NAMES: Record<SubscriptionLlm, string> = { claude: "Claude", codex: "Codex" };

function retryNote(previous: string, problem: string): string {
  return (
    `\n\n---\nSua resposta anterior não seguiu o schema (${problem}).\n` +
    `Resposta anterior:\n${previous.slice(0, 4000)}\n` +
    "Responda de novo apenas com o JSON válido."
  );
}

export class HostCliLlm implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly settings: HostCliSettings,
    private readonly jobs: HostJobQueue,
  ) {
    this.name = settings.provider;
  }

  get model(): string {
    return this.settings.model || "padrão";
  }

  async generate<T>(req: GenerateRequest<T>): Promise<Generation<T>> {
    const meter = new UsageMeter(this.model);
    return meter.run(() => this.attempts(req, meter));
  }

  /** Rastro de saída (princípio I): só metadados, com o dono da reunião; nunca o conteúdo. */
  private async auditSent<T>(req: GenerateRequest<T>, detail: Record<string, unknown>): Promise<void> {
    const owner = req.meetingId ? await ownerOfMeeting(req.meetingId).catch(() => null) : null;
    audit(
      "external_llm",
      { meetingId: req.meetingId ?? null, label: req.label, provider: this.settings.provider, purpose: req.purpose, ...detail },
      owner,
    );
  }

  private async attempts<T>(req: GenerateRequest<T>, meter: UsageMeter): Promise<T> {
    // O Claude encurta o texto para caber no limite; o Codex corta no meio da frase, então só o
    // Claude recebe os tamanhos máximos (o zod confere os dois depois).
    const schema = toJsonSchema(req.schema, { limits: this.settings.provider === "claude" }) as Record<string, unknown>;
    let user = req.user;
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.runAudited(req, user, schema);
      meter.add({
        inputTokens: result.ok ? result.usage?.inputTokens : null,
        outputTokens: result.ok ? result.usage?.outputTokens : null,
        // assinatura: sem custo por chamada
        costUsd: null,
        model: result.ok ? result.usage?.model : null,
      });
      if (!result.ok) {
        lastError = await this.refusal(req, result.error);
        user = req.user + retryNote("(sem resposta)", lastError);
        continue;
      }
      await this.auditSent(req, {
        model: result.usage?.model ?? this.model,
        promptTokens: result.usage?.inputTokens ?? null,
        completionTokens: result.usage?.outputTokens ?? null,
        // assinatura: sem custo por chamada
        cost: null,
        durationMs: result.durationMs ?? null,
        success: true,
      });
      console.log(
        `[llm-assinatura] ${this.settings.provider} ${req.label}: ` +
          `${result.usage?.inputTokens ?? "?"}+${result.usage?.outputTokens ?? "?"} tokens` +
          (result.durationMs !== undefined ? ` em ${(result.durationMs / 1000).toFixed(1)}s` : ""),
      );
      const checked = this.check(req, result.output);
      if (checked.ok) return checked.data;
      lastError = checked.problem;
      user = req.user + retryNote(checked.previous, lastError);
    }
    throw new Error(`Resposta do LLM inválida (${req.label}): ${lastError}`);
  }

  /** Envia ao host-agent; falha de transporte também vira linha de auditoria (com código). */
  private async runAudited<T>(
    req: GenerateRequest<T>,
    user: string,
    schema: Record<string, unknown>,
  ): Promise<AgentLlmResult> {
    try {
      return await this.run(req, user, schema);
    } catch (err) {
      await this.auditSent(req, { model: this.model, success: false, errorCode: classifyError(err) });
      throw err;
    }
  }

  /** Erro do CLI: só "desistiu do schema" é resposta inválida (nova tentativa); o resto derruba a geração. */
  private async refusal<T>(req: GenerateRequest<T>, error: string | undefined): Promise<string> {
    if (OUTPUT_RETRIES.test(error ?? "")) return `${NAMES[this.settings.provider]} não conseguiu seguir o schema`;
    const failure = new SubscriptionLlmError(`${NAMES[this.settings.provider]}: ${error}`);
    await this.auditSent(req, { model: this.model, success: false, errorCode: classifyError(failure) });
    throw failure;
  }

  /** Valida a saída (objeto ou JSON em texto) contra o schema. */
  private check<T>(
    req: GenerateRequest<T>,
    raw: unknown,
  ): { ok: true; data: T } | { ok: false; problem: string; previous: string } {
    let output = raw;
    if (typeof output === "string") {
      try {
        output = JSON.parse(output);
      } catch {
        return { ok: false, problem: "JSON inválido", previous: String(raw) };
      }
    }
    const parsed = req.schema.safeParse(output);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, problem: z.prettifyError(parsed.error).slice(0, 800), previous: JSON.stringify(output) };
  }

  private async run<T>(req: GenerateRequest<T>, user: string, schema: Record<string, unknown>): Promise<AgentLlmResult> {
    try {
      return await this.jobs.submit({
        provider: this.settings.provider,
        model: this.settings.model,
        system: req.system,
        user,
        schema,
        timeoutSeconds: this.settings.timeoutSeconds,
      });
    } catch (err) {
      if (err instanceof HostJobError) throw new SubscriptionLlmError(`${NAMES[this.settings.provider]}: ${err.message}`);
      throw err;
    }
  }
}
