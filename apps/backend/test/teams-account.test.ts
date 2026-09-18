import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { parseSession, seal, TeamsAccountError, unseal, validateAccountName } from "../src/users/teamsAccount";

const SECRET = "a".repeat(40);
const cookie = (domain: string) => ({ name: "ESTSAUTHPERSISTENT", value: "x", domain, path: "/" });
const file = (state: unknown) => Buffer.from(JSON.stringify(state));

describe("sessão cifrada", () => {
  it("abre com a mesma chave e não deixa o conteúdo à vista", () => {
    const plain = Buffer.from('{"cookies":[{"value":"segredo-da-sessao"}]}');
    const sealed = seal(plain, SECRET);
    expect(sealed.includes(Buffer.from("segredo-da-sessao"))).toBe(false);
    expect(unseal(sealed, SECRET).equals(plain)).toBe(true);
  });

  it("cada cifragem usa um IV novo", () => {
    const plain = randomBytes(64);
    expect(seal(plain, SECRET).equals(seal(plain, SECRET))).toBe(false);
  });

  it("recusa chave trocada, conteúdo alterado e blob truncado", () => {
    const sealed = seal(Buffer.from("dados"), SECRET);
    expect(() => unseal(sealed, "b".repeat(40))).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    expect(() => unseal(tampered, SECRET)).toThrow();
    expect(() => unseal(sealed.subarray(0, 10), SECRET)).toThrow();
  });
});

describe("parseSession", () => {
  it("aceita sessão com cookie da Microsoft e mantém só cookies e origins", () => {
    const state = parseSession(
      file({ cookies: [cookie(".login.microsoftonline.com"), cookie("outro.site")], origins: [{ origin: "https://teams.microsoft.com", localStorage: [] }], extra: 1 }),
    );
    expect(Object.keys(state).sort()).toEqual(["cookies", "origins"]);
    expect(state.cookies).toHaveLength(2);
    expect(state.origins).toHaveLength(1);
  });

  it("recusa o que não é sessão da Microsoft", () => {
    expect(() => parseSession(Buffer.from("isso não é json"))).toThrow(TeamsAccountError);
    expect(() => parseSession(file({ foo: 1 }))).toThrow(/não parece uma sessão/);
    expect(() => parseSession(file({ cookies: [cookie("exemplo.com")] }))).toThrow(/login da Microsoft/);
    expect(() => parseSession(file({ cookies: [cookie("evilmicrosoft.com")] }))).toThrow(/login da Microsoft/);
  });
});

describe("validateAccountName", () => {
  it("exige que o nome diga que é a ata", () => {
    expect(validateAccountName("  Ata do   Sérgio ")).toBe("Ata do Sérgio");
    expect(validateAccountName("Sérgio (gravação)")).toBe("Sérgio (gravação)");
    expect(() => validateAccountName("Sérgio Carvalho")).toThrow(/dizer que é a ata/);
    expect(() => validateAccountName("A")).toThrow(TeamsAccountError);
    expect(() => validateAccountName("Ata " + "x".repeat(70))).toThrow(TeamsAccountError);
  });
});
