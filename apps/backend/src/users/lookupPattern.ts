// Partes puras da busca de usuário (sem banco nem Express), para teste unitário.

export const LOOKUP_MIN_CHARS = 3;
export const LOOKUP_MAX_CHARS = 64;
export const LOOKUP_MAX_RESULTS = 8;
export const LOOKUP_LIMIT_PER_MINUTE = 30;

export const FROM_ACCENTS = "áàâãäåéèêëíìîïóòôõöúùûüçñ";
export const TO_ACCENTS = "aaaaaaeeeeiiiiooooouuuucn";

/** Minúsculas e sem acento: o mesmo tratamento é aplicado no SQL com `translate`. */
export function foldText(text: string): string {
  return text.toLowerCase().replaceAll(/./gu, (ch) => {
    const at = FROM_ACCENTS.indexOf(ch);
    return at < 0 ? ch : TO_ACCENTS[at];
  });
}

/** `%`, `_` e `\` viram literais num LIKE com `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replaceAll(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Padrão LIKE de prefixo a partir do texto digitado; null se curto ou longo demais. */
export function lookupPattern(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim();
  if (q.length < LOOKUP_MIN_CHARS || q.length > LOOKUP_MAX_CHARS) return null;
  return `${escapeLike(foldText(q))}%`;
}
