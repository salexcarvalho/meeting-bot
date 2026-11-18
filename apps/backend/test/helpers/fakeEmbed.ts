import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { normalizeText } from "../../src/agent/text";
import type { EmbedHealth, EmbedResult, Embedder } from "../../src/search/embedder";
import { vectorLiteral } from "../../src/search/embedder";

// Embedder determinístico para os testes: nenhum Ollama, nenhuma rede. Cada palavra (radical de 5
// letras, com um pequeno dicionário de sinônimos) vira um ou dois eixos do vetor; textos com as
// mesmas ideias ficam próximos pelo cosseno.

export const FAKE_DIM = 1024;
export const FAKE_MODEL = "bge-m3";

const CONCEPTS: Record<string, string> = {
  login: "autenticacao",
  autenticacao: "autenticacao",
  senha: "autenticacao",
  entram: "autenticacao",
  entrar: "autenticacao",
  identidade: "autenticacao",
  provedor: "autenticacao",
  backup: "copia",
  copias: "copia",
  copia: "copia",
  seguranca: "copia",
  armazenamento: "copia",
  externo: "copia",
  testes: "teste",
  teste: "teste",
  verificacao: "teste",
  automatica: "teste",
  automaticos: "teste",
  paralelo: "teste",
  fornecedor: "preco",
  vende: "preco",
  vendem: "preco",
  preco: "preco",
  negociacao: "preco",
  contrato: "preco",
  desconto: "preco",
  contingencia: "emergencia",
  cair: "emergencia",
  fora: "emergencia",
  emergencia: "emergencia",
};

function stem(word: string): string {
  return CONCEPTS[word] ?? word.slice(0, 5);
}

function axes(token: string): number[] {
  const digest = createHash("sha1").update(token).digest();
  return [digest.readUInt16BE(0) % FAKE_DIM, digest.readUInt16BE(2) % FAKE_DIM];
}

export function fakeVector(text: string, dim = FAKE_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const word of normalizeText(text).split(" ").filter((w) => w.length > 2)) {
    for (const axis of axes(stem(word))) vector[axis % dim] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
}

export class FakeEmbedder implements Embedder {
  model = FAKE_MODEL;
  readonly dim = FAKE_DIM;
  documentCalls: string[][] = [];
  queryCalls: string[] = [];
  /** saúde (`health`): falso = Ollama fora; o worker nem tenta embedar */
  available = true;
  /** a chamada de documentos falha mesmo com a saúde verdadeira (erro no meio do trabalho) */
  failAlways = false;
  private failAt: number | null = null;
  private calls = 0;

  /** a N-ésima chamada de documentos a partir de agora (1 = a próxima) falha uma vez; null cancela */
  set failOnCall(n: number | null) {
    this.failAt = n === null ? null : this.calls + n;
  }

  resetCounters(): void {
    this.documentCalls = [];
    this.queryCalls = [];
    this.calls = 0;
    this.failAt = null;
  }

  get embeddedTexts(): number {
    return this.documentCalls.reduce((n, batch) => n + batch.length, 0);
  }

  async embedDocuments(texts: string[]): Promise<EmbedResult> {
    this.calls++;
    if (this.failAlways || !this.available || this.failAt === this.calls) {
      if (this.failAt === this.calls) this.failAt = null;
      throw new Error("Ollama indisponível (fake)");
    }
    this.documentCalls.push(texts);
    return { vectors: texts.map((t) => fakeVector(t)), inputTokens: texts.length * 10, computeMs: 5 };
  }

  async embedQuery(text: string): Promise<EmbedResult> {
    if (!this.available) throw new Error("Ollama indisponível (fake)");
    this.queryCalls.push(text);
    return { vectors: [fakeVector(text)], inputTokens: 8, computeMs: 2 };
  }

  async health(): Promise<EmbedHealth> {
    return this.available ? { available: true, reason: null } : { available: false, reason: "ollama_indisponivel" };
  }
}

export interface SeedChunk {
  kind?: string;
  sourceId?: string;
  seq?: number;
  content: string;
  start?: number | null;
  end?: number | null;
  firstSegmentId?: number | null;
  speakers?: string[];
  /** sem vetor (a fase de vetores ainda não rodou) */
  noVector?: boolean;
  hashSuffix?: string;
}

/** Semeia `search_chunks` direto, com vetores sintéticos (a fase de texto não entra aqui). */
export async function seedChunks(pool: Pool, meetingId: string, chunks: SeedChunk[]): Promise<number[]> {
  const ids: number[] = [];
  for (const [index, c] of chunks.entries()) {
    const vector = c.noVector ? null : vectorLiteral(fakeVector(c.content));
    const { rows } = await pool.query(
      `INSERT INTO search_chunks (meeting_id, kind, source_id, seq, content, start_seconds, end_seconds, first_segment_id,
                                  speakers, content_hash, embedding, embed_model, embedded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12, CASE WHEN $11::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [
        meetingId,
        c.kind ?? "transcript",
        c.sourceId ?? "",
        c.seq ?? index,
        c.content,
        c.start ?? null,
        c.end ?? null,
        c.firstSegmentId ?? null,
        c.speakers ?? [],
        `seed-${index}-${c.hashSuffix ?? ""}`,
        vector,
        vector ? FAKE_MODEL : null,
      ],
    );
    ids.push(Number(rows[0].id));
  }
  return ids;
}
