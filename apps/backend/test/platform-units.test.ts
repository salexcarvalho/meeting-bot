import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, ROLE_KEYS } from "@meeting-bot/contracts";
import { permissionsFor, rbacSeedStatements, ROLE_PERMISSIONS } from "../src/authz/matrix";
import { allows } from "../src/authz";
import { profileFilePath, sniffAudio, sniffImage } from "../src/users/files";
import { mergeSettings, SettingsError, validateSettings } from "../src/users/repo";

describe("matriz de papéis", () => {
  it("ninguém lê conteúdo alheio por padrão", () => {
    for (const role of ROLE_KEYS) expect(ROLE_PERMISSIONS[role]).not.toContain("meetings.read_all");
  });

  it("leitor não altera reuniões nem gera documentos", () => {
    const viewer = permissionsFor(["VIEWER"]);
    expect(viewer.has("meetings.read")).toBe(true);
    for (const p of ["meetings.manage", "documents.generate", "transcripts.delete", "users.read"] as const) {
      expect(viewer.has(p)).toBe(false);
    }
  });

  it("usuário comum não administra usuários nem provedores", () => {
    const user = permissionsFor(["USER"]);
    expect([...user].some((p) => p.startsWith("users."))).toBe(false);
    expect(user.has("providers.manage")).toBe(false);
    expect(user.has("meetings.manage")).toBe(true);
  });

  it("admin gerencia usuários mas não provedores; super admin tem o resto", () => {
    const admin = permissionsFor(["ADMIN"]);
    expect(admin.has("users.update")).toBe(true);
    expect(admin.has("providers.manage")).toBe(false);
    const sup = permissionsFor(["SUPER_ADMIN"]);
    expect(PERMISSION_KEYS.filter((p) => !sup.has(p))).toEqual(["meetings.read_all"]);
  });

  it("seed idempotente cobre todas as permissões e escapa aspas", () => {
    const sql = rbacSeedStatements().join("\n");
    for (const p of PERMISSION_KEYS) expect(sql).toContain(`'${p}'`);
    expect(sql).toMatch(/ON CONFLICT/);
  });

  it("acesso à reunião por modo", () => {
    expect(allows("read", "read")).toBe(true);
    expect(allows("read", "write")).toBe(false);
    expect(allows("edit", "write")).toBe(true);
    expect(allows("edit", "owner")).toBe(false);
    expect(allows("owner", "owner")).toBe(true);
    expect(allows(null, "read")).toBe(false);
  });
});

describe("configurações do usuário", () => {
  it("parte dos padrões e ignora valores salvos inválidos", () => {
    expect(mergeSettings(null)).toEqual({
      meetings: { displayIdentity: "agent", customDisplayName: null },
      documentation: { detailLevel: "normal", formats: ["markdown"] },
    });
    const merged = mergeSettings({
      meetings: { displayIdentity: "hacker", customDisplayName: "Sala 3", extra: 1 },
      documentation: { detailLevel: "detalhado", formats: [] },
    });
    expect(merged.meetings).toEqual({ displayIdentity: "agent", customDisplayName: "Sala 3" });
    expect(merged.documentation).toEqual({ detailLevel: "detalhado", formats: ["markdown"] });
  });

  it("patch altera só o que veio", () => {
    const stored = { meetings: { displayIdentity: "user", customDisplayName: "X" } };
    const merged = mergeSettings(stored, { documentation: { detailLevel: "resumido" } });
    expect(merged.meetings.displayIdentity).toBe("user");
    expect(merged.documentation.detailLevel).toBe("resumido");
  });

  it("nome personalizado é obrigatório na opção personalizada", () => {
    const s = mergeSettings(null, { meetings: { displayIdentity: "custom" } });
    expect(() => validateSettings(s)).toThrow(SettingsError);
    expect(() => validateSettings(mergeSettings(null, { meetings: { displayIdentity: "custom", customDisplayName: "Sala" } }))).not.toThrow();
  });
});

describe("arquivos do perfil", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  it("identifica imagem pelo conteúdo, não pelo nome", () => {
    expect(sniffImage(png)).toEqual({ ext: "png", mime: "image/png" });
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))?.ext).toBe("webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a"))).toBeNull();
  });

  it("identifica áudio pelo conteúdo", () => {
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))?.ext).toBe("webm");
    expect(sniffAudio(Buffer.from("OggS\0", "latin1"))?.ext).toBe("ogg");
    expect(sniffAudio(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"))?.ext).toBe("wav");
    expect(sniffAudio(png)).toBeNull();
  });

  it("recusa nomes fora do padrão gerado (path traversal)", () => {
    const uid = "11111111-1111-1111-1111-111111111111";
    expect(profileFilePath(uid, `avatar-${uid}.png`)).toMatch(/profiles\/11111111-.*\/avatar-11111111-.*\.png$/);
    expect(profileFilePath(uid, "../../etc/passwd")).toBeNull();
    expect(profileFilePath(uid, `avatar-${uid}.svg`)).toBeNull();
    expect(profileFilePath(uid, `../avatar-${uid}.png`)).toBeNull();
  });
});
