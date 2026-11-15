// Cursor opaco de paginação por (instante, id). O instante vai como texto do próprio Postgres
// (microssegundos preservados) e é revalidado na volta: cursor adulterado vira 400, nunca SQL.

const AT_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const ID_TEXT = /^\d{1,18}$/;

export interface Cursor {
  at: string;
  id: string;
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string): Cursor | null {
  if (value.length > 200) return null;
  const text = Buffer.from(value, "base64url").toString("utf8");
  const at = text.slice(0, text.lastIndexOf("|"));
  const id = text.slice(text.lastIndexOf("|") + 1);
  return AT_TEXT.test(at) && ID_TEXT.test(id) ? { at, id } : null;
}
