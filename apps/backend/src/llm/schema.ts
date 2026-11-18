import { z } from "zod";

// Limites de tamanho viram repetições enormes na gramática de saída estruturada e deixam a
// geração lenta; a validação completa acontece depois, com zod.
const SIZE_KEYS = ["maxLength", "minLength", "maxItems"];

function strip(node: unknown, drop: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(n, drop));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (!drop.has(k)) out[k] = strip(v, drop);
    }
    return out;
  }
  return node;
}

/** JSON Schema do zod para o LLM. `limits` mantém os tamanhos máximos (só onde o modelo os respeita). */
export function toJsonSchema(schema: z.ZodType, opts: { limits?: boolean } = {}): unknown {
  const drop = new Set(opts.limits ? ["$schema"] : ["$schema", ...SIZE_KEYS]);
  return strip(z.toJSONSchema(schema, { target: "draft-07" }), drop);
}
