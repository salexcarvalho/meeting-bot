import { describe, expect, it } from "vitest";
import { OWNER_ONLY_ANY_METHOD, OWNER_ONLY_ROUTES, extraPermissionsFor, isOwnerOnlyRoute } from "../src/authz/ownerOnly";
import { escapeLike, foldText, LOOKUP_MAX_CHARS, lookupPattern } from "../src/users/lookupPattern";
import { hasSeries } from "../src/shares/service";
import { toMeetingListItem, toMeetingSummary } from "../src/meetings/summary";
import { visibilitySql } from "../src/llm/usage";
import type { MeetingRow } from "../src/db";
import type { User } from "../src/types";

// Guard de rotas de compartilhamento (specs/005, T007): o conjunto "dono em qualquer método" cobre o GET,
// senão a lista de acessos vazaria a quem só lê.
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Combinações método x padrão em que uma rota de gestão de compartilhamento NÃO está restrita ao dono. */
function unprotectedShareRoutes(isOwnerOnly: (method: string, pattern: string) => boolean): string[] {
  const out: string[] = [];
  for (const pattern of OWNER_ONLY_ANY_METHOD) {
    for (const method of METHODS) if (!isOwnerOnly(method, pattern)) out.push(`${method} ${pattern}`);
  }
  return out;
}

describe("guard do compartilhamento (padrão de rota, não URL digitada)", () => {
  it("/shares e /shares/:userId são do dono em qualquer método, inclusive GET", () => {
    expect(unprotectedShareRoutes(isOwnerOnlyRoute)).toEqual([]);
    expect(isOwnerOnlyRoute("GET", "/meetings/:id/shares")).toBe(true);
    expect(isOwnerOnlyRoute("GET", "/meetings/:id/shares/:userId")).toBe(true);
  });

  it("o teste pega o erro: um guard que só protegesse métodos de escrita deixaria o GET aberto", () => {
    const mutant = (method: string, pattern: string) => method !== "GET" && OWNER_ONLY_ROUTES.has(pattern);
    const mutantWithShares = (method: string, pattern: string) =>
      method !== "GET" && (OWNER_ONLY_ROUTES.has(pattern) || OWNER_ONLY_ANY_METHOD.has(pattern));
    expect(unprotectedShareRoutes(mutant).length).toBe(METHODS.length * OWNER_ONLY_ANY_METHOD.size);
    expect(unprotectedShareRoutes(mutantWithShares)).toEqual([
      "GET /meetings/:id/shares",
      "GET /meetings/:id/shares/:userId",
    ]);
  });

  it("as rotas antigas só do dono continuam valendo para escrita e não para GET", () => {
    for (const pattern of OWNER_ONLY_ROUTES) {
      expect(isOwnerOnlyRoute("POST", pattern), pattern).toBe(true);
      expect(isOwnerOnlyRoute("GET", pattern), pattern).toBe(false);
    }
    expect(isOwnerOnlyRoute("GET", "/meetings/:id/items")).toBe(false);
  });

  it("variações da URL não mudam o padrão: o guard compara o padrão registrado, que vem do código", () => {
    for (const typed of ["/MEETINGS/:id/shares", "//meetings/:id/shares", "/meetings/:id/shares/"]) {
      expect(isOwnerOnlyRoute("GET", typed), typed).toBe(false);
    }
  });

  it("transcripts.delete vale só para excluir a reunião, não para DELETE de rotas filhas", () => {
    const transcript = new Set(["/meetings/:id", "/meetings/:id/audio"]);
    expect(extraPermissionsFor("DELETE", "/meetings/:id", transcript)).toEqual(["transcripts.delete"]);
    expect(extraPermissionsFor("DELETE", "/meetings/:id/shares/:userId", transcript)).toEqual([]);
    expect(extraPermissionsFor("GET", "/meetings/:id/audio", transcript)).toEqual(["transcripts.read"]);
    expect(extraPermissionsFor("GET", "/meetings/:id/shares", transcript)).toEqual([]);
  });
});

describe("busca de usuário: padrão de prefixo", () => {
  it("exige ao menos 3 caracteres depois do trim e no máximo o teto", () => {
    expect(lookupPattern("bi")).toBeNull();
    expect(lookupPattern("  bi  ")).toBeNull();
    expect(lookupPattern("bia")).toBe("bia%");
    expect(lookupPattern("x".repeat(LOOKUP_MAX_CHARS))).not.toBeNull();
    expect(lookupPattern("x".repeat(LOOKUP_MAX_CHARS + 1))).toBeNull();
    expect(lookupPattern(undefined)).toBeNull();
    expect(lookupPattern(["bia"])).toBeNull();
  });

  it("curingas do LIKE e a barra são literais", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(lookupPattern("%%%")).toBe("\\%\\%\\%%");
    expect(lookupPattern("___")).toBe("\\_\\_\\_%");
  });

  it("ignora maiúsculas e acentos", () => {
    expect(foldText("JOÃO Conceição")).toBe("joao conceicao");
    expect(lookupPattern("Ânge")).toBe("ange%");
  });
});

describe("série", () => {
  it("há série com series_id (manual) ou ical_uid (.ics); sem nenhum dos dois, não", () => {
    expect(hasSeries({ seriesId: "s", icalUid: null })).toBe(true);
    expect(hasSeries({ seriesId: null, icalUid: "uid@x" })).toBe(true);
    expect(hasSeries({ seriesId: null, icalUid: null })).toBe(false);
  });
});

function row(patch: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: "m1",
    title: "Reunião",
    platform: "meet",
    url: null,
    status: "scheduled",
    error_message: null,
    created_by: "dono",
    created_by_username: "ana",
    created_at: new Date("2026-11-14T10:00:00Z"),
    scheduled_start: null,
    attendees: [],
    skip_recording: false,
    auto_on_off_day: false,
    extract_items: false,
    source: "manual",
    project_id: null,
    project_name: null,
    project_suggested: false,
    series_id: null,
    recurrence_rule: null,
    ...patch,
  } as unknown as MeetingRow;
}

describe("projeção por espectador", () => {
  it("o resumo difundido não carrega campos por espectador", () => {
    const summary = toMeetingSummary(row({ owner_name: "Ana", viewer_share_access: "edit", share_unseen: true, share_count: 3 }));
    for (const key of ["access", "ownerName", "shareCount", "shareUnseen"]) {
      expect(Object.hasOwn(summary, key), key).toBe(false);
    }
  });

  it("dono vê a contagem e nenhum nome de dono", () => {
    const item = toMeetingListItem(row({ share_count: "2", owner_name: "Ana" }), "dono");
    expect(item).toMatchObject({ access: "owner", ownerName: null, shareCount: 2, shareUnseen: false });
  });

  it("destinatário vê o próprio nível, o nome do dono e a marca Nova; nunca a contagem", () => {
    const novo = toMeetingListItem(row({ viewer_share_access: "read", owner_name: "Ana", share_unseen: true }), "bia");
    expect(novo).toMatchObject({ access: "read", ownerName: "Ana", shareCount: null, shareUnseen: true });
    const visto = toMeetingListItem(row({ viewer_share_access: "edit", owner_name: "Ana", share_unseen: false }), "bia");
    expect(visto).toMatchObject({ access: "edit", shareUnseen: false });
  });
});

describe("consumo de IA é do dono (FR-015)", () => {
  const user = (permissions: string[]) => ({ id: "u", username: "u", roles: [], permissions }) as unknown as User;

  it("sem read_all só entram chamadas de reuniões criadas pelo usuário, nunca as compartilhadas", () => {
    const sql = visibilitySql(user(["meetings.read"]));
    expect(sql).toContain("m.created_by = $3");
    expect(sql).not.toContain("meeting_shares");
  });

  it("quem lê todas segue vendo o consumo da instância", () => {
    expect(visibilitySql(user(["meetings.read_all"]))).toContain("m.id IS NULL");
  });
});
