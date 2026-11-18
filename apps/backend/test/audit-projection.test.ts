import { describe, expect, it } from "vitest";
import { isKnownKind, knownKinds, project, userKinds, type RawEvent } from "../src/audit/projection";

const AT = new Date("2026-11-15T12:00:00Z");
const ana = { id: "ana-id", username: "ana" };
const root = { id: "root-id", username: "sergio" };

function event(kind: string, detail: Record<string, unknown>, over: Partial<RawEvent> = {}): RawEvent {
  return { id: 1, at: AT, kind, detail, actor: null, target: null, ...over };
}

// Default deny: só o que está na lista permitida aparece, e nunca dado de reunião.
describe("projeção da auditoria", () => {
  it("descarta campos fora da lista permitida", () => {
    const view = project(
      event("external_llm", {
        provider: "openrouter",
        model: "m",
        purpose: "ata",
        success: true,
        meetingId: "reuniao-secreta",
        label: "extração final 1/2",
        promptTokens: 10,
        qualquerCoisa: "texto livre",
      }),
      "ana-id",
    );
    expect(view.fields).toEqual({ provider: "openrouter", model: "m", purpose: "ata", success: true });
    expect(JSON.stringify(view)).not.toMatch(/reuniao-secreta|texto livre|extração final/);
  });

  it("tipo desconhecido mostra só tipo e data (sem ator, alvo nem campos)", () => {
    const view = project(event("tipo_novo_sem_regra", { segredo: "x", meetingId: "m" }, { actor: ana, target: root }), "root-id");
    expect(view).toEqual({
      id: 1,
      at: AT.toISOString(),
      kind: "tipo_novo_sem_regra",
      title: "tipo_novo_sem_regra",
      actor: null,
      target: null,
      fields: {},
    });
  });

  it("meetingId e título de reunião nunca aparecem, em nenhum tipo conhecido", () => {
    for (const kind of knownKinds()) {
      const view = project(event(kind, { meetingId: "M-1", title: "Reunião secreta", meetingTitle: "Reunião secreta" }, { actor: ana }), "root-id");
      expect(JSON.stringify(view)).not.toMatch(/M-1|Reunião secreta/);
      expect(Object.keys(view.fields)).not.toContain("meetingId");
    }
  });

  it("ação de admin lida do ponto de vista do alvo, do admin e de terceiros", () => {
    const e = event("admin_user_password_reset", { target: "ana-id" }, { actor: root, target: ana });
    expect(project(e, "ana-id").title).toBe("Administrador sergio redefiniu sua senha");
    expect(project(e, "root-id").title).toBe("Você redefiniu a senha de ana");
    expect(project(e, "outro").title).toBe("Sergio redefiniu a senha de ana");
  });

  it("IP só no tipo que o define; papéis e listas só com strings", () => {
    const failed = project(event("auth_login_failed", { ip: "10.0.0.5", usernameKnown: true, rateLimited: true }, { actor: ana }), "ana-id");
    expect(failed.fields).toEqual({ ip: "10.0.0.5", rateLimited: true });
    expect(failed.title).toMatch(/bloqueada/);
    const login = project(event("auth_login", { ip: "10.0.0.5" }, { actor: ana }), "ana-id");
    expect(login.fields).toEqual({});
    const roles = project(event("admin_user_roles_changed", { from: ["USER"], to: ["ADMIN", 3, { x: 1 }] }, { actor: root, target: ana }), "root-id");
    expect(roles.fields).toEqual({ from: ["USER"], to: ["ADMIN"] });
  });

  it("textos longos são cortados e objetos aninhados descartados", () => {
    const view = project(event("external_llm", { model: "m".repeat(500), provider: { a: 1 } }), null);
    expect(String(view.fields.model)).toHaveLength(120);
    expect(view.fields).not.toHaveProperty("provider");
  });

  it("envio externo mostra provedor e finalidade em pt-BR, e a recusa", () => {
    expect(project(event("external_llm", { provider: "claude", purpose: "adr", success: true }), null).title).toBe("Texto enviado ao Claude (adr)");
    expect(project(event("external_llm", { provider: "openrouter", success: false }), null).title).toBe("Texto enviado ao OpenRouter: recusado");
    expect(project(event("external_asr", { phase: "start", seconds: 30 }), null).title).toBe("Áudio enviado para transcrição externa");
    expect(project(event("external_asr", { phase: "end", success: false }), null).title).toBe("Transcrição externa falhou");
  });

  it("o usuário comum só vê tipos dele; eventos de sistema ficam para quem tem audit.read", () => {
    const mine = userKinds();
    expect(mine).toContain("auth_login");
    expect(mine).toContain("external_llm");
    for (const systemKind of ["egress_blocked", "agent_auth_failed", "retention_pruned", "agent_calendar_import"]) {
      expect(mine).not.toContain(systemKind);
      expect(isKnownKind(systemKind)).toBe(true);
    }
    expect(isKnownKind("constructor")).toBe(false);
    expect(isKnownKind("__proto__")).toBe(false);
  });
});
