import type { Attendee } from "@meeting-bot/contracts";

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
  return [...new Set([...speakers, ...invited])];
}
