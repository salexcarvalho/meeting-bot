import { describe, expect, it } from "vitest";
import { isSelfOwner } from "../src/tasks/identity";

const USER = { username: "sergio", displayName: "Sérgio", realName: "Sérgio Alexandre", email: "sergio.alexandre@example.org" };

describe("isSelfOwner", () => {
  it.each(["eu", "Eu mesmo", "eu mesma", "sergio", "Sérgio", "SÉRGIO ALEXANDRE", "sergio.alexandre@example.org", "sergio alexandre"])(
    "reconhece %s como o próprio usuário",
    (text) => {
      expect(isSelfOwner(text, USER)).toBe(true);
    },
  );

  it("reconhece o primeiro nome do nome real", () => {
    expect(isSelfOwner("Sérgio", { username: "sa", realName: "Sérgio Alexandre" })).toBe(true);
  });

  it.each(["João", "Sérgio Lima", "Maria Souza", "Se", "", "   ", "equipe"])("rejeita %j", (text) => {
    expect(isSelfOwner(text, USER)).toBe(false);
  });

  it("rejeita nome de duas letras mesmo igual ao primeiro nome", () => {
    expect(isSelfOwner("Jo", { username: "x1", realName: "Jo Silva" })).toBe(false);
  });

  it("texto nulo não é o usuário", () => {
    expect(isSelfOwner(null, USER)).toBe(false);
    expect(isSelfOwner(undefined, USER)).toBe(false);
  });
});
