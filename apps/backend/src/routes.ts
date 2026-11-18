import { access, mkdir, rename, rm } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import { z } from "zod";
import {
  CHANNELS,
  ExtractItemsRequest,
  GenerateAdrsRequest,
  IDLE_STATUSES,
  MEETING_LIST_SCOPES,
  MEETING_STATUSES,
  IdentityChoice,
  type AsrOptions,
  type MeetingListScope,
  type LlmChoice,
  type MeetingDetail,
  type MeetingStatus,
} from "@meeting-bot/contracts";

import {
  endSession,
  getDummyHash,
  hashPassword,
  requireAuth,
  startSession,
  validatePasswordStrength,
  verifyPassword,
} from "./auth";
import { config } from "./config";
import {
  createMeeting,
  deleteMeeting,
  deleteUserSessions,
  emitMeetingChanged,
  findUserAuthz,
  findUserByUsername,
  getMeeting,
  getPasswordHash,
  listAudio,
  listMeetings,
  pool,
  updatePassword,
} from "./db";
import { enqueueProcessing, isProcessing } from "./pipeline";
import { adrLockReason, getItem, listItems } from "./items/service";
import { generationLabel, isSubscription, llmOptions, parseLlmChoice, subscriptionUnavailable } from "./llm";
import { audit } from "./security/audit";
import { createLoginLimiter } from "./security/loginLimiter";
import { activeBotCount, audioDir, isBotActive, screenshotPath, startBot, stopBot } from "./bot/runner";
import { AssistantError, sendAssistantNow } from "./bot/autoJoin";
import { detectPlatform } from "./bot/link";
import { botForUrl, botUrlKey, releaseBotUrl, reserveBotUrl } from "./bot/state";
import { meetingAccess, meetingAudience, meetingParamGuard, requirePermission, visibleMeetingsSql } from "./authz";
import { extraPermissionsFor, isOwnerOnlyRoute } from "./authz/ownerOnly";
import { resolveBotIdentity } from "./users/identity";
import { getAgent, getProfile, getSelf } from "./users/repo";
import type { User } from "./types";
import { toMeetingListItem, toMeetingSummary } from "./meetings/summary";
import { countFinalSegments, getSegments, getSpeakers, speakerNameResolver, toSegmentJson } from "./repo/transcripts";
import { toTimelineInfo } from "./repo/speakerActivity";
import { features } from "./features";
import { hub } from "./live/hub";
import { EXTERNAL_ASR_ID, externalAsrStatus } from "./asr/openrouter";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function cleanTitle(raw: unknown, fallback: string): string {
  const title = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
  return title || fallback;
}

// Handlers assíncronos: erros vão para o middleware de erro do Express.
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

/** Entrada recusada: guarda só o IP (Q5-A: IP apenas nas falhas) e nunca o nome digitado nem a senha. */
function auditLoginFailed(ip: string | undefined, userId: string | null, extra: Record<string, unknown>): void {
  audit("auth_login_failed", { ip: ip ?? null, usernameKnown: userId !== null, ...extra }, userId);
}

export function parseBody<T>(schema: z.ZodType<T>, req: Request, res: Response): T | null {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({ error: first ? `${first.path.join(".") || "corpo"}: ${first.message}` : "Corpo inválido." });
    return null;
  }
  return result.data;
}

// Escolha de ASR por reunião: null = padrão do .env. O externo só vale com a flag e a chave.
export function parseAsrChoice(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "" || value === "default") return { ok: true, value: null };
  if (value === "local") return { ok: true, value: "local" };
  if (value === EXTERNAL_ASR_ID) {
    const status = externalAsrStatus();
    if (!status) return { ok: false, error: "ASR externo desabilitado (ALLOW_EXTERNAL_ASR=false)." };
    if (!status.available) return { ok: false, error: "Configure OPENROUTER_API_KEY no .env para usar o ASR externo." };
    return { ok: true, value: EXTERNAL_ASR_ID };
  }
  return { ok: false, error: "Opção de transcrição inválida." };
}

export async function sessionPayload(user: User) {
  const asr: AsrOptions = { default: config.asrProvider, external: externalAsrStatus() };
  const [profile, agent] = await Promise.all([getProfile(user.id), getAgent(user.id)]);
  return {
    user: { id: user.id, username: user.username },
    displayName: profile?.name ?? user.username,
    avatarVersion: profile?.hasAvatar ? profile.avatarVersion : null,
    agentName: agent.name,
    roles: user.roles,
    permissions: user.permissions,
    asr,
    llm: await llmOptions(user.id),
  };
}

/** Escolha de LLM de um pedido: valida a configuração e, na assinatura, se vale para esta reunião agora. */
async function requestedLlm(
  value: unknown,
  meetingOwnerId: string | null,
): Promise<{ ok: true; value: LlmChoice } | { ok: false; status: number; error: string }> {
  const llm = parseLlmChoice(value);
  if (!llm.ok) return { ok: false, status: 400, error: llm.error };
  if (isSubscription(llm.value)) {
    const reason = await subscriptionUnavailable(llm.value, meetingOwnerId);
    if (reason) return { ok: false, status: 409, error: reason };
  }
  return llm;
}

/** Nome de exibição do dono (só vai a quem recebeu o compartilhamento). */
async function ownerNameOf(ownerId: string | null): Promise<string | null> {
  return (await getSelf(ownerId))?.name ?? null;
}

export async function loadMeetingDetail(meetingId: string, user: User): Promise<MeetingDetail | null> {
  const [meeting, myAccess] = await Promise.all([getMeeting(meetingId), meetingAccess(user, meetingId)]);
  if (!meeting || !myAccess) return null;
  const [segments, speakers, audio, hasScreenshot] = await Promise.all([
    getSegments(meetingId),
    getSpeakers(meetingId),
    listAudio(meetingId),
    access(screenshotPath(meetingId)).then(
      () => true,
      () => false,
    ),
  ]);
  const nameOf = speakerNameResolver(speakers);
  return {
    meeting: toMeetingSummary(meeting),
    segments: segments.map((s) => toSegmentJson(s, nameOf)),
    speakers,
    audio: audio.map((a) => ({ channel: a.channel, format: a.format, durationSeconds: a.duration_seconds })),
    liveSummary: meeting.live_summary,
    liveSummaryAt: meeting.live_summary_at?.toISOString() ?? null,
    hasScreenshot,
    legacyAta: meeting.analysis ? null : meeting.ata_markdown,
    hasAnalysis: Boolean(meeting.analysis),
    transcriptionProvider: meeting.transcription_provider,
    asrProvider: meeting.asr_provider,
    access: myAccess,
    ownerName: myAccess === "owner" ? null : await ownerNameOf(meeting.created_by),
    analysisProvider: meeting.analysis_provider,
    speakerTimeline: toTimelineInfo(meeting.speaker_timeline_meta),
  };
}

const TRANSCRIPT_ROUTES: ReadonlySet<string> = new Set(["/meetings/:id", "/meetings/:id/audio"]);

export function buildRouter(): Router {
  const router = Router({ caseSensitive: true });

  // ---------- auth ----------

  // Bloqueio por limite de taxa também é tentativa de entrada recusada (a conta alvo vê na auditoria),
  // mas só a primeira requisição bloqueada da janela é auditada.
  const loginLimiter = createLoginLimiter(async (req) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const known = username ? await findUserByUsername(username) : null;
    auditLoginFailed(req.ip, known?.id ?? null, { rateLimited: true });
  });

  router.post(
    "/auth/login",
    loginLimiter,
    wrap(async (req, res) => {
      const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const user = username ? await findUserByUsername(username) : null;
      const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
      if (!user || !ok) {
        auditLoginFailed(req.ip, user?.id ?? null, {});
        return res.status(401).json({ error: "Usuário ou senha inválidos." });
      }
      if (!user.active) {
        auditLoginFailed(req.ip, user.id, { inactive: true });
        return res.status(403).json({ error: "Usuário desativado. Fale com um administrador." });
      }
      const authz = await findUserAuthz(user.id);
      await startSession(res, user.id);
      audit("auth_login", {}, user.id);
      res.json(await sessionPayload(authz!));
    }),
  );

  router.post(
    "/auth/logout",
    wrap(async (req, res) => {
      const owner = await endSession(req, res);
      if (owner) audit("auth_logout", {}, owner);
      res.status(204).end();
    }),
  );

  router.use(wrap(async (req, res, next) => requireAuth(req, res, next)));

  router.get(
    "/auth/me",
    wrap(async (req, res) => {
      res.json(await sessionPayload(req.user!));
    }),
  );

  router.post(
    "/auth/password",
    wrap(async (req, res) => {
      const { currentPassword, newPassword } = req.body ?? {};
      const problem = validatePasswordStrength(newPassword);
      if (problem) return res.status(400).json({ error: problem });
      const stored = await getPasswordHash(req.user!.id);
      if (!stored || !(await verifyPassword(String(currentPassword ?? ""), stored))) {
        return res.status(400).json({ error: "Senha atual incorreta." });
      }
      await updatePassword(req.user!.id, await hashPassword(newPassword));
      const revoked = await deleteUserSessions(req.user!.id, req.sessionTokenHash);
      audit("auth_password_changed", { sessionsRevoked: revoked }, req.user!.id);
      res.status(204).end();
    }),
  );

  // Toda rota /meetings/:id/* passa por aqui: dono, compartilhamento ou 404 (authz/index.ts).
  router.param(
    "id",
    meetingParamGuard({
      extraFor: (req, pattern) => extraPermissionsFor(req.method, pattern, TRANSCRIPT_ROUTES),
      ownerOnly: (req, pattern) => isOwnerOnlyRoute(req.method, pattern),
    }),
  );

  // ---------- reuniões ----------

  router.get(
    "/meetings",
    requirePermission("meetings.read"),
    wrap(async (req, res) => {
      const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
      const projectId = typeof req.query.projectId === "string" && UUID_RE.test(req.query.projectId) ? req.query.projectId : null;
      const status =
        typeof req.query.status === "string"
          ? req.query.status.split(",").filter((v): v is MeetingStatus => (MEETING_STATUSES as readonly string[]).includes(v))
          : null;
      const rawScope = req.query.scope ?? "all";
      if (typeof rawScope !== "string" || !(MEETING_LIST_SCOPES as readonly string[]).includes(rawScope)) {
        return res.status(400).json({ error: "Escopo inválido." });
      }
      const viewerId = req.user!.id;
      const meetings = await listMeetings({
        visibleTo: { userId: viewerId, sql: visibleMeetingsSql(req.user!, "m", 1) },
        limit: Number(req.query.limit) || 50,
        before: before && !Number.isNaN(before.getTime()) ? before : null,
        projectId,
        status,
        scope: rawScope as MeetingListScope,
      });
      res.json({ meetings: meetings.map((m) => toMeetingListItem(m, viewerId)) });
    }),
  );

  router.post(
    "/meetings",
    requirePermission("meetings.manage"),
    wrap(async (req, res) => {
      const requestedAt = Date.now();
      const target = detectPlatform(req.body?.url);
      if (!target) {
        return res.status(400).json({
          error:
            "Link inválido. Use um link https do Google Meet (meet.google.com) ou do Teams (teams.microsoft.com / teams.live.com).",
        });
      }
      let identity: IdentityChoice | undefined;
      if (req.body?.identity !== undefined && req.body.identity !== null) {
        const parsed = IdentityChoice.safeParse(req.body.identity);
        if (!parsed.success) return res.status(400).json({ error: "Identidade inválida." });
        if (parsed.data.mode === "custom" && !parsed.data.customName) {
          return res.status(400).json({ error: "Informe o nome personalizado do bot." });
        }
        identity = parsed.data;
      }

      // Um bot por link: clique duplo, duas abas ou reenvio devolvem o bot que já está entrando.
      const urlKey = botUrlKey(target.url);
      const existing = botForUrl(urlKey);
      if (existing || !reserveBotUrl(urlKey)) {
        const visible = existing && (await meetingAccess(req.user!, existing)) ? existing : null;
        return res.status(409).json({
          error: "Já existe um bot entrando ou gravando esta reunião.",
          meetingId: visible,
        });
      }
      try {
        if (activeBotCount() > config.maxConcurrentBots) {
          return res.status(429).json({
            error: `Já existem ${activeBotCount() - 1} bots em reunião (limite ${config.maxConcurrentBots}). Encerre um antes.`,
          });
        }
        const botIdentity = await resolveBotIdentity(req.user!.id, identity, target.platform);
        const id = await createMeeting({
          title: cleanTitle(req.body?.title, "Reunião sem título"),
          platform: target.platform,
          url: target.url,
          status: "joining",
          createdBy: req.user!.id,
          source: "bot",
          botDisplayName: botIdentity.name,
        });
        startBot(id, target.url, target.platform, { identity: botIdentity, urlKey, requestedAt });
        const meeting = await getMeeting(id);
        console.log(`[bot ${id}] pedido aceito em ${Date.now() - requestedAt} ms`);
        res.status(201).json(toMeetingSummary(meeting!));
      } finally {
        releaseBotUrl(urlKey);
      }
    }),
  );

  // Reunião da agenda: manda o assistente agora (fora do horário ou depois de uma falha).
  router.post(
    "/meetings/:id/assistant",
    requirePermission("meetings.manage"),
    wrap(async (req, res) => {
      const id = String(req.params.id);
      try {
        await sendAssistantNow(id);
      } catch (err) {
        if (err instanceof AssistantError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      const meeting = await getMeeting(id);
      res.status(202).json(toMeetingSummary(meeting!));
    }),
  );

  const uploadTmp = path.join(config.dataDir, "uploads");
  const upload = multer({
    dest: uploadTmp,
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      cb(null, /^(audio|video)\//.test(file.mimetype));
    },
  });

  router.post(
    "/meetings/upload",
    requirePermission("meetings.manage"),
    upload.single("audio"),
    wrap(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "Envie um arquivo de áudio ou vídeo no campo 'audio'." });
      }
      const asr = parseAsrChoice(req.body?.asr);
      if (!asr.ok) {
        await rm(req.file.path, { force: true });
        return res.status(400).json({ error: asr.error });
      }
      const ext = path.extname(req.file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
      const fileId = randomUUID();
      const dir = path.join(audioDir, fileId);
      await mkdir(dir, { recursive: true });
      const finalPath = path.join(dir, `mixed${ext}`);
      await rename(req.file.path, finalPath);

      const meetingId = await createMeeting({
        title: cleanTitle(req.body?.title, req.file.originalname.slice(0, 200)),
        platform: "upload",
        url: null,
        status: "queued",
        createdBy: req.user!.id,
        source: "upload",
        audioPath: finalPath,
        audioFormat: "original",
        asrProvider: asr.value,
      });
      enqueueProcessing(meetingId);
      const meeting = await getMeeting(meetingId);
      res.status(201).json(toMeetingSummary(meeting!));
    }),
  );

  router.get(
    "/meetings/:id",
    wrap(async (req, res) => {
      const detail = await loadMeetingDetail(String(req.params.id), req.user!);
      if (!detail) return res.status(404).json({ error: "Reunião não encontrada." });
      res.json(detail);
    }),
  );

  router.post(
    "/meetings/:id/end",
    wrap(async (req, res, next) => {
      // Bot convidado; gravações locais são tratadas pela rota registrada na US2.
      if (stopBot(String(req.params.id))) return res.status(202).json({ status: "ending" });
      next();
    }),
  );

  router.post(
    "/meetings/:id/reprocess",
    requirePermission("documents.generate"),
    wrap(async (req, res) => {
      const meeting = await getMeeting(String(req.params.id));
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      if (isBotActive(meeting.id) || isProcessing(meeting.id) || !["done", "error"].includes(meeting.status)) {
        return res.status(409).json({ error: "A reunião ainda está em andamento ou em processamento." });
      }
      const step = req.body?.step === "analysis" ? "analysis" : "all";
      const audio = await listAudio(meeting.id);
      if (step === "all" && !audio.some((a) => a.format !== "pcm_s16le_16k")) {
        return res.status(409).json({ error: "Esta reunião não tem áudio gravado." });
      }
      const llm = await requestedLlm(req.body?.llm, meeting.created_by);
      if (!llm.ok) return res.status(llm.status).json({ error: llm.error });
      if (step === "all" && req.body?.asr !== undefined) {
        const asr = parseAsrChoice(req.body.asr);
        if (!asr.ok) return res.status(400).json({ error: asr.error });
        await pool.query(`UPDATE meetings SET asr_provider = $2 WHERE id = $1`, [meeting.id, asr.value]);
      }
      if (!enqueueProcessing(meeting.id, step, { llm: llm.value })) {
        return res.status(409).json({ error: "A reunião já está na fila de processamento." });
      }
      audit("generation_requested", { meetingId: meeting.id, step, provider: generationLabel(llm.value) }, req.user!.id);
      res.status(202).json({ status: "queued", provider: generationLabel(llm.value) });
    }),
  );

  // Liga ou desliga os itens (decisões, pendências, riscos…) desta reunião. Vale para a extração ao
  // vivo e para a análise final; o que já foi gerado não é apagado. Só o dono decide.
  router.put(
    "/meetings/:id/extract-items",
    requirePermission("meetings.manage"),
    wrap(async (req, res) => {
      const body = parseBody(ExtractItemsRequest, req, res);
      if (!body) return;
      const meeting = await getMeeting(String(req.params.id));
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      if (isProcessing(meeting.id) || ["queued", "transcribing", "generating_ata"].includes(meeting.status)) {
        return res.status(409).json({ error: "A reunião está em processamento; tente de novo quando terminar." });
      }
      await pool.query(`UPDATE meetings SET extract_items = $2 WHERE id = $1`, [meeting.id, body.enabled]);
      emitMeetingChanged(meeting.id);
      res.json(toMeetingSummary((await getMeeting(meeting.id))!));
    }),
  );

  // Onde dá para gerar agora (a assinatura depende do dono da reunião e do host-agent).
  router.get(
    "/meetings/:id/llm-options",
    wrap(async (req, res) => {
      const meeting = await getMeeting(String(req.params.id));
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      res.json(await llmOptions(meeting.created_by));
    }),
  );

  // Gerar ADRs sob demanda (todas as decisões arquiteturais pendentes ou uma só).
  router.post(
    "/meetings/:id/adrs/generate",
    requirePermission("documents.generate"),
    wrap(async (req, res) => {
      const body = parseBody(GenerateAdrsRequest, req, res);
      if (!body) return;
      const meeting = await getMeeting(String(req.params.id));
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      if (isBotActive(meeting.id) || isProcessing(meeting.id) || !["done", "error"].includes(meeting.status)) {
        return res.status(409).json({ error: "A reunião ainda está em andamento ou em processamento." });
      }
      if ((await countFinalSegments(meeting.id)) === 0) {
        return res.status(409).json({ error: "Esta reunião ainda não tem transcrição final. Gere a ata primeiro." });
      }
      const llm = await requestedLlm(body.llm, meeting.created_by);
      if (!llm.ok) return res.status(llm.status).json({ error: llm.error });
      if (body.itemId) {
        const item = await getItem(body.itemId);
        if (!item || item.meetingId !== meeting.id) {
          return res.status(404).json({ error: "Decisão não encontrada nesta reunião." });
        }
        if (item.type !== "decisao_arquitetural") {
          return res.status(400).json({ error: "ADR é gerado só para decisões arquiteturais." });
        }
        if (item.reviewStatus === "rejeitado") {
          return res.status(409).json({ error: "Esta decisão foi rejeitada; não gera ADR." });
        }
        const lock = await adrLockReason(item.id);
        if (lock) return res.status(409).json({ error: lock });
      } else {
        const decisions = (await listItems(meeting.id)).filter(
          (i) => i.type === "decisao_arquitetural" && i.reviewStatus !== "rejeitado",
        );
        if (!decisions.length) {
          return res.status(409).json({ error: "Nenhuma decisão arquitetural nesta reunião para gerar ADR." });
        }
      }
      if (!enqueueProcessing(meeting.id, "adrs", { llm: llm.value, itemId: body.itemId })) {
        return res.status(409).json({ error: "A reunião já está na fila de processamento." });
      }
      audit(
        "generation_requested",
        { meetingId: meeting.id, step: "adrs", itemId: body.itemId ?? null, provider: generationLabel(llm.value) },
        req.user!.id,
      );
      res.status(202).json({ status: "queued", provider: generationLabel(llm.value) });
    }),
  );

  router.delete(
    "/meetings/:id",
    wrap(async (req, res) => {
      const meeting = await getMeeting(String(req.params.id));
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      if (isBotActive(meeting.id) || isProcessing(meeting.id) || !IDLE_STATUSES.includes(meeting.status)) {
        return res.status(409).json({ error: "Encerre a gravação e aguarde o processamento antes de excluir." });
      }
      const audio = await listAudio(meeting.id);
      const recipients = [...(await meetingAudience(meeting.id))].filter((id) => id !== req.user!.id);
      await deleteMeeting(meeting.id);
      for (const userId of recipients) {
        hub.revokeAccess(meeting.id, userId, {
          type: "meeting_access",
          meetingId: meeting.id,
          change: "deleted",
          access: null,
          by: null,
          title: null,
          meeting: null,
        });
      }
      for (const a of audio) await rm(a.path, { force: true });
      if (meeting.audio_path) await rm(meeting.audio_path, { force: true });
      await rm(path.join(audioDir, meeting.id), { recursive: true, force: true });
      await rm(screenshotPath(meeting.id), { force: true });
      res.status(204).end();
    }),
  );

  router.get(
    "/meetings/:id/audio",
    wrap(async (req, res) => {
      const wanted = typeof req.query.channel === "string" ? req.query.channel : null;
      if (wanted && !(CHANNELS as readonly string[]).includes(wanted)) {
        return res.status(400).json({ error: "Canal inválido." });
      }
      const audio = await listAudio(String(req.params.id));
      const file = wanted ? audio.find((a) => a.channel === wanted) : audio[0];
      if (!file) return res.status(404).json({ error: "Sem áudio." });
      if (file.format === "pcm_s16le_16k") {
        return res.status(409).json({ error: "O áudio fica disponível quando a gravação terminar." });
      }
      res.sendFile(file.path, { headers: { "Cache-Control": "private, no-cache" } }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "Arquivo de áudio não encontrado." });
      });
    }),
  );

  router.get("/meetings/:id/screenshot", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(screenshotPath(String(req.params.id)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Sem screenshot." });
    });
  });

  // Rotas das user stories (agenda, gravação, itens, projetos...).
  for (const register of features.authedRouters) register(router);

  return router;
}
