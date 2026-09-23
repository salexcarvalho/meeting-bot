import { describe, expect, it } from "vitest";
import { participantNames } from "../src/meetings/participants";

const attendees = [
  { name: "Sérgio Alex Carvalho", email: "Sergio@Empresa.com" },
  { name: "Ana Souza", email: "ana@empresa.com" },
  { name: "", email: "bia@empresa.com" },
];

describe("participantNames", () => {
  it("o convite com o e-mail do dono vira o nome dele e não duplica o microfone", () => {
    const names = participantNames(["Sérgio", "Speaker 1"], attendees, { name: "Sérgio", email: "sergio@empresa.com" });
    expect(names).toEqual(["Sérgio", "Speaker 1", "Ana Souza", "bia@empresa.com"]);
  });

  it("dono que não falou continua na lista, com o nome dele", () => {
    const names = participantNames(["Speaker 1"], attendees, { name: "Sérgio", email: "sergio@empresa.com" });
    expect(names).toContain("Sérgio");
    expect(names).not.toContain("Sérgio Alex Carvalho");
  });

  it("sem e-mail cadastrado, mantém os nomes do convite", () => {
    expect(participantNames([], attendees, { name: "Sérgio", email: null })).toEqual([
      "Sérgio Alex Carvalho",
      "Ana Souza",
      "bia@empresa.com",
    ]);
    expect(participantNames([], attendees, null)).toHaveLength(3);
  });
});
