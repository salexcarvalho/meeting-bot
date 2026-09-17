import { useEffect, useState } from "react";
import type { LlmChoice } from "@meeting-bot/contracts";
import { useSession } from "../session";
import { Dialog } from "./Dialog";

export interface GenerateRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** aviso mostrado quando o OpenRouter é escolhido */
  externalWarning: string;
}

// Pergunta onde gerar (modelo local ou OpenRouter) antes de cada geração sob demanda.
export function GenerateDialog({
  request,
  onClose,
  onConfirm,
}: {
  request: GenerateRequest | null;
  onClose: () => void;
  onConfirm: (llm: LlmChoice) => void;
}) {
  const { llm } = useSession();
  const externalReady = Boolean(llm.external?.available);
  const initial: LlmChoice = llm.default === "openrouter" && externalReady ? "openrouter" : "local";
  const [choice, setChoice] = useState<LlmChoice>(initial);

  useEffect(() => {
    if (request) setChoice(initial);
  }, [request, initial]);

  return (
    <Dialog open={request !== null} onClose={onClose} label={request?.title ?? "Gerar"}>
      {request && (
        <>
          <h2>{request.title}</h2>
          <p className="muted">{request.message}</p>
          <fieldset className="llm-choice">
            <legend>Gerar com</legend>
            <label className={`llm-option${choice === "local" ? " active" : ""}`}>
              <input
                type="radio"
                name="llm-choice"
                id="llm-choice-local"
                checked={choice === "local"}
                onChange={() => setChoice("local")}
              />
              <span>
                <strong>Modelo local</strong>
                <span className="small muted">{llm.local.model} · nada sai da máquina</span>
              </span>
            </label>
            {llm.external && (
              <label className={`llm-option${choice === "openrouter" ? " active" : ""}${externalReady ? "" : " disabled"}`}>
                <input
                  type="radio"
                  name="llm-choice"
                  id="llm-choice-openrouter"
                  disabled={!externalReady}
                  checked={choice === "openrouter"}
                  onChange={() => setChoice("openrouter")}
                />
                <span>
                  <strong>OpenRouter (externo)</strong>
                  <span className="small muted">
                    {llm.external.model}
                    {externalReady ? " · melhor qualidade, com custo por uso" : " · falta OPENROUTER_API_KEY no .env"}
                  </span>
                </span>
              </label>
            )}
          </fieldset>
          {choice === "openrouter" && (
            <p className="banner warn small" role="note">
              {request.externalWarning}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button
              type="button"
              className="primary"
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
