import type { Router } from "express";
import { AdrPatch, ItemPatch, NewItemInput, type Item, type ItemReviewTask } from "@meeting-bot/contracts";
import { flushLiveAgent, startLiveAgents, stopLiveAgents } from "../agent/liveAgent";
import { can, childParamGuard } from "../authz";
import { getMeeting } from "../db";
import { features } from "../features";
import type { User } from "../types";
import { setBeforeFinalPass, setGlossaryProvider } from "../pipeline";
import { glossaryFor } from "../recording/glossary";
import { parseBody, wrap } from "../routes";
import { createFromApproval } from "../tasks/fromItem";
import { taskContext } from "../tasks/service";
import {
  createManualItem,
  editAdr,
  editItem,
  getHistory,
  ItemError,
  listAdrs,
  listItems,
  reviewAdr,
  reviewItem,
} from "./service";


/**
 * Aprovar uma pendência cria a tarefa de quem aprovou (specs/002). Roda depois do commit da revisão e nunca a
 * desfaz: falha da tarefa é registrada e vira `task: null` (o usuário ainda tem "Virar tarefa").
 */
async function approvedWithTask(item: Item, user: User): Promise<Item | (Item & ItemReviewTask)> {
  if (!can(user, "tasks.manage")) return item;
  try {
    const { task, notice } = await createFromApproval(await taskContext(user), item.id);
    return { ...item, task, ...(notice ? { taskNotice: notice } : {}) };
  } catch (err) {
    console.error("[tasks] falha ao criar a tarefa da aprovação:", err instanceof Error ? err.message : err);
    return { ...item, task: null };
  }
}

function register(router: Router): void {
  router.param("itemId", childParamGuard());

  const guard =
    <T>(fn: () => Promise<T>) =>
    async (res: import("express").Response, status = 200) => {
      try {
        const result = await fn();
        res.status(status).json(result);
      } catch (err) {
        if (err instanceof ItemError) return void res.status(err.status).json({ error: err.message });
        throw err;
      }
    };

  router.get(
    "/meetings/:id/items",
    wrap(async (req, res) => {
      const meeting = await getMeeting(String(req.params.id));
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      res.json({ items: await listItems(meeting.id) });
    }),
  );

  router.post(
    "/meetings/:id/items",
    wrap(async (req, res) => {
      const body = parseBody(NewItemInput, req, res);
      if (!body) return;
      await guard(() => createManualItem(String(req.params.id), body, req.user!.id))(res, 201);
    }),
  );

  router.get(
    "/meetings/:id/adrs",
    wrap(async (req, res) => {
      const meeting = await getMeeting(String(req.params.id));
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      res.json({ adrs: await listAdrs(meeting.id) });
    }),
  );

  router.patch(
    "/items/:itemId",
    wrap(async (req, res) => {
      const body = parseBody(ItemPatch, req, res);
      if (!body) return;
      await guard(() => editItem(String(req.params.itemId), body, req.user!.id))(res);
    }),
  );

  for (const op of ["approve", "reject", "reopen"] as const) {
    router.post(
      `/items/:itemId/${op}`,
      wrap(async (req, res) => {
        await guard(async () => {
          const item = await reviewItem(String(req.params.itemId), op, req.user!.id);
          return op === "approve" ? approvedWithTask(item, req.user!) : item;
        })(res);
      }),
    );
  }

  router.get(
    "/items/:itemId/history",
    wrap(async (req, res) => {
      const history = await getHistory(String(req.params.itemId));
      if (!history) return res.status(404).json({ error: "Item não encontrado." });
      res.json({ history });
    }),
  );

  router.patch(
    "/adrs/:itemId",
    wrap(async (req, res) => {
      const body = parseBody(AdrPatch, req, res);
      if (!body) return;
      await guard(() => editAdr(String(req.params.itemId), body, req.user!.id))(res);
    }),
  );

  for (const op of ["approve", "reject"] as const) {
    router.post(
      `/adrs/:itemId/${op}`,
      wrap(async (req, res) => {
        await guard(() => reviewAdr(String(req.params.itemId), op, req.user!.id))(res);
      }),
    );
  }
}

features.authedRouters.push(register);
setBeforeFinalPass(flushLiveAgent);
setGlossaryProvider(glossaryFor);
features.starters.push(() => startLiveAgents());
features.stoppers.push(async () => stopLiveAgents());
