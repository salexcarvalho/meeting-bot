import type { Attendee } from "@meeting-bot/contracts";
import { foldName } from "../bot/speakers/names";

export interface Self {
  name: string;
  email: string | null;
}

/** Quem participou: falantes + convidados. O convite com o e-mail do dono vira o nome dele, sem duplicar com o canal do microfone. */
export function participantNames(speakers: string[], attendees: Attendee[], self: Self | null): string[] {
  const mine = self?.email?.toLowerCase() ?? null;
  const invited = attendees
    .map((a) => (mine && self && a.email?.toLowerCase() === mine ? self.name : a.name || a.email || ""))
    .filter(Boolean);
  // Um nome lido na chamada e o mesmo nome no convite (outra caixa ou acentuação) são a mesma pessoa.
  const seen = new Set<string>();
  return [...speakers, ...invited].filter((name) => {
    const key = foldName(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
