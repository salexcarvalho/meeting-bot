import {
  ITEM_TYPE_LABELS,
  RISK_CATEGORY_LABELS,
  type Adr,
  type Item,
  type ItemType,
  type MeetingSummary,
} from "@meeting-bot/contracts";
import { participantNames, type Self } from "../meetings/participants";

// Ata no template de 19 seções (FR-026), montada do estado atual dos itens (FR-027, R9).

export interface AtaAnalysis {
  objetivo: string;
  resumo_executivo: string;
  assuntos: { titulo: string; resumo: string }[];
  observacoes_arquiteto: string[];
}

export interface AtaInput {
  meeting: MeetingSummary;
  timezone: string;
  items: Item[];
  adrs: Adr[];
  speakers: string[];
  /** dono da reunião, para o convite dele não duplicar o canal do microfone */
  self?: Self | null;
  analysis: AtaAnalysis | null;
  legacyAta: string | null;
}

const PENDING = "_Nada registrado._";
const REQUIREMENT_TYPES: ItemType[] = ["requisito_funcional", "requisito_nao_funcional", "regra_negocio", "restricao", "premissa"];

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function mark(item: Item): string {
  return item.reviewStatus === "proposto" ? " _(proposto)_" : "";
}

function evidenceRef(item: Item): string {
  const first = item.evidence[0];
  return first ? ` [${clock(first.start)}]` : "";
}

function line(item: Item, extra: string[] = []): string {
  const details = extra.filter(Boolean);
  return `- ${oneLine(item.description)}${details.length ? ` (${details.join("; ")})` : ""}${evidenceRef(item)}${mark(item)}`;
}

function section(title: string, lines: string[]): string {
  return `## ${title}\n\n${lines.length ? lines.join("\n") : PENDING}\n`;
}

function formatDate(iso: string, timezone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, ...opts }).format(new Date(iso));
}

export function renderAta(input: AtaInput): string {
  const { meeting: m, timezone, analysis } = input;
  const items = input.items.filter((i) => i.reviewStatus !== "rejeitado");
  const byType = (type: ItemType) => items.filter((i) => i.type === type);

  const start = m.startedAt ?? m.scheduledStart ?? m.createdAt;
  const end = m.endedAt ?? m.scheduledEnd;
  const durationMin = m.startedAt && m.endedAt
    ? Math.round((new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 60_000)
    : null;
  const participants = participantNames(input.speakers, m.attendees, input.self ?? null);

  const pendencias = byType("pendencia");
  const owners = new Map<string, Item[]>();
  for (const p of pendencias) {
    if (!p.owner) continue;
    owners.set(p.owner, [...(owners.get(p.owner) ?? []), p]);
  }
  const openActions = pendencias.filter((p) => p.attributes.status_acao !== "concluida");
  const adrByItem = new Map(input.adrs.map((a) => [a.itemId, a]));
  const adrItems = byType("decisao_arquitetural");

  // Itens desligados e nenhum item gerado: a ata traz só o resumo, sem seções vazias de decisões e riscos.
  const summaryOnly = !m.itemsEnabled && items.length === 0;

  const parts: string[] = [];
  parts.push(`# Ata — ${oneLine(m.title)}\n`);
  if (summaryOnly) {
    parts.push('> Esta reunião não gera itens (decisões, pendências, riscos e ADRs): a ata traz só o resumo. Ligue "Gerar itens" na reunião para incluí-los.\n');
  } else if (!analysis && input.legacyAta) {
    parts.push("> Ata gerada pela versão anterior do sistema; as seções abaixo refletem os itens atuais, se houver.\n");
  } else if (items.some((i) => i.reviewStatus === "proposto")) {
    parts.push("> Itens marcados como _(proposto)_ foram sugeridos pela IA e ainda não foram revisados.\n");
  }

  parts.push(section("Data", [formatDate(start, timezone, { dateStyle: "full" })]));
  parts.push(
    section("Horário", [
      `${formatDate(start, timezone, { timeStyle: "short" })}${end ? ` – ${formatDate(end, timezone, { timeStyle: "short" })}` : ""}`,
    ]),
  );
  parts.push(section("Duração", durationMin !== null ? [`${durationMin} min`] : []));
  parts.push(section("Projeto", m.project ? [`${m.project.name}${m.project.suggested ? " _(sugerido)_" : ""}`] : []));
  parts.push(section("Participantes", participants.map((p) => `- ${p}`)));
  parts.push(section("Objetivo", analysis?.objetivo ? [oneLine(analysis.objetivo)] : []));
  parts.push(section("Resumo executivo", analysis?.resumo_executivo ? [analysis.resumo_executivo.trim()] : []));
  parts.push(
    section(
      "Assuntos discutidos",
      (analysis?.assuntos ?? []).map((a) => `- **${oneLine(a.titulo)}**: ${oneLine(a.resumo)}`),
    ),
  );
  const itemSectionsStart = parts.length;
  parts.push(section("Decisões", byType("decisao").map((i) => line(i, [i.attributes.motivacao ? `motivação: ${i.attributes.motivacao}` : ""]))));
  parts.push(
    section(
      "Decisões arquiteturais",
      adrItems.map((i) =>
        line(i, [
          i.attributes.sistema ? `sistema: ${i.attributes.sistema}` : "",
          i.attributes.impacto ? `impacto: ${i.attributes.impacto}` : "",
        ]),
      ),
    ),
  );
  parts.push(
    section(
      "Requisitos identificados",
      REQUIREMENT_TYPES.flatMap((t) => byType(t).map((i) => line(i, [ITEM_TYPE_LABELS[t]]))),
    ),
  );
  parts.push(
    section(
      "Riscos",
      byType("risco").map((i) =>
        line(i, [
          i.attributes.categoria ? RISK_CATEGORY_LABELS[i.attributes.categoria] : "",
          i.attributes.impacto ? `impacto: ${i.attributes.impacto}` : "",
        ]),
      ),
    ),
  );
  parts.push(section("Débitos técnicos", byType("debito_tecnico").map((i) => line(i))));
  parts.push(
    section(
      "Pendências",
      pendencias.map((i) =>
        line(i, [
          i.owner ? `responsável: ${i.owner}` : "",
          i.due ? `prazo: ${i.due}` : "",
          i.attributes.dependencia ? `depende de: ${i.attributes.dependencia}` : "",
          i.attributes.status_acao === "concluida" ? "concluída" : "",
        ]),
      ),
    ),
  );
  parts.push(
    section(
      "Responsáveis",
      [...owners].map(([owner, list]) => `- **${owner}**: ${list.map((i) => oneLine(i.description)).join("; ")}`),
    ),
  );
  parts.push(
    section(
      "Próximas ações",
      openActions.map((i) => `- [ ] ${oneLine(i.description)}${i.owner ? ` — ${i.owner}` : ""}${i.due ? ` (até ${i.due})` : ""}${mark(i)}`),
    ),
  );
  parts.push(section("Perguntas em aberto", byType("pergunta_aberta").map((i) => line(i))));
  parts.push(
    section(
      "Possíveis ADRs",
      adrItems.map((i) => {
        const adr = adrByItem.get(i.id);
        if (!adr || adr.status === "rejeitado") return `- ${oneLine(i.description)} — ADR não sugerido${mark(i)}`;
        const status = adr.code ? `${adr.code} (${adr.status})` : `sugestão (${adr.status})`;
        const alternatives = adr.alternatives.length
          ? adr.alternatives.map((a) => a.opcao).join(", ")
          : "alternativas não discutidas";
        return `- **${oneLine(adr.title)}** — ${status}; ${alternatives}`;
      }),
    ),
  );
  parts.push(section("Observações do Arquiteto", (analysis?.observacoes_arquiteto ?? []).map((o) => `- ${oneLine(o)}`)));
  if (summaryOnly) parts.splice(itemSectionsStart);

  if (!analysis && input.legacyAta) {
    parts.push(`---\n\n### Ata original\n\n${input.legacyAta.trim()}\n`);
  }
  return parts.join("\n");
}

export interface ResumoOutput {
  text: string;
  /** itens aprovados no resumo */
  approved: number;
  /** itens ainda propostos, que ficaram de fora */
  pending: number;
}

/**
 * Resumo curto para colar no Teams ou no e-mail: objetivo, resumo, decisões, pendências e riscos.
 * Só entram itens aprovados; texto simples (lê bem com ou sem Markdown).
 */
export function renderResumo(input: AtaInput): ResumoOutput {
  const { meeting: m, timezone, analysis } = input;
  const approved = input.items.filter((i) => i.reviewStatus === "aprovado");
  const pending = input.items.filter((i) => i.reviewStatus === "proposto").length;
  const byType = (type: ItemType) => approved.filter((i) => i.type === type);
  const adrByItem = new Map(input.adrs.filter((a) => a.status === "aprovado" && a.code).map((a) => [a.itemId, a.code!]));
  const start = m.startedAt ?? m.scheduledStart ?? m.createdAt;
  const bullet = (text: string, extra: string[] = []) => {
    const details = extra.filter(Boolean);
    return `- ${oneLine(text)}${details.length ? ` (${details.join("; ")})` : ""}`;
  };

  const lines: string[] = [`Resumo da reunião: ${oneLine(m.title)}`];
  const header = [
    formatDate(start, timezone, { dateStyle: "short", timeStyle: "short" }),
    m.project ? `Projeto: ${m.project.name}` : "",
  ].filter(Boolean);
  lines.push(header.join(" · "), "");
  if (analysis?.objetivo) lines.push(`Objetivo: ${oneLine(analysis.objetivo)}`, "");
  if (analysis?.resumo_executivo) lines.push(analysis.resumo_executivo.trim(), "");

  const blocks: [string, string[]][] = [
    ["Decisões", byType("decisao").map((i) => bullet(i.description))],
    ["Decisões arquiteturais", byType("decisao_arquitetural").map((i) => bullet(i.description, [adrByItem.get(i.id) ?? ""]))],
    [
      "Pendências",
      byType("pendencia")
        .filter((i) => i.attributes.status_acao !== "concluida")
        .map((i) => bullet(i.description, [`responsável: ${i.owner ?? "a definir"}`, i.due ? `prazo: ${i.due}` : "sem prazo"])),
    ],
    [
      "Riscos",
      byType("risco").map((i) => bullet(i.description, [i.attributes.categoria ? RISK_CATEGORY_LABELS[i.attributes.categoria] : ""])),
    ],
  ];
  for (const [title, entries] of blocks) {
    if (entries.length) lines.push(title, ...entries, "");
  }
  if (!blocks.some(([, entries]) => entries.length)) lines.push("Nenhum item aprovado ainda.", "");
  return { text: `${lines.join("\n").trim()}\n`, approved: approved.length, pending };
}
