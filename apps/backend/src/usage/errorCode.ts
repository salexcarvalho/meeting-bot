import { USAGE_ERROR_CODES, type UsageErrorCodeValue } from "@meeting-bot/contracts";
import { UsageCarryingError } from "../llm/provider";

// Classificação fechada de erros do registro de uso. A mensagem original do provedor nunca é
// gravada: só um código curto (enum ou `http_<status>`).

const KNOWN = new Set<string>(USAGE_ERROR_CODES);
const TIMEOUT_MESSAGE = /não respondeu a tempo|timed out|timeout/i;
const TRUNCATED_MESSAGE = /cortada pelo limite/i;
const REFUSED_MESSAGE = /recusou a tarefa/i;
const SCHEMA_MESSAGE = /Resposta do LLM inválida|seguir o schema/i;
const DISABLED_MESSAGE = /desabilitad|não configurad/i;
const UNAVAILABLE_NAMES = new Set(["HostJobError", "SubscriptionLlmError", "WorkerUnavailableError"]);

interface MaybeCoded {
  status?: unknown;
  usageCode?: unknown;
  name?: unknown;
  message?: unknown;
  constructor?: { name?: unknown };
}

function explicitCode(err: MaybeCoded): UsageErrorCodeValue | null {
  if (typeof err.usageCode === "string" && KNOWN.has(err.usageCode)) return err.usageCode as UsageErrorCodeValue;
  if (typeof err.status === "number" && err.status >= 100 && err.status <= 599) return `http_${Math.trunc(err.status)}`;
  return null;
}

function byMessage(message: string): UsageErrorCodeValue | null {
  if (TIMEOUT_MESSAGE.test(message)) return "timeout";
  if (TRUNCATED_MESSAGE.test(message)) return "truncated";
  if (REFUSED_MESSAGE.test(message)) return "refused";
  if (SCHEMA_MESSAGE.test(message)) return "schema_invalid";
  if (DISABLED_MESSAGE.test(message)) return "disabled";
  return null;
}

/** Função pura: o mesmo erro sempre dá o mesmo código. */
export function classifyError(error: unknown): UsageErrorCodeValue {
  const err = (error instanceof UsageCarryingError ? error.causeError : error) as MaybeCoded | null | undefined;
  if (err === null || err === undefined || typeof err !== "object") return "other";
  const explicit = explicitCode(err);
  if (explicit) return explicit;
  if (err.name === "TimeoutError") return "timeout";
  if (err.name === "AbortError") return "cancelled";
  const message = typeof err.message === "string" ? err.message : "";
  const fromMessage = byMessage(message);
  if (fromMessage) return fromMessage;
  const className = typeof err.constructor?.name === "string" ? err.constructor.name : "";
  return UNAVAILABLE_NAMES.has(className) ? "unavailable" : "other";
}
