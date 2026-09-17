import type { Router } from "express";
import { AdrPatch, ItemPatch, NewItemInput } from "@meeting-bot/contracts";
import { flushLiveAgent, startLiveAgents, stopLiveAgents } from "../agent/liveAgent";
import { childParamGuard } from "../authz";
import { getMeeting } from "../db";
import { features } from "../features";
import { setBeforeFinalPass, setGlossaryProvider } from "../pipeline";
import { glossaryFor } from "../recording/glossary";
import { parseBody, wrap } from "../routes";
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
        await guard(() => reviewItem(String(req.params.itemId), op, req.user!.id))(res);
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
