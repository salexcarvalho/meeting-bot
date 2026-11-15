import express, { type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  AgentCalendarImportInput,
  HeartbeatInput,
  ScheduledMeetingInput,
  ScheduledMeetingPatch,
  type AgentMeeting,
  type HeartbeatResponse,
} from "@meeting-bot/contracts";
import { requireAgent } from "../agent/agentAuth";
import { requirePermission } from "../authz";
import { config } from "../config";
import { pool } from "../db";
import { features } from "../features";
import { toMeetingSummary } from "../meetings/summary";
import { recordHeartbeat } from "../recording/hostAgentState";
import { hostAgentOwner } from "../recording/owner";
import { parseBody, wrap } from "../routes";
import { audit } from "../security/audit";
import { importAgentCalendar } from "./agentImport";
import { autoSuppressed } from "./offDay";
import { startSeriesExtender, stopSeriesExtender } from "./seriesExtend";
import {
  CalendarError,
  cancelScheduled,
  createScheduled,
  getAgenda,
  importIcs,
  setAutoOnOffDay,
  setSkip,
  todayIn,
  updateScheduled,
} from "./service";

function handleError(res: Response, err: unknown): void {
  if (err instanceof CalendarError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

// Falha do envio da agenda: só motivo e tamanhos, sem conteúdo (títulos, participantes, texto do .ics).
function auditImportFailure(
  reason: "invalid_body" | "no_owner" | "rejected",
  body: unknown,
  userId: string | null,
  extra: Record<string, unknown> = {},
): void {
  const b = (body && typeof body === "object" ? body : {}) as { events?: unknown; ics?: unknown; date?: unknown };
  audit(
    "agent_calendar_import_failed",
    {
      reason,
      mode: Array.isArray(b.events) ? "events" : typeof b.ics === "string" ? "ics" : "unknown",
      events: Array.isArray(b.events) ? b.events.length : 0,
      icsChars: typeof b.ics === "string" ? b.ics.length : 0,
      ...extra,
    },
    userId,
  );
}

const icsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    cb(null, /\.ics$/i.test(file.originalname) || /calendar/i.test(file.mimetype));
  },
});

features.authedRouters.push((router) => {
  router.get(
    "/agenda",
    requirePermission("meetings.read"),
    wrap(async (req, res) => {
      const date = typeof req.query.date === "string" && req.query.date ? req.query.date : todayIn(config.appTimezone);
      try {
        res.json(await getAgenda(date, req.user!));
      } catch (err) {
        if (err instanceof Error && /Data inválida/.test(err.message)) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }),
  );

  router.post(
    "/calendar/import",
    requirePermission("meetings.manage"),
    icsUpload.array("files", 10),
    wrap(async (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) return res.status(400).json({ error: "Envie ao menos um arquivo .ics no campo 'files'." });
      const result = await importIcs(
        files.map((f) => ({ name: f.originalname.slice(0, 200), text: f.buffer.toString("utf8") })),
        req.user!.id,
      );
      res.json(result);
    }),
  );

  router.post(
    "/meetings/scheduled",
    requirePermission("meetings.manage"),
    wrap(async (req, res) => {
      const input = parseBody(ScheduledMeetingInput, req, res);
      if (!input) return;
      try {
        res.status(201).json(toMeetingSummary(await createScheduled(input, req.user!.id)));
      } catch (err) {
        handleError(res, err);
      }
    }),
  );

  router.patch(
    "/meetings/:id",
    wrap(async (req, res) => {
      const patch = parseBody(ScheduledMeetingPatch, req, res);
      if (!patch) return;
      try {
        res.json(toMeetingSummary(await updateScheduled(String(req.params.id), patch)));
      } catch (err) {
        handleError(res, err);
      }
    }),
  );

  router.post(
    "/meetings/:id/skip",
    wrap(async (req, res) => {
      const body = parseBody(z.object({ skip: z.boolean() }), req, res);
      if (!body) return;
      try {
        res.json(toMeetingSummary(await setSkip(String(req.params.id), body.skip)));
      } catch (err) {
        handleError(res, err);
      }
    }),
  );

  router.post(
    "/meetings/:id/auto-off-day",
    wrap(async (req, res) => {
      const body = parseBody(z.object({ enabled: z.boolean() }), req, res);
      if (!body) return;
      try {
        res.json(toMeetingSummary(await setAutoOnOffDay(String(req.params.id), body.enabled)));
      } catch (err) {
        handleError(res, err);
      }
    }),
  );

  router.post(
    "/meetings/:id/cancel",
    wrap(async (req, res) => {
      const body = parseBody(z.object({ scope: z.enum(["one", "series"]).default("one") }), req, res);
      if (!body) return;
      try {
        const updated = await cancelScheduled(String(req.params.id), body.scope);
        res.json(updated.map(toMeetingSummary));
      } catch (err) {
        handleError(res, err);
      }
    }),
  );
});

features.starters.push(async () => startSeriesExtender());
features.stoppers.push(async () => stopSeriesExtender());

// ---------- host-agent ----------

async function agentMeetings(ownerId: string): Promise<AgentMeeting[]> {
  const { rows } = await pool.query(
    `SELECT id, title, scheduled_start, scheduled_end, url, platform, skip_recording, auto_on_off_day, status
     FROM meetings
     WHERE source IN ('ics', 'manual') AND created_by = $1
       AND status IN ('scheduled', 'skipped', 'recording')
       AND scheduled_start BETWEEN now() - interval '5 minutes' AND now() + interval '24 hours'
     ORDER BY scheduled_start`,
    [ownerId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    start: r.scheduled_start.toISOString(),
    end: r.scheduled_end.toISOString(),
    url: r.url,
    platform: r.platform,
    skipRecording: r.skip_recording,
    noAlerts: autoSuppressed(r.scheduled_start, r.auto_on_off_day),
    status: r.status,
  }));
}

async function desiredRecording(ownerId: string): Promise<HeartbeatResponse["recording"]> {
  // Só a gravação do dono desta máquina; se o dono mudar no meio, a captura para.
  const { rows } = await pool.query(
    `SELECT id, title, started_at FROM meetings
     WHERE status = 'recording' AND source IN ('ics', 'manual') AND started_at IS NOT NULL AND created_by = $1
     ORDER BY started_at LIMIT 1`,
    [ownerId],
  );
  return rows[0] ? { meetingId: rows[0].id, title: rows[0].title, startedAt: rows[0].started_at.toISOString() } : null;
}

features.agentRouters.push((app) => {
  const router = express.Router({ caseSensitive: true });
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
  router.use(requireAgent);

  router.post(
    "/heartbeat",
    wrap(async (req: Request, res: Response) => {
      const input = parseBody(HeartbeatInput, req, res);
      if (!input) return;
      recordHeartbeat(input);
      const owner = await hostAgentOwner();
      const body: HeartbeatResponse = {
        now: new Date().toISOString(),
        userDisplayName: owner?.name ?? config.userDisplayName,
        timezone: config.appTimezone,
        alerts: { minutesBefore: [15, 5, 1] },
        meetings: owner ? await agentMeetings(owner.id) : [],
        recording: owner ? await desiredRecording(owner.id) : null,
      };
      res.json(body);
    }),
  );

  router.post(
    "/meetings/:id/skip",
    wrap(async (req: Request, res: Response) => {
      if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) return res.status(404).json({ error: "Não encontrada." });
      const owner = await hostAgentOwner();
      const mine = owner
        ? await pool.query(`SELECT 1 FROM meetings WHERE id = $1 AND created_by = $2`, [req.params.id, owner.id])
        : null;
      if (!mine?.rowCount) return res.status(404).json({ error: "Não encontrada." });
      try {
        await setSkip(String(req.params.id), true);
        res.json({ ok: true });
      } catch (err) {
        handleError(res, err);
      }
    }),
  );

  // Agenda do dia enviada pela Aurora (assistente externo); grava no nome do dono do agente.
  router.post(
    "/calendar/import",
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Muitos envios de agenda. Tente novamente em instantes." },
    }),
    wrap(async (req: Request, res: Response) => {
      const parsed = AgentCalendarImportInput.safeParse(req.body ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        // Só o caminho do campo e contagens: nunca o conteúdo enviado.
        auditImportFailure("invalid_body", req.body, null, { field: first?.path.join(".") || "corpo" });
        return res.status(400).json({ error: first ? `${first.path.join(".") || "corpo"}: ${first.message}` : "Corpo inválido." });
      }
      const input = parsed.data;
      const owner = await hostAgentOwner();
      if (!owner) {
        auditImportFailure("no_owner", input, null);
        return res.status(503).json({ error: "Dono do agente não definido (AGENT_OWNER)." });
      }
      try {
        const result = await importAgentCalendar(input, owner.id);
        // Só metadados: nunca títulos nem participantes.
        audit(
          "agent_calendar_import",
          {
            source: result.source, date: result.date, mode: input.events ? "events" : "ics",
            created: result.created, updated: result.updated, cancelled: result.cancelled,
            removed: result.removed, unchanged: result.unchanged, ignored: result.ignored,
            ...(result.removalSkipped ? { removalSkipped: result.removalSkipped } : {}),
          },
          owner.id,
        );
        res.json(result);
      } catch (err) {
        if (err instanceof CalendarError) auditImportFailure("rejected", input, owner.id, { status: err.status });
        handleError(res, err);
      }
    }),
  );

  router.use((_req: Request, res: Response) => res.status(404).json({ error: "Rota não encontrada." }));
  app.use("/api/agent", router);
});
