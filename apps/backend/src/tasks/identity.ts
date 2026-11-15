// "O responsável sou eu?" (research R5). Regra conservadora: o falso negativo custa um clique (Virar tarefa);
// o falso positivo colocaria a tarefa de outra pessoa na lista de quem aprovou.

export interface SelfIdentity {
  username: string;
  displayName?: string | null;
  realName?: string | null;
  email?: string | null;
}

const FIRST_NAME_MIN = 3;
const SELF_WORDS = new Set(["eu", "eu mesmo", "eu mesma"]);

export function normalizeName(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");
}

function identityNames(user: SelfIdentity): { full: Set<string>; first: Set<string> } {
  const full = new Set<string>();
  const first = new Set<string>();
  const email = (user.email ?? "").trim().toLowerCase();
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : "";
  for (const text of [user.username, user.displayName, user.realName, email, local]) {
    const name = normalizeName(text);
    if (name) full.add(name);
  }
  for (const text of [user.displayName, user.realName]) {
    const token = normalizeName(text).split(" ")[0];
    if (token && token.length >= FIRST_NAME_MIN) first.add(token);
  }
  return { full, first };
}

export function isSelfOwner(ownerText: string | null | undefined, user: SelfIdentity): boolean {
  const owner = normalizeName(ownerText);
  if (!owner) return false;
  if (SELF_WORDS.has(owner)) return true;
  const names = identityNames(user);
  if (names.full.has(owner)) return true;
  return !owner.includes(" ") && owner.length >= FIRST_NAME_MIN && names.first.has(owner);
}
