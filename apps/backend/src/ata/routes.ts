import type { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { emitMeetingChanged, getMeeting } from "../db";
import { features } from "../features";
import { listAdrs, listItems } from "../items/service";
import { hub } from "../live/hub";
import { toMeetingSummary } from "../meetings/summary";
import { parseBody, wrap } from "../routes";
import { getSegments, getSpeakers, renameSpeaker, speakerNameResolver } from "../repo/transcripts";
import { renderAta, renderResumo, type AtaAnalysis, type AtaInput } from "./render";

const SpeakerRename = z.object({ displayName: z.string().trim().min(1, "Informe o nome.").max(80) });

async function buildAta(meetingId: string) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return null;
  const [items, adrs, speakers, segments] = await Promise.all([
    listItems(meetingId),
    listAdrs(meetingId),
    getSpeakers(meetingId),
    getSegments(meetingId),
  ]);
  const nameOf = speakerNameResolver(speakers);
  const labels = [...new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)))];
  const analysis = (meeting.analysis as AtaAnalysis | null) ?? null;
  const input: AtaInput = {
    meeting: toMeetingSummary(meeting),
    timezone: config.appTimezone,
    items,
    adrs,
    speakers: labels.map((l) => nameOf(l) ?? l),
    analysis,
    legacyAta: meeting.ata_markdown,
  };
  return { meeting, markdown: renderAta(input), analysis, input };
}

function fileName(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return `ata-${slug || "reuniao"}.md`;
}

function register(router: Router): void {
  router.get(
    "/meetings/:id/ata",
    wrap(async (req, res) => {
      const ata = await buildAta(String(req.params.id));
      if (!ata) return res.status(404).json({ error: "Reunião não encontrada." });
      const ready = Boolean(ata.analysis) || Boolean(ata.meeting.ata_markdown);
      res.json({
        markdown: ready ? ata.markdown : null,
        generatedAt: ata.meeting.analyzed_at?.toISOString() ?? null,
        hasAnalysis: Boolean(ata.analysis),
      });
    }),
  );

  // Resumo curto para enviar ao pessoal (só itens aprovados).
  router.get(
    "/meetings/:id/resumo",
    wrap(async (req, res) => {
      const ata = await buildAta(String(req.params.id));
      if (!ata) return res.status(404).json({ error: "Reunião não encontrada." });
      res.set("Cache-Control", "no-store");
      res.json(renderResumo(ata.input));
    }),
  );

  router.get(
    "/meetings/:id/ata.md",
    wrap(async (req, res) => {
      const ata = await buildAta(String(req.params.id));
      if (!ata) return res.status(404).json({ error: "Reunião não encontrada." });
      res.set("Content-Type", "text/markdown; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="${fileName(ata.meeting.title)}"`);
      res.set("Cache-Control", "no-store");
      res.send(`${ata.markdown}\n`);
    }),
  );

  router.patch(
    "/meetings/:id/speakers/:label",
    wrap(async (req, res) => {
      const body = parseBody(SpeakerRename, req, res);
      if (!body) return;
      const meetingId = String(req.params.id);
      const speaker = await renameSpeaker(meetingId, String(req.params.label), body.displayName);
      if (!speaker) return res.status(404).json({ error: "Falante não encontrado nesta reunião." });
      emitMeetingChanged(meetingId);
      hub.publishToMeeting(meetingId, { type: "transcript_replaced", meetingId });
      res.json({ label: speaker.label, displayName: speaker.displayName });
    }),
  );
}

features.authedRouters.push(register);
