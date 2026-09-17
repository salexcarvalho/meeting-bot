import { describe, expect, it } from "vitest";
import type { ExtractedItem, Extracao } from "@meeting-bot/contracts";
import { quoteMatches, validateExtraction } from "../src/agent/evidence";
import { formatWindow, type WindowSegment } from "../src/agent/prompts";

const seg = (id: number, text: string, start = id * 10): WindowSegment => ({
  id,
  channel: id % 2 ? "remote" : "mic",
  start,
  end: start + 8,
  speakerName: id % 2 ? "Remoto" : "Sérgio",
  text,
});

const { text: windowText, map } = formatWindow(
  [
    seg(101, "Então fica decidido: vamos usar PostgreSQL como banco principal do portal."),
    seg(102, "O João vai revisar a política de backup até sexta-feira."),
    seg(103, "Existe risco de a integração com o SUS atrasar por causa do certificado."),
  ],
  [seg(99, "Na reunião passada falamos de MongoDB para o portal.")],
);

function item(over: Partial<ExtractedItem>): ExtractedItem {
  return {
    tipo: "decisao",
    descricao: "Usar PostgreSQL como banco principal do portal",
    segmentos: ["S2"],
    citacao: "vamos usar PostgreSQL como banco principal",
    responsavel: null,
    prazo: null,
    dependencia: null,
    motivacao: null,
    impacto: null,
    sistema: null,
    categoria: null,
    ...over,
  };
}

const run = (...itens: ExtractedItem[]) => validateExtraction({ resumo_trecho: "", itens } satisfies Extracao, map);

describe("formatWindow", () => {
  it("numera contexto primeiro e marca como não citável", () => {
    expect(windowText).toContain("[S1 16:30 contexto]");
    expect(windowText).toContain("[S2 16:50] Remoto: Então fica decidido");
    expect(map.context.has("S1")).toBe(true);
    expect(map.cite.get("S3")?.id).toBe(102);
  });
});

describe("validateExtraction", () => {
  it("aceita item com id e citação válidos e mapeia a evidência", () => {
    const [valid] = run(item({}));
    expect(valid.type).toBe("decisao");
    expect(valid.evidence).toEqual([
      { segmentId: 101, start: 1010, end: 1018, channel: "remote", quote: "vamos usar PostgreSQL como banco principal" },
    ]);
  });

  it("remove ids inexistentes e de contexto, mantendo os válidos", () => {
    const [valid] = run(item({ segmentos: ["S1", "S9", "S2", "s2"] }));
    expect(valid.evidence.map((e) => e.segmentId)).toEqual([101]);
  });

  it("descarta item sem nenhum id válido", () => {
    expect(run(item({ segmentos: ["S1"], citacao: "falamos de MongoDB para o portal" }))).toEqual([]);
    expect(run(item({ segmentos: ["S7"] }))).toEqual([]);
  });

  it("descarta citação com menos de 60% dos tokens no texto citado", () => {
    expect(run(item({ citacao: "vamos migrar tudo para Oracle na nuvem" }))).toEqual([]);
  });

  it("ignora acentos, maiúsculas e pontuação na citação", () => {
    const valid = run(
      item({
        tipo: "pendencia",
        descricao: "João revisar a política de backup",
        segmentos: ["S3"],
        citacao: "joao VAI revisar a politica de backup, ate sexta",
        responsavel: "João",
        prazo: "sexta-feira",
      }),
    );
    expect(valid).toHaveLength(1);
    expect(valid[0].owner).toBe("João");
    expect(valid[0].attributes.status_acao).toBe("aberta");
  });

  it("categoria só vale para risco", () => {
    const [decisao] = run(item({ categoria: "dados" }));
    expect(decisao.attributes.categoria).toBeNull();
    const [risco] = run(
      item({
        tipo: "risco",
        descricao: "Integração com o SUS pode atrasar pelo certificado",
        segmentos: ["S4"],
        citacao: "risco de a integração com o SUS atrasar",
        categoria: "integracao",
      }),
    );
    expect(risco.attributes.categoria).toBe("integracao");
  });

  it("descarta descrição curta demais e normaliza campos vazios", () => {
    expect(run(item({ descricao: "  banco " }))).toEqual([]);
    const [valid] = run(item({ responsavel: "  ", prazo: "" }));
    expect(valid.owner).toBeNull();
    expect(valid.due).toBeNull();
  });

  it("citação sem palavras verificáveis é descartada", () => {
    expect(quoteMatches("é o", "é o que é")).toBe(false);
  });
});
