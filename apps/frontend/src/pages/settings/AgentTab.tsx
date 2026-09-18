import { useState, type FormEvent } from "react";
import { AudioLines, Bot, Info } from "lucide-react";
import {
  DETAIL_LEVELS,
  DOC_FORMATS,
  ITEM_TYPE_LABELS,
  ITEM_TYPES,
  LANGUAGES,
  TONES,
  type AgentProfile,
  type MeResponse,
} from "@meeting-bot/contracts";
import { CardHead } from "../../components/ui";
import { useCan } from "../../session";
import { fileForm, ImageField, SaveBar, useMeMutation, type SetMe } from "./shared";
import { VoiceRecorder } from "./VoiceRecorder";

export const DETAIL_LABELS = { resumido: "Resumido", normal: "Normal", detalhado: "Detalhado" } as const;
export const FORMAT_LABELS = { markdown: "Markdown", topicos: "Tópicos", tabela: "Tabelas" } as const;
const TONE_LABELS = { formal: "Formal", neutro: "Neutro", direto: "Direto" } as const;
const LANGUAGE_LABELS = { "pt-BR": "Português", "en-US": "Inglês", "es-ES": "Espanhol" } as const;

type Editable = Omit<AgentProfile, "hasAvatar" | "avatarVersion" | "hasVoice" | "voiceVersion" | "voiceDurationSeconds" | "updatedAt">;

function editable(agent: AgentProfile): Editable {
  const { hasAvatar: _a, avatarVersion: _b, hasVoice: _c, voiceVersion: _d, voiceDurationSeconds: _e, updatedAt: _f, ...rest } = agent;
  return rest;
}

const splitTags = (text: string) =>
  [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 30);

export function AgentTab({ me, setMe }: { me: MeResponse; setMe: SetMe }) {
  const { agent } = me;
  const can = useCan();
  const readOnly = !can("agents.manage");
  const { busy, run } = useMeMutation(setMe);
  const [form, setForm] = useState<Editable>(() => editable(agent));
  const [techText, setTechText] = useState(agent.priorityTechnologies.join(", "));
  const saved = JSON.stringify(editable(agent));
  const blank = (v: string | null) => (v === null || v.trim() === "" ? null : v);
  const current: Editable = {
    ...form,
    description: blank(form.description),
    role: blank(form.role),
    specialty: blank(form.specialty),
    basePrompt: blank(form.basePrompt),
    professionalContext: blank(form.professionalContext),
    priorityTechnologies: splitTags(techText),
  };
  const dirty = JSON.stringify(current) !== saved;
  const set = <K extends keyof Editable>(key: K, value: Editable[K]) => setForm((f) => ({ ...f, [key]: value }));
  const text = (key: "description" | "role" | "specialty" | "basePrompt" | "professionalContext") => ({
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
    disabled: readOnly,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run("/me/agent", { method: "PATCH", json: current }, "Agente salvo.")) {
      setTechText(current.priorityTechnologies.join(", "));
    }
  }

  return (
    <div className="grid-main-aside">
      <form className="card" onSubmit={submit}>
        <CardHead title="Meu agente" icon={Bot} />
        <p className="card-desc">
          Persona do agente arquiteto que acompanha suas reuniões. Estes dados são só seus e ficam nesta máquina.
        </p>
        <div className="grid-2 tight">
          <label>
            Nome do agente
            <input value={form.name} required minLength={2} maxLength={40} disabled={readOnly} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label>
            Papel
            <input maxLength={120} placeholder="Ex.: Arquiteto de software sênior" {...text("role")} />
          </label>
        </div>
        <label>
          Descrição
          <textarea maxLength={500} rows={2} placeholder="Como o agente se apresenta" {...text("description")} />
        </label>
        <label>
          Especialidade
          <input maxLength={200} placeholder="Ex.: integrações, mensageria, segurança" {...text("specialty")} />
        </label>
        <label>
          Tecnologias prioritárias
          <input
            value={techText}
            disabled={readOnly}
            onChange={(e) => setTechText(e.target.value)}
            placeholder="Kafka, PostgreSQL, Kubernetes"
          />
          <span className="field-hint">Separe por vírgula.</span>
        </label>
        <fieldset>
          <legend>Tipos de decisão para destacar</legend>
          <div className="check-grid">
            {ITEM_TYPES.map((t) => (
              <label key={t} className="checkbox">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={form.highlightDecisionTypes.includes(t)}
                  onChange={(e) =>
                    set(
                      "highlightDecisionTypes",
                      e.target.checked ? [...form.highlightDecisionTypes, t] : form.highlightDecisionTypes.filter((x) => x !== t),
                    )
                  }
                />
                {ITEM_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          Prompt base
          <textarea maxLength={4000} rows={5} placeholder="Instruções gerais para o agente" {...text("basePrompt")} />
        </label>
        <label>
          Contexto profissional
          <textarea maxLength={4000} rows={4} placeholder="Empresa, sistemas, restrições conhecidas…" {...text("professionalContext")} />
        </label>
        <div className="grid-4">
          <label>
            Formato
            <select value={form.docFormat} disabled={readOnly} onChange={(e) => set("docFormat", e.target.value as Editable["docFormat"])}>
              {DOC_FORMATS.map((f) => (
                <option key={f} value={f}>{FORMAT_LABELS[f]}</option>
              ))}
            </select>
          </label>
          <label>
            Idioma
            <select value={form.language} disabled={readOnly} onChange={(e) => set("language", e.target.value as Editable["language"])}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>{LANGUAGE_LABELS[l]}</option>
              ))}
            </select>
          </label>
          <label>
            Tom
            <select value={form.tone} disabled={readOnly} onChange={(e) => set("tone", e.target.value as Editable["tone"])}>
              {TONES.map((t) => (
                <option key={t} value={t}>{TONE_LABELS[t]}</option>
              ))}
            </select>
          </label>
          <label>
            Detalhe
            <select value={form.detailLevel} disabled={readOnly} onChange={(e) => set("detailLevel", e.target.value as Editable["detailLevel"])}>
              {DETAIL_LEVELS.map((d) => (
                <option key={d} value={d}>{DETAIL_LABELS[d]}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="banner info small" role="note">
          <Info size={16} aria-hidden="true" />
          <span>
            O prompt base, o contexto e as preferências ficam guardados agora; o agente arquiteto passa a usá-los quando os
            prompts forem para o banco (fase 3 do plano). A análise continua 100% local.
          </span>
        </div>
        {!readOnly && <SaveBar busy={busy} dirty={dirty} />}
      </form>

      <div className="aside-stack">
        <section className="card">
          <CardHead title="Imagem do agente" />
          <ImageField
            label="Avatar do agente"
            name={agent.name}
            src={agent.hasAvatar ? `/api/me/agent/avatar?v=${agent.avatarVersion}` : null}
            busy={busy || readOnly}
            onUpload={(file) => void run("/me/agent/avatar", { method: "PUT", form: fileForm(file, file.name) }, "Avatar do agente atualizado.")}
            onRemove={() => void run("/me/agent/avatar", { method: "DELETE" }, "Avatar do agente removido.")}
            hint="Usado dentro deste sistema. Convidado anônimo não exibe foto no Meet e no Teams."
          />
        </section>
        <section className="card">
          <CardHead title="Voz / nome falado" icon={AudioLines} />
          <p className="card-desc">
            Grave como o nome do agente deve ser pronunciado (até 60 s). Fica guardado só nesta máquina, para
            identificação e para uma futura voz local. O assistente continua entrando mudo nas reuniões.
          </p>
          <VoiceRecorder
            src={agent.hasVoice ? `/api/me/agent/voice?v=${agent.voiceVersion}` : null}
            duration={agent.voiceDurationSeconds}
            busy={busy || readOnly}
            onSave={(blob, name) => void run("/me/agent/voice", { method: "PUT", form: fileForm(blob, name) }, "Gravação salva.")}
            onRemove={() => void run("/me/agent/voice", { method: "DELETE" }, "Gravação removida.")}
          />
        </section>
      </div>
    </div>
  );
}
