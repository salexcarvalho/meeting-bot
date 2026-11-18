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

describe("participantNames: nomes lidos da chamada (spec 006)", () => {
  it("o mesmo nome da chamada e do convite, com outra caixa ou acento, aparece uma vez", () => {
    const invited = [{ name: "Ana Souza", email: "ana@empresa.com" }];
    expect(participantNames(["ANA SOUZA", "Speaker 2"], invited, null)).toEqual(["ANA SOUZA", "Speaker 2"]);
    expect(participantNames(["Joao Lima"], [{ name: "João Lima", email: "j@e.com" }], null)).toEqual(["Joao Lima"]);
  });
});
