import express, { type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
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
import { startSeriesExtender, stopSeriesExtender } from "./seriesExtend";
import {
  CalendarError,
  cancelScheduled,
  createScheduled,
  getAgenda,
  importIcs,
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
    `SELECT id, title, scheduled_start, scheduled_end, url, platform, skip_recording, status
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

  router.use((_req: Request, res: Response) => res.status(404).json({ error: "Rota não encontrada." }));
  app.use("/api/agent", router);
});
