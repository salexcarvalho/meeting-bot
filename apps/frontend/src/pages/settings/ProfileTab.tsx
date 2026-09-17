import { useMemo, useState, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { LANGUAGES, ROLE_LABELS, type Language, type MeResponse } from "@meeting-bot/contracts";
import { CardHead } from "../../components/ui";
import { fileForm, ImageField, SaveBar, useMeMutation, type SetMe } from "./shared";

const LANGUAGE_LABELS: Record<Language, string> = { "pt-BR": "Português (Brasil)", "en-US": "English (US)", "es-ES": "Español" };
const FALLBACK_TIMEZONES = ["America/Sao_Paulo", "America/Manaus", "America/Recife", "America/Fortaleza", "UTC"];

function timezones(current: string): string[] {
  const all = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? FALLBACK_TIMEZONES;
  return all.includes(current) ? all : [current, ...all];
}

export function ProfileTab({ me, setMe }: { me: MeResponse; setMe: SetMe }) {
  const { profile } = me;
  const { busy, run } = useMeMutation(setMe);
  const [form, setForm] = useState({
    realName: profile.realName ?? "",
    displayName: profile.displayName ?? "",
    language: profile.language,
    timezone: profile.timezone,
  });
  const zones = useMemo(() => timezones(profile.timezone), [profile.timezone]);
  const dirty =
    form.realName !== (profile.realName ?? "") ||
    form.displayName !== (profile.displayName ?? "") ||
    form.language !== profile.language ||
    form.timezone !== profile.timezone;

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run("/me/profile", { method: "PATCH", json: form }, "Perfil salvo.");
  }

  return (
    <div className="grid-2">
      <form className="card" onSubmit={submit}>
        <CardHead title="Seus dados" icon={UserRound} />
        <p className="card-desc">O nome de exibição aparece no menu, nas reuniões e no canal do seu microfone.</p>
        <label>
          Usuário
          <input value={profile.username} disabled />
        </label>
        <label>
          Nome real
          <input
            value={form.realName}
            maxLength={120}
            autoComplete="name"
            onChange={(e) => setForm({ ...form, realName: e.target.value })}
            placeholder="Ex.: Sérgio Alex Carvalho"
          />
        </label>
        <label>
          Nome de exibição
          <input
            value={form.displayName}
            maxLength={60}
            autoComplete="nickname"
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            placeholder="Ex.: Sérgio"
          />
          <span className="field-hint">Vazio usa o nome real (ou o usuário).</span>
        </label>
        <div className="grid-2 tight">
          <label>
            Idioma
            <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as Language })}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>{LANGUAGE_LABELS[l]}</option>
              ))}
            </select>
          </label>
          <label>
            Fuso horário
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
              ))}
            </select>
          </label>
        </div>
        <SaveBar busy={busy} dirty={dirty} />
      </form>

      <section className="card">
        <CardHead title="Foto e acesso" />
        <ImageField
          label="Sua foto"
          name={profile.name}
          src={profile.hasAvatar ? `/api/me/avatar?v=${profile.avatarVersion}` : null}
          busy={busy}
          onUpload={(file) => void run("/me/avatar", { method: "PUT", form: fileForm(file, file.name) }, "Foto atualizada.")}
          onRemove={() => void run("/me/avatar", { method: "DELETE" }, "Foto removida.")}
          hint="Aparece só dentro deste sistema. PNG, JPEG ou WebP, até 2 MB."
        />
        <dl className="facts">
          <dt>Papéis</dt>
          <dd>
            {profile.roles.map((r) => (
              <span key={r} className="badge primary">{ROLE_LABELS[r]}</span>
            ))}
          </dd>
          <dt>Conta criada em</dt>
          <dd>{new Date(profile.createdAt).toLocaleDateString("pt-BR")}</dd>
        </dl>
      </section>
    </div>
  );
}
