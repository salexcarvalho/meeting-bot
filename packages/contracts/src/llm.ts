import { z } from "zod";
import { ITEM_TYPES, RISK_CATEGORIES } from "./domain";

// Saídas estruturadas do LLM local (contracts/llm-schemas.md).
// Convertidas com z.toJSONSchema() para o campo `format` do Ollama.

const nullableText = (max: number) => z.string().max(max).nullable();

export const ExtractedItem = z.object({
  tipo: z.enum(ITEM_TYPES),
  descricao: z.string().min(1).max(1000),
  segmentos: z.array(z.string().max(12)).min(1).max(12),
  citacao: z.string().max(400),
  responsavel: nullableText(120),
  prazo: nullableText(120),
  dependencia: nullableText(300),
  motivacao: nullableText(500),
  impacto: nullableText(500),
  sistema: nullableText(200),
  categoria: z.enum(RISK_CATEGORIES).nullable(),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const Extracao = z.object({
  resumo_trecho: z.string().max(600),
  itens: z.array(ExtractedItem).max(40),
});
export type Extracao = z.infer<typeof Extracao>;

export const Consolidacao = z.object({
  resumo: z.string().max(1500),
  duplicados: z
    .array(
      z.object({
        manter: z.string().max(12),
        remover: z.array(z.string().max(12)).min(1).max(20),
      }),
    )
    .max(40),
});
export type Consolidacao = z.infer<typeof Consolidacao>;

export const Narrativa = z.object({
  objetivo: z.string().max(600),
  resumo_executivo: z.string().max(1200),
  assuntos: z
    .array(z.object({ titulo: z.string().max(200), resumo: z.string().max(800) }))
    .min(1)
    .max(10),
  observacoes_arquiteto: z.array(z.string().max(600)).max(8),
});
export type Narrativa = z.infer<typeof Narrativa>;

export const AdrSugerido = z.object({
  titulo: z.string().max(300),
  contexto: z.string().max(3000),
  problema: z.string().max(3000),
  alternativas: z
    .array(z.object({ opcao: z.string().max(300), pros: z.string().max(1000), contras: z.string().max(1000) }))
    .max(5),
  decisao: z.string().max(3000),
  consequencias: z.string().max(3000),
  riscos: z.array(z.string().max(600)).max(10),
});
export type AdrSugerido = z.infer<typeof AdrSugerido>;

export const LLM_SCHEMAS = { Extracao, Consolidacao, Narrativa, AdrSugerido } as const;
