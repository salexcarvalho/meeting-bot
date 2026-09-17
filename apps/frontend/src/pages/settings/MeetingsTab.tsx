import { useState, type FormEvent } from "react";
import { FileText, ShieldCheck, Video } from "lucide-react";
import { DETAIL_LEVELS, DOC_FORMATS, type IdentityChoice, type MeResponse } from "@meeting-bot/contracts";
import { BotIdentityField } from "../../components/BotIdentityField";
import { CardHead } from "../../components/ui";
import { DETAIL_LABELS, FORMAT_LABELS } from "./AgentTab";
import { SaveBar, useMeMutation, type SetMe } from "./shared";

export function MeetingsTab({ me, setMe }: { me: MeResponse; setMe: SetMe }) {
  const { busy, run } = useMeMutation(setMe);
  const saved: IdentityChoice = {
    mode: me.settings.meetings.displayIdentity,
    customName: me.settings.meetings.customDisplayName ?? undefined,
  };
  const [identity, setIdentity] = useState<IdentityChoice>(saved);
  const dirty =
    identity.mode !== saved.mode || (identity.mode === "custom" && (identity.customName ?? "") !== (saved.customName ?? ""));

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(
      "/me/settings",
      {
        method: "PATCH",
        json: {
          meetings: {
            displayIdentity: identity.mode,
            ...(identity.mode === "custom" ? { customDisplayName: identity.customName ?? "" } : {}),
          },
        },
      },
      "Preferências de reunião salvas.",
    );
  }

  return (
    <div className="grid-2">
      <form className="card" onSubmit={submit}>
        <CardHead title="Identidade na reunião" icon={Video} />
        <p className="card-desc">
          Padrão usado quando você envia o assistente para um Meet ou Teams. Dá para trocar em cada envio.
        </p>
        <BotIdentityField idPrefix="config" value={identity} onChange={setIdentity} />
        <p className="small">
          Hoje: <strong>{me.botDisplayName}</strong>
        </p>
        <SaveBar busy={busy} dirty={dirty} />
      </form>

      <section className="card">
        <CardHead title="Transparência e limites" icon={ShieldCheck} />
        <ul className="plain-list small">
          <li>
            O assistente entra como <strong>convidado anônimo</strong> e sempre com o sufixo que o identifica como
            assistente automatizado gravando. Não há opção para esconder isso.
          </li>
          <li>O nome é definido antes de entrar; Meet e Teams não deixam convidados trocarem de nome depois.</li>
          <li>
            <strong>Sem foto na reunião:</strong> Meet e Teams mostram só as iniciais de convidados, e o assistente
            não liga câmera. O avatar do agente aparece apenas dentro deste sistema.
          </li>
          <li>Avise os participantes de que a reunião está sendo gravada e transcrita (LGPD).</li>
        </ul>
      </section>
    </div>
  );
}

export function DocumentationTab({ me, setMe }: { me: MeResponse; setMe: SetMe }) {
  const { busy, run } = useMeMutation(setMe);
  const saved = me.settings.documentation;
  const [form, setForm] = useState(saved);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run("/me/settings", { method: "PATCH", json: { documentation: form } }, "Preferências de documentação salvas.");
  }

  return (
    <form className="card narrow-card" onSubmit={submit}>
      <CardHead title="Documentação gerada" icon={FileText} />
      <p className="card-desc">Como você prefere receber atas, anotações e demais documentos gerados pela IA.</p>
      <fieldset>
        <legend>Nível de detalhe</legend>
        <div className="segmented" role="radiogroup">
          {DETAIL_LEVELS.map((d) => (
            <label key={d} className={form.detailLevel === d ? "active" : ""}>
              <input type="radio" name="detail" checked={form.detailLevel === d} onChange={() => setForm({ ...form, detailLevel: d })} />
              {DETAIL_LABELS[d]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Formatos</legend>
        {DOC_FORMATS.map((f) => (
          <label key={f} className="checkbox">
            <input
              type="checkbox"
              checked={form.formats.includes(f)}
              disabled={form.formats.length === 1 && form.formats.includes(f)}
              onChange={(e) =>
                setForm({ ...form, formats: e.target.checked ? [...form.formats, f] : form.formats.filter((x) => x !== f) })
              }
            />
            {FORMAT_LABELS[f]}
          </label>
        ))}
      </fieldset>
      <SaveBar busy={busy} dirty={dirty} />
    </form>
  );
}
