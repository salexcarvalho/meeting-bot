import { useEffect, useState } from "react";
import { DISPLAY_IDENTITIES, DISPLAY_IDENTITY_LABELS, type DisplayIdentity, type IdentityChoice } from "@meeting-bot/contracts";
import { api } from "../api";

// Escolha de como o bot aparece na reunião, com prévia do nome final (sempre com o sufixo de gravação).
export function BotIdentityField({
  value,
  onChange,
  idPrefix,
}: {
  value: IdentityChoice;
  onChange: (value: IdentityChoice) => void;
  idPrefix: string;
}) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (value.mode === "custom" && !value.customName?.trim()) {
      setPreview("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ botDisplayName: string }>("/me/identity-preview", { method: "POST", json: value, signal: controller.signal })
        .then((r) => setPreview(r.botDisplayName))
        .catch(() => {});
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  return (
    <fieldset className="identity-field">
      <legend>Nome na reunião</legend>
      <div className="segmented" role="radiogroup">
        {DISPLAY_IDENTITIES.map((mode: DisplayIdentity) => (
          <label key={mode} className={value.mode === mode ? "active" : ""}>
            <input
              type="radio"
              name={`${idPrefix}-identity`}
              value={mode}
              checked={value.mode === mode}
              onChange={() => onChange({ mode, customName: mode === "custom" ? (value.customName ?? "") : undefined })}
            />
            {DISPLAY_IDENTITY_LABELS[mode]}
          </label>
        ))}
      </div>
      {value.mode === "custom" && (
        <label>
          Nome personalizado
          <input
            maxLength={40}
            required
            value={value.customName ?? ""}
            onChange={(e) => onChange({ mode: "custom", customName: e.target.value })}
            placeholder="Ex.: Ata da equipe"
          />
        </label>
      )}
      <p className="field-hint" aria-live="polite">
        {preview ? (
          <>
            Vai aparecer como <strong>{preview}</strong>.
          </>
        ) : (
          " "
        )}{" "}
        O sufixo que identifica o assistente automatizado é sempre incluído.
      </p>
    </fieldset>
  );
}
