import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { TaskFromItemInput, TaskInput, TaskPatch, TaskQuery, TASK_STATUSES } from "@meeting-bot/contracts";
import { can, requirePermission } from "../authz";
import { pool } from "../db";
import { features } from "../features";
import { parseBody, wrap } from "../routes";
import { createFromItem } from "./fromItem";
import { TaskFilterError } from "./query";
import {
  createManualTask,
  deleteTask,
  getHistory,
  getTask,
  listMeetingTasks,
  listTasks,
  setStatus,
  patchTask,
  taskContext,
  taskSummary,
  TaskError,
  TASK_NOT_FOUND,
} from "./service";

const NOT_FOUND = { error: TASK_NOT_FOUND };
const FORBIDDEN = { error: "Você não tem permissão para esta ação." };
const StatusBody = z.strictObject({ status: z.enum(TASK_STATUSES) });

/**
 * `router.param("taskId")`: antes do handler, id inválido, inexistente ou de outro dono vira 404, nunca 403
 * (não revela existência), inclusive para ADMIN e SUPER_ADMIN. `meetings.read_all` não vale para tarefas.
 * A permissão vem primeiro: sem `tasks.read`/`tasks.manage` a resposta é 403.
 */
function taskParamGuard() {
  return async (req: Request, res: Response, next: NextFunction, value: unknown) => {
    const readOnly = req.method === "GET" || req.method === "HEAD";
    if (!can(req.user, readOnly ? "tasks.read" : "tasks.manage")) return res.status(403).json(FORBIDDEN);
    const id = String(value);
    if (!z.uuid().safeParse(id).success) return res.status(404).json(NOT_FOUND);
    try {
      const { rowCount } = await pool.query(`SELECT 1 FROM tasks t WHERE t.owner_id = $1 AND t.id = $2`, [req.user!.id, id]);
      if (!rowCount) return res.status(404).json(NOT_FOUND);
      next();
    } catch (err) {
      next(err);
    }
  };
}

function queryError(err: unknown, res: Response): boolean {
  if (err instanceof TaskFilterError) {
    res.status(400).json({ error: `Filtro inválido: ${err.message}.` });
    return true;
  }
  return false;
}

async function failTask<T>(res: Response, fn: () => Promise<T>, status: number | ((result: T) => number) = 200): Promise<void> {
  try {
    const result = await fn();
    res.status(typeof status === "function" ? status(result) : status).json(result);
  } catch (err) {
    if (err instanceof TaskError) {
      return void res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...err.extra });
    }
    throw err;
  }
}

function register(router: Router): void {
  router.param("taskId", taskParamGuard());

  router.get(
    "/tasks",
    requirePermission("tasks.read"),
    wrap(async (req, res) => {
      const parsed = TaskQuery.safeParse(req.query);
      if (!parsed.success) {
        const key = parsed.error.issues[0]?.path[0];
        return void res.status(400).json({ error: `Filtro inválido: ${String(key ?? "consulta")}.` });
      }
      try {
        res.json(await listTasks(await taskContext(req.user!), parsed.data));
      } catch (err) {
        if (!queryError(err, res)) throw err;
      }
    }),
  );

  router.get(
    "/tasks/summary",
    requirePermission("tasks.read"),
    wrap(async (req, res) => {
      res.json(await taskSummary(await taskContext(req.user!)));
    }),
  );

  router.post(
    "/tasks/from-item",
    requirePermission("tasks.manage"),
    wrap(async (req, res) => {
      const body = parseBody(TaskFromItemInput, req, res);
      if (!body) return;
      await failTask(
        res,
        async () => createFromItem(await taskContext(req.user!), body),
        (r) => (r.created ? 201 : 200),
      );
    }),
  );

  router.post(
    "/tasks",
    requirePermission("tasks.manage"),
    wrap(async (req, res) => {
      const body = parseBody(TaskInput, req, res);
      if (!body) return;
      await failTask(res, async () => createManualTask(await taskContext(req.user!), body), 201);
    }),
  );

  router.get(
    "/tasks/:taskId",
    wrap(async (req, res) => {
      res.json(await getTask(await taskContext(req.user!), String(req.params.taskId)));
    }),
  );

  router.patch(
    "/tasks/:taskId",
    requirePermission("tasks.manage"),
    wrap(async (req, res) => {
      const body = parseBody(TaskPatch, req, res);
      if (!body) return;
      await failTask(res, async () => patchTask(await taskContext(req.user!), String(req.params.taskId), body));
    }),
  );

  router.post(
    "/tasks/:taskId/status",
    requirePermission("tasks.manage"),
    wrap(async (req, res) => {
      const body = parseBody(StatusBody, req, res);
      if (!body) return;
      await failTask(res, async () => setStatus(await taskContext(req.user!), String(req.params.taskId), body.status));
    }),
  );

  router.delete(
    "/tasks/:taskId",
    requirePermission("tasks.manage"),
    wrap(async (req, res) => {
      await deleteTask(await taskContext(req.user!), String(req.params.taskId));
      res.status(204).end();
    }),
  );

  router.get(
    "/tasks/:taskId/history",
    wrap(async (req, res) => {
      res.json({ history: (await getHistory(await taskContext(req.user!), String(req.params.taskId))) ?? [] });
    }),
  );

  // O guarda de /meetings/:id já exige leitura da reunião (GET) antes deste handler.
  router.get(
    "/meetings/:id/tasks",
    requirePermission("tasks.read"),
    wrap(async (req, res) => {
      res.json({ tasks: await listMeetingTasks(await taskContext(req.user!), String(req.params.id)) });
    }),
  );
}

features.authedRouters.push(register);
