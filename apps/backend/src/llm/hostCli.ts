import type { AgentLlmResult, SubscriptionLlm } from "@meeting-bot/contracts";
import { z } from "zod";
import { audit } from "../security/audit";
import { classifyError } from "../usage/errorCode";
import { ownerOfMeeting } from "../usage/recorder";
import { HostJobError, type HostJobQueue } from "./hostJobs";
import { toJsonSchema } from "./ollama";
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
      const result = await this.run(req, user, schema).catch(async (err) => {
        await this.auditSent(req, { model: this.model, success: false, errorCode: classifyError(err) });
        throw err;
      });
      meter.add({
        inputTokens: result.ok ? result.usage?.inputTokens : null,
        outputTokens: result.ok ? result.usage?.outputTokens : null,
        // assinatura: sem custo por chamada
        costUsd: null,
        model: result.ok ? result.usage?.model : null,
      });
      if (!result.ok) {
        if (!OUTPUT_RETRIES.test(result.error ?? "")) {
          const failure = new SubscriptionLlmError(`${NAMES[this.settings.provider]}: ${result.error}`);
          await this.auditSent(req, { model: this.model, success: false, errorCode: classifyError(failure) });
          throw failure;
        }
        lastError = `${NAMES[this.settings.provider]} não conseguiu seguir o schema`;
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
      let output = result.output;
      if (typeof output === "string") {
        try {
          output = JSON.parse(output);
        } catch {
          lastError = "JSON inválido";
          user = req.user + retryNote(String(result.output), lastError);
          continue;
        }
      }
      const parsed = req.schema.safeParse(output);
      if (parsed.success) return parsed.data;
      lastError = z.prettifyError(parsed.error).slice(0, 800);
      user = req.user + retryNote(JSON.stringify(output), lastError);
    }
    throw new Error(`Resposta do LLM inválida (${req.label}): ${lastError}`);
  }

  async unload(): Promise<void> {
    // nada a liberar: roda fora da GPU
  }

  async health(): Promise<{ ok: boolean; model: string; error?: string }> {
    return { ok: true, model: this.model };
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
