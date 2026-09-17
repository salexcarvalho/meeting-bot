import { createServer } from "http";

// Antes de qualquer outro módulo que possa fazer fetch (Constituição, princípio I).
import { config } from "./config";
import { installEgressGuard } from "./security/egress";
import { audit } from "./security/audit";
const openRouterPath = (suffix: string, url: string) => ({
  host: new URL(url).hostname,
  pathPrefix: `${new URL(url).pathname.replace(/\/+$/, "")}${suffix}`,
});
installEgressGuard({
  allowlist: config.egressAllowlist,
  endpoints: [
    ...(config.externalAsr.allowed ? [openRouterPath("/audio/transcriptions", config.externalAsr.url)] : []),
    ...(config.externalLlm.allowed ? [openRouterPath("/chat/completions", config.externalLlm.url)] : []),
  ],
  onBlocked: (req) => audit("egress_blocked", { ...req }),
});

import { createApp } from "./app";
import { onBotProgress } from "./bot/state";
import { stopAllBots } from "./bot/runner";
import { meetingEvents, pool, purgeExpiredSessions, recoverInterruptedMeetings } from "./db";
import { hub } from "./live/hub";
import { notifyMeeting } from "./live/notify";
import { enqueueProcessing } from "./pipeline";
import { migrate } from "./schema";
import { features, UpgradeHandler } from "./features";
import "./modules";

async function main() {
  await migrate(pool);
  meetingEvents.on("changed", (id: string) => void notifyMeeting(id));
  onBotProgress((meetingId, progress) => hub.publishBoth(meetingId, { type: "bot", meetingId, progress }));
  for (const { id, step } of await recoverInterruptedMeetings()) {
    console.log(`[boot] retomando processamento da reunião ${id} (${step === "analysis" ? "só a análise" : "completo"})`);
    enqueueProcessing(id, step);
  }
  setInterval(() => purgeExpiredSessions().catch(console.error), 3600_000).unref();

  const app = createApp();

  const upgrades: Record<string, UpgradeHandler> = {
    "/api/live": (req, socket, head) => hub.handleUpgrade(req, socket, head),
    ...features.upgrades,
  };

  const server = createServer(app);
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const handler = upgrades[pathname];
    if (!handler) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    Promise.resolve(handler(req, socket, head)).catch((err) => {
      console.error(`[ws] erro no upgrade ${pathname}:`, err);
      socket.destroy();
    });
  });
  hub.start();
  for (const start of features.starters) await start();

  server.listen(config.port, () => {
    console.log(`agente de reuniões ouvindo na porta ${config.port} (LLM: ${config.ollamaModel}, worker: ${config.workerUrl})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} recebido, encerrando`);
    server.close();
    hub.close();
    for (const stop of features.stoppers) await stop().catch(console.error);
    await stopAllBots(20_000);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("falha ao iniciar:", err);
  process.exit(1);
});
