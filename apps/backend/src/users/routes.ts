import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Request, Response, Router } from "express";
import multer from "multer";
import {
  AdminUserCreate,
  AdminUserPatch,
  AgentPatch,
  IdentityChoice,
  ProfilePatch,
  UserSettingsPatch,
  type MeResponse,
  type Permission,
  type RoleKey,
} from "@meeting-bot/contracts";
import { hashPassword, validatePasswordStrength } from "../auth";
import { can, requirePermission } from "../authz";
import { PRIVILEGED_ROLES } from "../authz/matrix";
import { run, probeDuration } from "../asr/ffmpeg";
import { config } from "../config";
import { createUser, deleteUserSessions, findUserByUsername, updatePassword, withTransaction } from "../db";
import { features } from "../features";
import { invalidateHostOwner } from "../recording/owner";
import { parseBody, wrap } from "../routes";
import { audit } from "../security/audit";
import type { User } from "../types";
import {
  removeProfileFile,
  saveProfileFile,
  sendProfileFile,
  sniffAudio,
  sniffImage,
  type Sniffed,
} from "./files";
import { botDisplayNameFor } from "./identity";
import {
  accountNameFor,
  getTeamsAccountStatus,
  MAX_SESSION_BYTES,
  parseSession,
  removeTeamsAccount,
  saveTeamsAccount,
  TeamsAccountError,
  validateAccountName,
} from "./teamsAccount";
import {
  countActiveWithRole,
  getAgent,
  getAgentFile,
  getAvatarFile,
  getProfile,
  getRoles,
  getSettings,
  listAdminUsers,
  resetSettings,
  setAgentFile,
  setAvatarFile,
  setRoles,
  SettingsError,
  updateAgent,
  updateProfile,
  updateSettings,
} from "./repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function meResponse(user: User): Promise<MeResponse> {
  const [profile, settings, agent, teamsAccount] = await Promise.all([
    getProfile(user.id),
    getSettings(user.id),
    getAgent(user.id),
    getTeamsAccountStatus(user.id),
  ]);
  return {
    profile: profile!,
    settings,
    agent,
    teamsAccount,
    permissions: user.permissions,
    botDisplayName: botDisplayNameFor(profile!, agent, settings),
  };
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxAvatarBytes, files: 1 },
});
const sessionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SESSION_BYTES, files: 1 },
});
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxVoiceBytes, files: 1 },
});

function badRequest(res: Response, error: string) {
  res.status(400).json({ error });
}

// Normaliza a gravação para Ogg/Opus (tira metadados, corrige a duração do WebM do navegador)
// e mede a duração real.
async function normalizeVoice(data: Buffer, sniffed: Sniffed): Promise<{ data: Buffer; seconds: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "voz-"));
  try {
    const input = path.join(dir, `entrada.${sniffed.ext}`);
    const output = path.join(dir, "saida.ogg");
    await writeFile(input, data);
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", input,
      "-map_metadata", "-1", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k",
      "-t", String(config.maxVoiceSeconds + 1), "-f", "ogg", output,
    ]);
    const seconds = await probeDuration(output);
    return { data: await readFile(output), seconds };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const versioned = (req: Request) => typeof req.query.v === "string" && req.query.v.length > 0;

function registerMe(router: Router): void {
  router.get(
    "/me",
    wrap(async (req, res) => {
      res.json(await meResponse(req.user!));
    }),
  );

  router.patch(
    "/me/profile",
    requirePermission("settings.manage"),
    wrap(async (req, res) => {
      const patch = parseBody(ProfilePatch, req, res);
      if (!patch) return;
      await updateProfile(req.user!.id, patch);
      invalidateHostOwner();
      res.json(await meResponse(req.user!));
    }),
  );

  router.patch(
    "/me/settings",
    requirePermission("settings.manage"),
    wrap(async (req, res) => {
      const patch = parseBody(UserSettingsPatch, req, res);
      if (!patch) return;
      try {
        await updateSettings(req.user!.id, patch);
      } catch (err) {
        if (err instanceof SettingsError) return badRequest(res, err.message);
        throw err;
      }
      res.json(await meResponse(req.user!));
    }),
  );

  router.patch(
    "/me/agent",
    requirePermission("agents.manage"),
    wrap(async (req, res) => {
      const patch = parseBody(AgentPatch, req, res);
      if (!patch) return;
      await updateAgent(req.user!.id, patch);
      res.json(await meResponse(req.user!));
    }),
  );

  // Prévia do nome do bot para uma escolha feita na hora de enviá-lo.
  router.post(
    "/me/identity-preview",
    wrap(async (req, res) => {
      const choice = parseBody(IdentityChoice, req, res);
      if (!choice) return;
      const [profile, settings, agent] = await Promise.all([
        getProfile(req.user!.id),
        getSettings(req.user!.id),
        getAgent(req.user!.id),
      ]);
      res.json({ botDisplayName: botDisplayNameFor(profile!, agent, settings, choice) });
    }),
  );

  // ---------- foto do usuário ----------

  router.get(
    "/me/avatar",
    wrap(async (req, res) => sendProfileFile(res, req.user!.id, await getAvatarFile(req.user!.id), versioned(req))),
  );

  router.put(
    "/me/avatar",
    requirePermission("settings.manage"),
    imageUpload.single("file"),
    wrap(async (req, res) => {
      const sniffed = req.file ? sniffImage(req.file.buffer) : null;
      if (!req.file || !sniffed) return badRequest(res, "Envie uma imagem PNG, JPEG ou WebP no campo 'file'.");
      const previous = await getAvatarFile(req.user!.id);
      const name = await saveProfileFile(req.user!.id, "avatar", sniffed, req.file.buffer);
      await setAvatarFile(req.user!.id, name);
      await removeProfileFile(req.user!.id, previous);
      res.json(await meResponse(req.user!));
    }),
  );

  router.delete(
    "/me/avatar",
    requirePermission("settings.manage"),
    wrap(async (req, res) => {
      const previous = await getAvatarFile(req.user!.id);
      await setAvatarFile(req.user!.id, null);
      await removeProfileFile(req.user!.id, previous);
      res.json(await meResponse(req.user!));
    }),
  );

  // ---------- conta do agente no Teams ----------

  router.put(
    "/me/agent/teams-account",
    requirePermission("agents.manage"),
    sessionUpload.single("file"),
    wrap(async (req, res) => {
      if (!req.file) return badRequest(res, "Envie o arquivo da sessão no campo 'file'.");
      try {
        const typed = validateAccountName(String(req.body?.accountName ?? ""));
        const session = parseSession(req.file.buffer);
        await saveTeamsAccount(req.user!.id, accountNameFor(typed, session), session);
      } catch (err) {
        if (err instanceof TeamsAccountError) return badRequest(res, err.message);
        throw err;
      }
      audit("teams_account_connected", {}, req.user!.id);
      res.json(await meResponse(req.user!));
    }),
  );

  router.delete(
    "/me/agent/teams-account",
    requirePermission("agents.manage"),
    wrap(async (req, res) => {
      await removeTeamsAccount(req.user!.id);
      audit("teams_account_removed", {}, req.user!.id);
      res.json(await meResponse(req.user!));
    }),
  );

  // ---------- foto e voz do agente ----------

  router.get(
    "/me/agent/avatar",
    requirePermission("agents.read"),
    wrap(async (req, res) =>
      sendProfileFile(res, req.user!.id, await getAgentFile(req.user!.id, "avatar"), versioned(req)),
    ),
  );

  router.put(
    "/me/agent/avatar",
    requirePermission("agents.manage"),
    imageUpload.single("file"),
    wrap(async (req, res) => {
      const sniffed = req.file ? sniffImage(req.file.buffer) : null;
      if (!req.file || !sniffed) return badRequest(res, "Envie uma imagem PNG, JPEG ou WebP no campo 'file'.");
      const previous = await getAgentFile(req.user!.id, "avatar");
      const name = await saveProfileFile(req.user!.id, "agent-avatar", sniffed, req.file.buffer);
      await setAgentFile(req.user!.id, "avatar", name);
      await removeProfileFile(req.user!.id, previous);
      res.json(await meResponse(req.user!));
    }),
  );

  router.delete(
    "/me/agent/avatar",
    requirePermission("agents.manage"),
    wrap(async (req, res) => {
      const previous = await getAgentFile(req.user!.id, "avatar");
      await setAgentFile(req.user!.id, "avatar", null);
      await removeProfileFile(req.user!.id, previous);
      res.json(await meResponse(req.user!));
    }),
  );

  router.get(
    "/me/agent/voice",
    requirePermission("agents.read"),
    wrap(async (req, res) =>
      sendProfileFile(res, req.user!.id, await getAgentFile(req.user!.id, "voice"), versioned(req)),
    ),
  );

  router.put(
    "/me/agent/voice",
    requirePermission("agents.manage"),
    voiceUpload.single("file"),
    wrap(async (req, res) => {
      const sniffed = req.file ? sniffAudio(req.file.buffer) : null;
      if (!req.file || !sniffed) {
        return badRequest(res, "Envie um áudio (WebM, Ogg, WAV, M4A ou MP3) no campo 'file'.");
      }
      let voice: { data: Buffer; seconds: number };
      try {
        voice = await normalizeVoice(req.file.buffer, sniffed);
      } catch (err) {
        console.error("[perfil] falha ao converter a voz:", (err as Error).message);
        return badRequest(res, "Não consegui ler esse áudio. Grave de novo ou envie outro arquivo.");
      }
      if (voice.seconds < 0.5) return badRequest(res, "A gravação está vazia.");
      if (voice.seconds > config.maxVoiceSeconds) {
        return badRequest(res, `A gravação pode ter no máximo ${config.maxVoiceSeconds} segundos.`);
      }
      const previous = await getAgentFile(req.user!.id, "voice");
      const name = await saveProfileFile(req.user!.id, "agent-voice", { ext: "ogg", mime: "audio/ogg" }, voice.data);
      await setAgentFile(req.user!.id, "voice", name, Math.round(voice.seconds * 10) / 10);
      await removeProfileFile(req.user!.id, previous);
      res.json(await meResponse(req.user!));
    }),
  );

  router.delete(
    "/me/agent/voice",
    requirePermission("agents.manage"),
    wrap(async (req, res) => {
      const previous = await getAgentFile(req.user!.id, "voice");
      await setAgentFile(req.user!.id, "voice", null);
      await removeProfileFile(req.user!.id, previous);
      res.json(await meResponse(req.user!));
    }),
  );
}

// ---------- administração ----------

class AdminError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const isPrivileged = (roles: readonly RoleKey[]) => roles.some((r) => PRIVILEGED_ROLES.includes(r));

// Só SUPER_ADMIN mexe em quem é (ou vai virar) administrador.
function assertCanManage(actor: User, targetRoles: readonly RoleKey[], wantedRoles: readonly RoleKey[] = []): void {
  if (actor.roles.includes("SUPER_ADMIN")) return;
  if (isPrivileged(targetRoles) || isPrivileged(wantedRoles)) {
    throw new AdminError("Só um super administrador pode gerenciar administradores.", 403);
  }
}

function userParam(req: Request, res: Response): string | null {
  const id = String(req.params.userId ?? "");
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Usuário não encontrado." });
    return null;
  }
  return id;
}

async function adminAction(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AdminError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}

function registerAdmin(router: Router): void {
  router.get(
    "/admin/users",
    requirePermission("users.read"),
    wrap(async (_req, res) => {
      res.json({ users: await listAdminUsers() });
    }),
  );

  router.get(
    "/admin/users/:userId/avatar",
    requirePermission("users.read"),
    wrap(async (req, res) => {
      const id = userParam(req, res);
      if (id) sendProfileFile(res, id, await getAvatarFile(id), versioned(req));
    }),
  );

  router.post(
    "/admin/users",
    requirePermission("users.create"),
    wrap(async (req, res) => {
      const input = parseBody(AdminUserCreate, req, res);
      if (!input) return;
      const actor = req.user!;
      await adminAction(res, async () => {
        assertCanManage(actor, [], [input.role]);
        const problem = validatePasswordStrength(input.password);
        if (problem) throw new AdminError(problem);
        if (await findUserByUsername(input.username)) throw new AdminError("Esse usuário já existe.", 409);
        const created = await createUser(input.username, await hashPassword(input.password), {
          role: input.role,
          realName: input.realName ?? null,
          displayName: input.displayName ?? null,
          grantedBy: actor.id,
        });
        audit("admin_user_created", { target: created.id, username: created.username, role: input.role }, actor.id);
        res.status(201).json(await getProfile(created.id));
      });
    }),
  );

  router.patch(
    "/admin/users/:userId",
    wrap(async (req, res) => {
      const id = userParam(req, res);
      if (!id) return;
      const patch = parseBody(AdminUserPatch, req, res);
      if (!patch) return;
      const actor = req.user!;
      const needs: Permission[] = [
        ...(patch.realName !== undefined || patch.displayName !== undefined || patch.roles ? ["users.update" as const] : []),
        ...(patch.active !== undefined ? ["users.deactivate" as const] : []),
      ];
      if (!needs.length) return badRequest(res, "Nada para alterar.");
      if (!needs.every((p) => can(actor, p))) {
        return res.status(403).json({ error: "Você não tem permissão para esta ação." });
      }
      await adminAction(res, async () => {
        if (id === actor.id && (patch.roles || patch.active === false)) {
          throw new AdminError("Você não pode alterar o próprio papel nem se desativar.", 403);
        }
        await withTransaction(async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(73100004)");
          const target = await client.query(`SELECT id, active FROM users WHERE id = $1 FOR UPDATE`, [id]);
          if (!target.rows[0]) throw new AdminError("Usuário não encontrado.", 404);
          const currentRoles = await getRoles(id, client);
          assertCanManage(actor, currentRoles, patch.roles ?? []);

          const losesSuper =
            currentRoles.includes("SUPER_ADMIN") &&
            ((patch.roles && !patch.roles.includes("SUPER_ADMIN")) || patch.active === false);
          if (losesSuper && target.rows[0].active && (await countActiveWithRole("SUPER_ADMIN", client)) <= 1) {
            throw new AdminError("Não é possível remover o último super administrador ativo.", 409);
          }

          const sets: string[] = [];
          const values: unknown[] = [id];
          for (const [field, column] of [
            ["realName", "real_name"],
            ["displayName", "display_name"],
          ] as const) {
            if (patch[field] === undefined) continue;
            values.push(patch[field]);
            sets.push(`${column} = $${values.length}`);
          }
          if (sets.length) {
            await client.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, values);
            audit("admin_user_updated", { target: id, fields: ["realName", "displayName"].filter((f) => f in patch) }, actor.id);
          }
          if (patch.roles) {
            await setRoles(client, id, [...new Set(patch.roles)], actor.id);
            audit("admin_user_roles_changed", { target: id, from: currentRoles, to: patch.roles }, actor.id);
          }
          if (patch.active !== undefined && patch.active !== target.rows[0].active) {
            await client.query(`UPDATE users SET active = $2, updated_at = now() WHERE id = $1`, [id, patch.active]);
            if (!patch.active) await client.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
            audit(patch.active ? "admin_user_activated" : "admin_user_deactivated", { target: id }, actor.id);
          }
        });
        invalidateHostOwner();
        res.json(await getProfile(id));
      });
    }),
  );

  router.post(
    "/admin/users/:userId/reset-password",
    requirePermission("users.reset"),
    wrap(async (req, res) => {
      const id = userParam(req, res);
      if (!id) return;
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const problem = validatePasswordStrength(password);
      if (problem) return badRequest(res, problem);
      const actor = req.user!;
      await adminAction(res, async () => {
        if (!(await getProfile(id))) throw new AdminError("Usuário não encontrado.", 404);
        assertCanManage(actor, await getRoles(id));
        await updatePassword(id, await hashPassword(password));
        await deleteUserSessions(id);
        audit("admin_user_password_reset", { target: id }, actor.id);
        res.status(204).end();
      });
    }),
  );

  router.post(
    "/admin/users/:userId/reset-settings",
    requirePermission("users.reset"),
    wrap(async (req, res) => {
      const id = userParam(req, res);
      if (!id) return;
      const actor = req.user!;
      await adminAction(res, async () => {
        if (!(await getProfile(id))) throw new AdminError("Usuário não encontrado.", 404);
        assertCanManage(actor, await getRoles(id));
        await resetSettings(id);
        audit("admin_user_settings_reset", { target: id }, actor.id);
        res.json(await getProfile(id));
      });
    }),
  );
}

features.authedRouters.push((router) => {
  registerMe(router);
  registerAdmin(router);
});
