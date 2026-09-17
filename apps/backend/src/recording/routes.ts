import type { Router } from "express";
import { workerHealth } from "../asr/workerClient";
import { requirePermission, visibleMeetingId } from "../authz";
import { getMeeting } from "../db";
import { features } from "../features";
import { getLlm } from "../llm";
import { toMeetingSummary } from "../meetings/summary";
import { queueState } from "../pipeline";
import { wrap } from "../routes";
import { closeAllIngest, handleAudioUpgrade } from "./audioIngest";
import { lastGpu, sampleGpu, startGpuSampler, stopGpuSampler } from "./gpuSampler";
import { hostAgentStatusFor } from "./hostAgentState";
import { activeRecordingId, RecordingError, requestStop, startRecordingNow, startScheduler, stopScheduler } from "./scheduler";

function register(router: Router): void {
  router.post(
    "/meetings/:id/record",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      try {
        await startRecordingNow(id);
      } catch (err) {
        if (!(err instanceof RecordingError)) throw err;
        const conflict = err.extra.conflictMeetingId;
        const conflictMeetingId = await visibleMeetingId(req.user!, typeof conflict === "string" ? conflict : null);
        return res.status(err.status).json({ error: err.message, ...(conflictMeetingId ? { conflictMeetingId } : {}) });
      }
      const meeting = await getMeeting(id);
      res.json(meeting ? toMeetingSummary(meeting) : null);
    }),
  );

  // Parar gravação local (o bot já foi tratado na rota base).
  router.post(
    "/meetings/:id/end",
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (await requestStop(id)) return res.status(202).json({ status: "stopping" });
      const meeting = await getMeeting(id);
      if (!meeting) return res.status(404).json({ error: "Reunião não encontrada." });
      res.status(409).json({ error: "Não há gravação em andamento para esta reunião." });
    }),
  );

  router.get(
    "/system/status",
    requirePermission("meetings.read"),
    wrap(async (req, res) => {
      const user = req.user!;
      const llm = getLlm();
      const queue = queueState();
      const [worker, llmHealth, gpu] = await Promise.all([
        workerHealth(),
        llm.health().catch((err: Error) => ({ ok: false, model: "", error: err.message })),
        lastGpu() ? Promise.resolve(lastGpu()) : sampleGpu(),
      ]);
      res.json({
        hostAgent: await hostAgentStatusFor(user),
        worker: worker
          ? { ok: worker.ok, model: worker.model, diarization: worker.diarization, error: worker.error }
          : { ok: false, model: null, diarization: "unavailable", error: "worker-gpu indisponível" },
        llm: { ok: llmHealth.ok, model: llmHealth.model, error: llmHealth.error ?? null },
        gpu,
        recordingMeetingId: await visibleMeetingId(user, activeRecordingId()),
        queue: { ...queue, current: await visibleMeetingId(user, queue.current) },
      });
    }),
  );
}

features.authedRouters.push(register);
features.upgrades["/api/agent/audio"] = handleAudioUpgrade;
features.starters.push(async () => {
  await startScheduler();
  startGpuSampler();
});
features.stoppers.push(async () => {
  await stopScheduler();
  stopGpuSampler();
  await closeAllIngest();
});
