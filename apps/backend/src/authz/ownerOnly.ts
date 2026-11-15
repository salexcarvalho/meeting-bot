import type { Permission } from "@meeting-bot/contracts";

// Padrões de rota (req.route.path) que só o dono da reunião pode chamar. O guard decide por estes padrões,
// nunca pela URL digitada (maiúsculas, barras duplas e codificação não mudam o padrão que casou).

// Compartilhamento "edit" mexe no conteúdo (itens, falantes); agenda, gravação, link e envio de áudio são do dono.
// Vale para tudo menos GET (HEAD inclusive, como antes).
export const OWNER_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "/meetings/:id",
  "/meetings/:id/record",
  "/meetings/:id/end",
  "/meetings/:id/assistant",
  "/meetings/:id/reprocess",
  "/meetings/:id/skip",
  "/meetings/:id/auto-off-day",
  "/meetings/:id/cancel",
  "/meetings/:id/extract-items",
  "/meetings/:id/adrs/generate",
]);

// Gestão de compartilhamento: dono em qualquer método, inclusive GET (a lista de acessos não vaza a quem só lê).
export const OWNER_ONLY_ANY_METHOD: ReadonlySet<string> = new Set([
  "/meetings/:id/shares",
  "/meetings/:id/shares/:userId",
]);

export function isOwnerOnlyRoute(method: string, pattern: string): boolean {
  if (OWNER_ONLY_ANY_METHOD.has(pattern)) return true;
  return method !== "GET" && OWNER_ONLY_ROUTES.has(pattern);
}

/**
 * Permissões extras por rota. Todo DELETE exige `transcripts.delete`, menos a gestão de compartilhamento
 * (revogar acesso não apaga conteúdo e é só do dono). Falha fechada: uma rota filha com DELETE criada depois
 * continua exigindo a permissão até ser listada de propósito.
 */
export function extraPermissionsFor(method: string, pattern: string, transcriptRoutes: ReadonlySet<string>): Permission[] {
  if (method === "DELETE" && !OWNER_ONLY_ANY_METHOD.has(pattern)) return ["transcripts.delete"];
  if (method === "GET" && transcriptRoutes.has(pattern)) return ["transcripts.read"];
  return [];
}
