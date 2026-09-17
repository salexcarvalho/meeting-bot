import { describe, expect, it } from "vitest";
import type { Adr, Item, MeetingSummary } from "@meeting-bot/contracts";
import { renderAta, type AtaAnalysis } from "../src/ata/render";

const SECTIONS = [
  "Data", "Horário", "Duração", "Projeto", "Participantes", "Objetivo", "Resumo executivo",
  "Assuntos discutidos", "Decisões", "Decisões arquiteturais", "Requisitos identificados", "Riscos",
  "Débitos técnicos", "Pendências", "Responsáveis", "Próximas ações", "Perguntas em aberto",
  "Possíveis ADRs", "Observações do Arquiteto",
];

const meeting: MeetingSummary = {
  id: "m1",
  title: "Portal SES - Arquitetura",
  platform: "teams",
  url: null,
  status: "done",
  statusLabel: "Concluída",
  source: "ics",
  scheduledStart: "2026-09-16T13:00:00Z",
  scheduledEnd: "2026-09-16T14:00:00Z",
  startedAt: "2026-09-16T13:02:00Z",
  endedAt: "2026-09-16T13:47:00Z",
  project: { id: "p", name: "Portal SES", suggested: false },
  skipRecording: false,
  organizer: null,
  attendees: [{ name: "Ana Souza", email: "ana@example.com" }],
  errorMessage: null,
  botActive: false,
  botProgress: null,
  botDisplayName: null,
  createdBy: null,
  createdAt: "2026-09-15T10:00:00Z",
};

let seq = 0;
function item(over: Partial<Item>): Item {
  seq++;
  return {
    id: `i${seq}`,
    meetingId: "m1",
    type: "decisao",
    description: `Item ${seq}`,
    owner: null,
    due: null,
    attributes: {},
    reviewStatus: "aprovado",
    origin: "final",
    evidence: [{ segmentId: seq, start: 65, end: 70, channel: "remote", quote: null }],
    createdAt: "",
    updatedAt: "",
    reviewedBy: null,
    reviewedAt: null,
    generatedBy: null,
    ...over,
  };
}

const analysis: AtaAnalysis = {
  objetivo: "Definir o banco do portal.",
  resumo_executivo: "A equipe escolheu PostgreSQL.",
  assuntos: [{ titulo: "Banco de dados", resumo: "Comparação entre opções." }],
  observacoes_arquiteto: ["Planejar a migração dos dados legados."],
};

const items = [
  item({ type: "decisao", description: "Usar PostgreSQL", reviewStatus: "proposto" }),
  item({ type: "decisao", description: "Usar Oracle", reviewStatus: "rejeitado" }),
  item({ id: "arq", type: "decisao_arquitetural", description: "Adotar filas para integração" }),
  item({ id: "arq2", type: "decisao_arquitetural", description: "Separar leitura e escrita" }),
  item({ type: "risco", description: "Certificado do SUS pode atrasar", attributes: { categoria: "integracao" } }),
  item({ type: "pendencia", description: "Revisar backup", owner: "João", due: "sexta" }),
  item({ type: "pendencia", description: "Enviar estimativa", owner: "João" }),
  item({ type: "pendencia", description: "Criar repositório", owner: "Ana", attributes: { status_acao: "concluida" } }),
  item({ type: "requisito_nao_funcional", description: "Responder em até 2 s" }),
];

const adrs: Adr[] = [
  {
    id: "a1", itemId: "arq", meetingId: "m1", number: 7, code: "ADR-007", title: "Filas na integração",
    context: "", problem: "", alternatives: [{ opcao: "REST síncrono", pros: "", contras: "" }], decision: "",
    consequences: "", risks: [], status: "aprovado", approvedAt: "2026-09-16T15:00:00Z", generatedBy: null,
  },
  {
    id: "a2", itemId: "arq2", meetingId: "m1", number: null, code: null, title: "CQRS no portal",
    context: "", problem: "", alternatives: [], decision: "", consequences: "", risks: [], status: "proposto", approvedAt: null, generatedBy: null,
  },
];

const md = renderAta({
  meeting,
  timezone: "America/Sao_Paulo",
  items,
  adrs,
  speakers: ["Sérgio", "Carlos"],
  analysis,
  legacyAta: null,
});

const sectionBody = (title: string) => {
  const start = md.indexOf(`## ${title}\n`);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next < 0 ? undefined : next);
};

describe("renderAta", () => {
  it("tem as 19 seções na ordem do template", () => {
    const found = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(found).toEqual(SECTIONS);
  });

  it("preenche cabeçalho com data, horário local e duração", () => {
    expect(sectionBody("Horário")).toContain("10:02 – 10:47");
    expect(sectionBody("Duração")).toContain("45 min");
    expect(sectionBody("Data")).toContain("16 de setembro de 2026");
  });

  it("marca seções vazias como Nada registrado", () => {
    expect(sectionBody("Débitos técnicos")).toContain("_Nada registrado._");
    expect(sectionBody("Perguntas em aberto")).toContain("_Nada registrado._");
  });

  it("omite rejeitados e marca propostos", () => {
    expect(md).not.toContain("Oracle");
    expect(sectionBody("Decisões")).toContain("Usar PostgreSQL [01:05] _(proposto)_");
  });

  it("usa nomes de falantes e participantes do convite", () => {
    const body = sectionBody("Participantes");
    expect(body).toContain("- Sérgio");
    expect(body).toContain("- Carlos");
    expect(body).toContain("- Ana Souza");
  });

  it("mostra código de ADR só quando aprovado", () => {
    const body = sectionBody("Possíveis ADRs");
    expect(body).toContain("**Filas na integração** — ADR-007 (aprovado); REST síncrono");
    expect(body).toContain("**CQRS no portal** — sugestão (proposto); alternativas não discutidas");
  });

  it("agrupa responsáveis e lista só pendências abertas em próximas ações", () => {
    expect(sectionBody("Responsáveis")).toContain("- **João**: Revisar backup; Enviar estimativa");
    const next = sectionBody("Próximas ações");
    expect(next).toContain("- [ ] Revisar backup — João (até sexta)");
    expect(next).not.toContain("Criar repositório");
  });

  it("inclui categoria do risco, requisitos e narrativa", () => {
    expect(sectionBody("Riscos")).toContain("(Integração)");
    expect(sectionBody("Requisitos identificados")).toContain("Responder em até 2 s (Requisito não funcional)");
    expect(sectionBody("Observações do Arquiteto")).toContain("Planejar a migração");
  });

  it("ata antiga aparece como anexo quando não há análise nova", () => {
    const legacy = renderAta({ meeting, timezone: "America/Sao_Paulo", items: [], adrs: [], speakers: [], analysis: null, legacyAta: "## Resumo\nantigo" });
    expect(legacy).toContain("versão anterior");
    expect(legacy).toContain("### Ata original");
    expect(legacy).toContain("antigo");
  });
});
