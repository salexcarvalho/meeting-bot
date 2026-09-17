import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Download, RefreshCw, Send, Sparkles } from "lucide-react";
import { api, errorMessage } from "../api";
import { formatDateTime } from "../format";
import { isExternal, llmLabel } from "../session";
import { Markdown } from "./Markdown";
import { ResumoDialog } from "./ResumoDialog";
import { useToast } from "./Toast";

interface AtaResponse {
  markdown: string | null;
  generatedAt: string | null;
  hasAnalysis: boolean;
}

interface AtaSection {
  id: string;
  title: string;
  body: string;
  /** linhas de lista (itens da seção) */
  count: number;
  empty: boolean;
}

// Cabeçalho do template: vira uma ficha no topo em vez de cinco seções.
const FACTS = ["Data", "Horário", "Duração", "Projeto", "Participantes"];
const EMPTY = "_Nada registrado._";

const slug = (title: string) =>
  `ata-${title
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;

/** Separa a ata (Markdown do template) em avisos, seções e anexo (ata antiga). */
function parseAta(markdown: string) {
  const notes: string[] = [];
  const sections: AtaSection[] = [];
  let appendix: string[] | null = null;
  let current: { title: string; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    sections.push({
      id: slug(current.title),
      title: current.title,
      body,
      count: current.lines.filter((l) => /^\s*[-*]\s/.test(l)).length,
      empty: body === "" || body === EMPTY,
    });
    current = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (appendix) {
      appendix.push(line);
      continue;
    }
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      close();
      current = { title: heading[1].trim(), lines: [] };
    } else if (/^-{3,}\s*$/.test(line) && (current || sections.length)) {
      close();
      appendix = [];
    } else if (current) {
      current.lines.push(line);
    } else if (line.startsWith(">")) {
      notes.push(line.replace(/^>\s?/, ""));
    }
  }
  close();
  return { notes, sections, appendix: appendix?.join("\n").trim() || null };
}

function factValue(section: AtaSection | undefined): string {
  if (!section || section.empty) return "—";
  return section.body.replace(/_\(sugerido\)_/, "(sugerido)");
}

export function AtaView({
  meetingId,
  version,
  waitingText,
  provider,
  generate,
}: {
  meetingId: string;
  version: string;
  waitingText: string;
  /** quem gerou a análise (`analysis_provider`) */
  provider: string | null;
  generate: { label: string; onClick: () => void } | null;
}) {
  const toast = useToast();
  const [ata, setAta] = useState<AtaResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resumoOpen, setResumoOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api<AtaResponse>(`/meetings/${meetingId}/ata`)
      .then((a) => {
        setAta(a);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [meetingId]);

  useEffect(load, [load, version]);

  const doc = useMemo(() => (ata?.markdown ? parseAta(ata.markdown) : null), [ata?.markdown]);

  async function copy() {
    if (!ata?.markdown) return;
    try {
      await navigator.clipboard.writeText(ata.markdown);
      toast("Ata copiada.");
    } catch {
      toast("Não consegui copiar; use o download.", "error");
    }
  }

  function goTo(id: string) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  const header = (
    <div className="ata-head">
      <div>
        <h2>Ata</h2>
        <p className="ata-head-meta">
          <span>
            {!ata?.markdown
              ? "Ainda não gerada"
              : ata.generatedAt
                ? `Análise de ${formatDateTime(ata.generatedAt)} · itens no estado atual`
                : "Ata da versão anterior"}
          </span>
          {provider && (
            <span className={`badge ${isExternal(provider) ? "warn" : ""}`} title="Modelo que gerou a análise">
              {llmLabel(provider)}
            </span>
          )}
        </p>
      </div>
      <div className="ata-actions">
        {doc && (
          <>
            <button type="button" className="small" onClick={() => setResumoOpen(true)}>
              <Send aria-hidden="true" /> Resumo para enviar
            </button>
            <button type="button" className="small" onClick={copy}>
              <Copy aria-hidden="true" /> Copiar
            </button>
            <a className="button small" href={`/api/meetings/${meetingId}/ata.md`} download>
              <Download aria-hidden="true" /> Baixar .md
            </a>
            <button type="button" className="small icon" onClick={load} disabled={loading} aria-label="Atualizar" title="Atualizar">
              <RefreshCw aria-hidden="true" />
            </button>
          </>
        )}
        {generate && (
          <button type="button" className="small primary" onClick={generate.onClick}>
            <Sparkles aria-hidden="true" /> {generate.label}
          </button>
        )}
      </div>
    </div>
  );

  if (error || !ata || !doc) {
    return (
      <>
        {header}
        {error ? <p className="error-text">{error}</p> : <p className="muted">{ata ? waitingText : "Carregando…"}</p>}
      </>
    );
  }

  const facts = new Map(doc.sections.filter((s) => FACTS.includes(s.title)).map((s) => [s.title, s]));
  const content = doc.sections.filter((s) => !FACTS.includes(s.title));
  const filled = content.filter((s) => !s.empty);
  const empty = content.filter((s) => s.empty);
  const people = facts.get("Participantes");
  const names =
    people && !people.empty
      ? people.body.split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean)
      : [];

  return (
    <>
      {header}
      <div className="ata-layout">
        {filled.length > 1 && (
          <nav className="ata-toc" aria-label="Seções da ata">
            <p className="ata-toc-title">Nesta ata</p>
            <ul>
              {filled.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => goTo(s.id)}>
                    <span>{s.title}</span>
                    {s.count > 0 && <span className="ata-toc-count">{s.count}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <article className="ata-doc">
          {doc.notes.map((n, i) => (
            <div key={i} className="ata-note">
              <Markdown source={n} />
            </div>
          ))}

          <dl className="ata-facts">
            {["Data", "Horário", "Duração", "Projeto"].map((title) => (
              <div key={title}>
                <dt>{title}</dt>
                <dd>{factValue(facts.get(title))}</dd>
              </div>
            ))}
            <div className="wide">
              <dt>Participantes</dt>
              <dd>
                {names.length ? (
                  <ul className="ata-people">
                    {names.map((n) => (
                      <li key={n} className="badge">{n}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>

          {filled.map((s) => (
            <section key={s.id} id={s.id} className="ata-section" aria-labelledby={`${s.id}-t`}>
              <h3 id={`${s.id}-t`}>
                {s.title}
                {s.count > 0 && <span className="ata-count">{s.count}</span>}
              </h3>
              <Markdown source={s.body} />
            </section>
          ))}

          {empty.length > 0 && (
            <p className="ata-empty">
              <strong>Sem registro nesta reunião:</strong> {empty.map((s) => s.title).join(", ")}.
            </p>
          )}

          {doc.appendix && (
            <section className="ata-section ata-appendix">
              <Markdown source={doc.appendix} />
            </section>
          )}
        </article>
      </div>
      <ResumoDialog meetingId={meetingId} open={resumoOpen} onClose={() => setResumoOpen(false)} />
    </>
  );
}
