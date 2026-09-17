import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { MeResponse } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { PageHeader, SkeletonLines } from "../components/ui";
import { AgentTab } from "./settings/AgentTab";
import { DocumentationTab, MeetingsTab } from "./settings/MeetingsTab";
import { ProfileTab } from "./settings/ProfileTab";

const TABS = [
  { key: "perfil", label: "Perfil" },
  { key: "agente", label: "Meu agente" },
  { key: "reunioes", label: "Reuniões" },
  { key: "documentacao", label: "Documentação" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function Configuracoes() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("aba");
  const tab: TabKey = TABS.some((t) => t.key === requested) ? (requested as TabKey) : "perfil";
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<MeResponse>("/me")
      .then(setMe)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <main className="container">
      <PageHeader title="Configurações" description="Suas preferências. Cada usuário tem as próprias." />
      <div className="tabs" role="tablist" aria-label="Seções de configuração">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`aba-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="painel-config"
            onClick={() => setParams(t.key === "perfil" ? {} : { aba: t.key }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="painel-config" role="tabpanel" aria-labelledby={`aba-${tab}`}>
        {error && <div className="banner error">{error}</div>}
        {!me && !error && (
          <section className="card">
            <SkeletonLines lines={4} />
          </section>
        )}
        {me && tab === "perfil" && <ProfileTab key={me.profile.id} me={me} setMe={setMe} />}
        {me && tab === "agente" && <AgentTab me={me} setMe={setMe} />}
        {me && tab === "reunioes" && <MeetingsTab me={me} setMe={setMe} />}
        {me && tab === "documentacao" && <DocumentationTab me={me} setMe={setMe} />}
      </div>
    </main>
  );
}
