import { useEffect, useState } from "react";
import type { LlmChoice, LlmOptions } from "@meeting-bot/contracts";
import { api } from "../api";
import { generationWarning, useSession, type GenerationScope } from "../session";
import { Dialog } from "./Dialog";

export interface GenerateRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** o que sai da máquina se a geração for externa */
  scope: GenerationScope;
}

export interface LlmChoiceOption {
  value: LlmChoice;
  title: string;
  detail: string;
  available: boolean;
}

const SUBSCRIPTION_TITLES = { claude: "Claude (sua assinatura)", codex: "Codex (sua assinatura)" } as const;

/** Onde dá para gerar agora nesta reunião (a assinatura depende do host-agent e do dono). */
export function useLlmOptions(meetingId: string, active: boolean): LlmOptions {
  const { llm } = useSession();
  const [options, setOptions] = useState<LlmOptions>(llm);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    api<LlmOptions>(`/meetings/${meetingId}/llm-options`, { signal: abort.signal })
      .then(setOptions)
      .catch(() => {});
    return () => abort.abort();
  }, [meetingId, active]);
  return options;
}

export function llmChoiceOptions(llm: LlmOptions): LlmChoiceOption[] {
  const options: LlmChoiceOption[] = [
    { value: "local", title: "Modelo local", detail: `${llm.local.model} · nada sai da máquina`, available: true },
  ];
  if (llm.external) {
    options.push({
      value: "openrouter",
      title: "OpenRouter (externo)",
      detail: `${llm.external.model} · ${llm.external.available ? "melhor qualidade, com custo por uso" : "falta OPENROUTER_API_KEY no .env"}`,
      available: llm.external.available,
    });
  }
  for (const sub of llm.subscriptions ?? []) {
    options.push({
      value: sub.id,
      title: SUBSCRIPTION_TITLES[sub.id],
      detail: `${sub.model} · ${sub.available ? "sem custo extra; usa o limite do seu plano" : sub.reason ?? "indisponível"}`,
      available: sub.available,
    });
  }
  return options;
}

export function defaultChoice(llm: LlmOptions): LlmChoice {
  const found = llmChoiceOptions(llm).find((o) => o.value === llm.default);
  return found?.available ? found.value : "local";
}

// Pergunta onde gerar (modelo local, OpenRouter ou assinatura) antes de cada geração sob demanda.
export function GenerateDialog({
  meetingId,
  request,
  onClose,
  onConfirm,
}: {
  meetingId: string;
  request: GenerateRequest | null;
  onClose: () => void;
  onConfirm: (llm: LlmChoice) => void;
}) {
  const llm = useLlmOptions(meetingId, request !== null);
  const options = llmChoiceOptions(llm);
  const initial = defaultChoice(llm);
  const [choice, setChoice] = useState<LlmChoice>(initial);

  useEffect(() => {
    if (request) setChoice(initial);
  }, [request, initial]);

  const selected = options.find((o) => o.value === choice);
  const warning = request ? generationWarning(choice, request.scope) : null;

  return (
    <Dialog open={request !== null} onClose={onClose} label={request?.title ?? "Gerar"}>
      {request && (
        <>
          <h2>{request.title}</h2>
          <p className="muted">{request.message}</p>
          <fieldset className="llm-choice">
            <legend>Gerar com</legend>
            {options.map((o) => (
              <label
                key={o.value}
                className={`llm-option${choice === o.value ? " active" : ""}${o.available ? "" : " disabled"}`}
              >
                <input
                  type="radio"
                  name="llm-choice"
                  id={`llm-choice-${o.value}`}
                  disabled={!o.available}
                  checked={choice === o.value}
                  onChange={() => setChoice(o.value)}
                />
                <span>
                  <strong>{o.title}</strong>
                  <span className="small muted">{o.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {warning && (
            <p className="banner warn small" role="note">
              {warning}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button
              type="button"
              className="primary"
              disabled={!selected?.available}
              onClick={() => {
                onConfirm(choice);
                onClose();
              }}
            >
              {request.confirmLabel}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
