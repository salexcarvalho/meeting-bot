// Nome de quem fala lido na tela da chamada: normalização, chave do participante e desambiguação.
// Funções puras (sem DOM e sem banco); o que a tela mostra de verdade fica em teams.ts e meet.ts.

export const MAX_NAME_LENGTH = 120;
// Entrada da tela é limitada antes de qualquer expressão regular (nada de backtracking em texto longo).
const MAX_RAW_LENGTH = 400;

// Marcadores entre parênteses que a tela acrescenta ao nome e que não fazem parte dele.
const MARKERS = new Set([
  "you", "você", "voce", "eu", "me", "yo", "tú",
  "guest", "convidado", "invitado", "external", "externo", "unverified", "não verificado",
  "organizer", "organizador", "presenter", "apresentador", "host", "anfitrião",
  "he/him", "she/her", "they/them", "ele/dele", "ela/dela",
]);
const SELF_MARKERS = new Set(["you", "você", "voce", "eu", "me", "yo", "tú"]);

// Estado do microfone/câmera/fala que o rótulo acessível do tile acrescenta depois de uma vírgula.
const STATE_WORDS = [
  "microphone", "mic", "microfone", "micrófono", "camera", "câmera", "cámara", "video", "vídeo",
  "muted", "unmuted", "mudo", "sem som", "silenciado", "speaking", "falando", "hablando",
  "raised hand", "mão levantada", "pinned", "fixado", "spotlighted", "em destaque", "presenting", "apresentando",
];

const PAREN_GROUP = /\(([^()]{1,30})\)/g;

function isInvisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    code === 0x2060 ||
    code === 0xfeff
  );
}

/** Troca por espaço os caracteres de controle e os invisíveis (direção de texto, largura zero). */
function stripInvisible(text: string): string {
  let out = "";
  for (const char of text) out += isInvisible(char.codePointAt(0) ?? 0) ? " " : char;
  return out;
}

const lower = (text: string) => text.trim().toLocaleLowerCase("pt-BR");

/** Sem acento e sem caixa: compara nomes de pessoas escritos de formas diferentes. */
export function foldName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function stripStateSuffix(text: string): string {
  const parts = text.split(",");
  while (parts.length > 1) {
    const last = lower(parts[parts.length - 1]);
    if (!STATE_WORDS.some((word) => last.startsWith(word))) break;
    parts.pop();
  }
  return parts.join(",");
}

/** Marcadores entre parênteses presentes no rótulo cru (em minúsculas). */
function markersOf(raw: string): string[] {
  return [...raw.slice(0, MAX_RAW_LENGTH).matchAll(PAREN_GROUP)].map((m) => lower(m[1]));
}

/** O rótulo marca a própria pessoa do assistente ("Nome (You)")? */
export function isSelfMarked(raw: string): boolean {
  return markersOf(raw).some((marker) => SELF_MARKERS.has(marker));
}

/** O tile é de compartilhamento de tela ("Maria está apresentando"), não de uma pessoa falando? */
export function isPresentationTile(raw: string): boolean {
  return /\b(is presenting|presenting|apresentando|presentando)\b/i.test(raw.slice(0, MAX_RAW_LENGTH));
}

/** Nome limpo: sem marcadores, sem estado do microfone, sem controle, sem espaço extra, até 120 caracteres. */
export function normalizeDisplayName(raw: string): string {
  const bounded = stripInvisible(raw.slice(0, MAX_RAW_LENGTH));
  const withoutState = stripStateSuffix(bounded);
  const withoutMarkers = withoutState.replace(PAREN_GROUP, (group, inner: string) =>
    MARKERS.has(lower(inner)) ? " " : group,
  );
  return withoutMarkers.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim();
}

export interface TileIdentity {
  /** nome limpo, ou null quando o tile não vale como falante */
  name: string | null;
  /** motivo de ter sido ignorado (só para contadores) */
  ignored?: "empty" | "self" | "assistant" | "presentation";
}

/** Decide se o rótulo cru de um tile é uma pessoa falante: ignora o assistente, "(Você)", apresentação e vazio. */
export function identifyTile(raw: string, assistantName: string): TileIdentity {
  if (isSelfMarked(raw)) return { name: null, ignored: "self" };
  if (isPresentationTile(raw)) return { name: null, ignored: "presentation" };
  const name = normalizeDisplayName(raw);
  if (!name) return { name: null, ignored: "empty" };
  if (foldName(name) === foldName(assistantName)) return { name: null, ignored: "assistant" };
  return { name };
}

/** Chave estável do participante: o identificador da plataforma quando existe, senão o nome sem acento nem caixa. */
export function participantKey(platformId: string | null | undefined, name: string): string {
  const id = platformId?.trim();
  return id ? `id:${id.slice(0, 120)}` : `name:${foldName(name)}`;
}

export interface NamedPerson {
  key: string;
  name: string;
  /** quando falou pela primeira vez (segundos): define a ordem do "(2)" */
  firstAt: number;
}

/** Duas pessoas (chaves diferentes) com o mesmo nome viram "Nome" e "Nome (2)", na ordem da primeira fala. */
export function disambiguateNames(people: NamedPerson[]): Map<string, string> {
  const ordered = [...people].sort((a, b) => a.firstAt - b.firstAt || a.key.localeCompare(b.key));
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  for (const person of ordered) {
    const base = foldName(person.name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    result.set(person.key, count === 1 ? person.name : `${person.name} (${count})`);
  }
  return result;
}
