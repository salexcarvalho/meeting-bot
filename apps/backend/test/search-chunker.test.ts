import { describe, expect, it } from "vitest";
import {
  buildAdrChunk,
  buildAnalysisChunks,
  buildItemChunk,
  buildMeetingChunk,
  buildTranscriptChunks,
  CHUNK_MAX_CHARS,
  contentHash,
  embedText,
  splitLong,
  type TranscriptSegmentInput,
} from "../src/search/chunker";

const seg = (id: number, start: number, text: string, speaker: string | null = "Ana", end = start + 10): TranscriptSegmentInput => ({
  id,
  speaker,
  text,
  start,
  end,
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(" ");

describe("trechos da transcrição", () => {
  it("junta segmentos curtos numa janela única e guarda ids, tempos e falantes", () => {
    const chunks = buildTranscriptChunks([seg(1, 0, "Bom dia"), seg(2, 12, "Vamos começar", "Bia")]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: "transcript", seq: 0, firstSegmentId: 1, lastSegmentId: 2, startSeconds: 0, endSeconds: 22 });
    expect(chunks[0].speakers).toEqual(["Ana", "Bia"]);
    expect(chunks[0].content).toBe("Ana: Bom dia\nBia: Vamos começar");
  });

  it("prefixa o falante só quando ele muda", () => {
    const [chunk] = buildTranscriptChunks([seg(1, 0, "um"), seg(2, 11, "dois"), seg(3, 22, "três", "Bia")]);
    expect(chunk.content).toBe("Ana: um\ndois\nBia: três");
  });

  it("fecha a janela perto de 180 palavras e repete o último segmento (sobreposição de 1)", () => {
    const input = [seg(1, 0, words(100)), seg(2, 11, words(100)), seg(3, 22, words(100)), seg(4, 33, words(100))];
    const chunks = buildTranscriptChunks(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].lastSegmentId).toBe(2);
    expect(chunks[1].firstSegmentId).toBe(2);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
  });

  it("quebra a janela em pausa maior que 45 s, sem sobreposição", () => {
    const chunks = buildTranscriptChunks([seg(1, 0, "antes da pausa"), seg(2, 120, "depois da pausa")]);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].firstSegmentId).toBe(2);
    expect(chunks[0].content).not.toContain("depois");
  });

  it("ordena mic e remote pelo início, depois pelo id", () => {
    const chunks = buildTranscriptChunks([seg(5, 30, "terceiro"), seg(2, 10, "segundo", "Bia"), seg(1, 0, "primeiro")]);
    expect(chunks[0].firstSegmentId).toBe(1);
    expect(chunks[0].lastSegmentId).toBe(5);
    expect(chunks[0].content.indexOf("primeiro")).toBeLessThan(chunks[0].content.indexOf("terceiro"));
  });

  it("ignora segmentos vazios e entrada vazia", () => {
    expect(buildTranscriptChunks([])).toEqual([]);
    expect(buildTranscriptChunks([seg(1, 0, "   ")])).toEqual([]);
  });

  it("nenhum trecho passa do limite de caracteres, mesmo com um segmento enorme", () => {
    const chunks = buildTranscriptChunks([seg(1, 0, words(2000), "Ana", 300)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("splitLong corta em fronteira de palavra", () => {
    const parts = splitLong("aaaa bbbb cccc dddd", 9);
    expect(parts).toEqual(["aaaa bbbb", "cccc dddd"]);
  });
});

describe("narrativa, itens, ADR e metadados", () => {
  it("narrativa vira um trecho por seção", () => {
    const chunks = buildAnalysisChunks({
      objetivo: "Alinhar o plano",
      resumo_executivo: "Resumo da reunião",
      assuntos: [{ titulo: "Banco", resumo: "Migração" }],
      observacoes_arquiteto: ["Atenção ao backup"],
    });
    expect(chunks.map((c) => c.sourceId)).toEqual(["objetivo", "resumo_executivo", "assunto:1", "observacao:1"]);
    expect(chunks[2].content).toBe("Banco: Migração");
    expect(buildAnalysisChunks(null)).toEqual([]);
    expect(buildAnalysisChunks({ objetivo: "  " })).toEqual([]);
  });

  it("item rejeitado não gera trecho; os demais levam o campo e os atributos", () => {
    const base = { id: "i1", type: "pendencia", description: "Renovar certificados", owner: "Camila", due: "sexta", attributes: { sistema: "Portal" } };
    expect(buildItemChunk({ ...base, reviewStatus: "rejeitado" })).toBeNull();
    const chunk = buildItemChunk({ ...base, reviewStatus: "proposto" });
    expect(chunk).toMatchObject({ kind: "item", sourceId: "i1", seq: 0 });
    expect(chunk?.content).toContain("Responsável: Camila");
    expect(chunk?.content).toContain("Sistema: Portal");
    // o selo proposto/aprovado não entra no texto: é lido na consulta
    expect(chunk?.content).not.toContain("proposto");
  });

  it("ADR rejeitado não gera trecho", () => {
    const adr = { id: "a1", status: "proposto", title: "Usar SSO", context: "c", problem: "p", decision: "d", consequences: "q" };
    expect(buildAdrChunk({ ...adr, status: "rejeitado" })).toBeNull();
    expect(buildAdrChunk(adr)?.content).toContain("Decisão: d");
  });

  it("metadados trazem título, data, projeto e participantes", () => {
    const chunk = buildMeetingChunk({
      title: "Revisão",
      projectName: "Portal",
      dateLabel: "05/10/2026",
      organizer: "Marina",
      attendees: ["Rafael", "Camila"],
      description: "Pauta\ncompleta",
    });
    expect(chunk.kind).toBe("meeting");
    expect(chunk.content).toContain("Projeto: Portal");
    expect(chunk.content).toContain("Participantes: Rafael, Camila");
    expect(chunk.content).toContain("Pauta completa");
  });
});

describe("hash e texto de embedding", () => {
  it("o hash é estável e muda com o modelo e com o texto", () => {
    const text = embedText("Reunião — 05/10/2026", "conteúdo");
    expect(contentHash(text, "bge-m3")).toBe(contentHash(text, "bge-m3"));
    expect(contentHash(text, "bge-m3")).not.toBe(contentHash(text, "outro"));
    expect(contentHash(text, "bge-m3")).not.toBe(contentHash(`${text}!`, "bge-m3"));
    expect(contentHash(text, "bge-m3")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o contexto da reunião vem antes do trecho", () => {
    expect(embedText("Título — data", "fala")).toBe("Título — data\nfala");
  });
});
