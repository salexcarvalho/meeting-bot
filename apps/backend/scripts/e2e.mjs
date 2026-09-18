// E2E de ponta a ponta: Postgres descartável + backend real (tsx) + frontend buildado + Playwright.
// Uso: npm run test:e2e [-- args do playwright]
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const NAME = "meeting-bot-e2edb";
const DB_PORT = process.env.E2E_DB_PORT || "55434";
const APP_PORT = process.env.E2E_PORT || "3310";
const root = path.resolve(import.meta.dirname, "..");
const docker = (args, opts = {}) =>
  execFileSync("docker", ["--context", process.env.DOCKER_CONTEXT || "default", ...args], { encoding: "utf8", ...opts });
const stopDb = () => {
  try {
    docker(["rm", "-f", NAME], { stdio: "ignore" });
  } catch {
    // já removido
  }
};

const work = mkdtempSync(path.join(tmpdir(), "agente-e2e-"));
// pactl falso: o bot falha na hora em vez de criar sinks e abrir Chromium no desktop.
const fakeBin = path.join(work, "bin");
mkdirSync(fakeBin);
writeFileSync(path.join(fakeBin, "pactl"), "#!/bin/sh\necho 'pactl indisponível no E2E' >&2\nexit 1\n");
chmodSync(path.join(fakeBin, "pactl"), 0o755);

const env = {
  ...process.env,
  DATABASE_URL: `postgres://teste:teste@127.0.0.1:${DB_PORT}/agente_e2e`,
  AGENT_TOKEN: "e2e-".repeat(10),
  DATA_DIR: path.join(work, "data"),
  PUBLIC_DIR: path.resolve(root, "../frontend/dist"),
  PORT: APP_PORT,
  WORKER_URL: "http://127.0.0.1:9",
  OLLAMA_URL: "http://127.0.0.1:9",
  LOCAL_ONLY: "true",
  ALLOW_EXTERNAL_ASR: "false",
  ASR_PROVIDER: "local",
  AGENT_OWNER: "",
  // OpenRouter ligado só para a opção aparecer; a URL aponta para uma porta fechada local.
  ALLOW_EXTERNAL_LLM: "true",
  // sem Chromium de bot no E2E: o assistente não entra sozinho
  AUTO_ASSISTANT: "false",
  LLM_GENERATION_PROVIDER: "local",
  OPENROUTER_API_KEY: `e2e-${randomUUID()}`,
  OPENROUTER_URL: "https://127.0.0.1:9/api/v1",
  // Assinatura ligada: a Ana não é dona do host-agent, então a opção aparece desabilitada.
  CLAUDE_CLI_ENABLED: "true",
  PATH: `${fakeBin}:${process.env.PATH}`,
};

// O frontend servido é o dist: sem rebuildar, o E2E testaria a tela antiga.
console.log("[e2e] buildando o frontend…");
execFileSync("npm", ["run", "build", "-w", "@meeting-bot/frontend"], { cwd: path.resolve(root, "../.."), stdio: "inherit" });

stopDb();
docker([
  "run", "--rm", "-d", "--name", NAME,
  "-e", "POSTGRES_PASSWORD=teste", "-e", "POSTGRES_USER=teste", "-e", "POSTGRES_DB=agente_e2e",
  "-p", `127.0.0.1:${DB_PORT}:5432`, "--tmpfs", "/var/lib/postgresql/data", "postgres:16-alpine",
]);

let server = null;
let code = 1;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      docker(["exec", NAME, "pg_isready", "-U", "teste", "-d", "agente_e2e", "-h", "127.0.0.1"], { stdio: "ignore" });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("Postgres do E2E não subiu em 30 s");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const seed = spawnSync("npx", ["tsx", "src/cli/user.ts", "create", "e2e-admin", "--role=SUPER_ADMIN"], {
    cwd: root,
    env: { ...env, PASSWORD: "senha-e2e-admin" },
    encoding: "utf8",
  });
  if (seed.status !== 0) throw new Error(`seed falhou: ${seed.stderr}`);

  server = spawn("npx", ["tsx", "src/index.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  const keep = (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 400) logs.shift();
  };
  server.stdout.on("data", keep);
  server.stderr.on("data", keep);

  const base = `http://127.0.0.1:${APP_PORT}`;
  const ready = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // ainda subindo
    }
    if (server.exitCode !== null || Date.now() > ready) {
      throw new Error(`backend não subiu:\n${logs.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const result = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, E2E_BASE_URL: base, E2E_OUTPUT_DIR: path.join(work, "results"), E2E_DATABASE_URL: env.DATABASE_URL },
  });
  code = result.status ?? 1;
  if (code !== 0) console.log(`\n--- log do backend (fim) ---\n${logs.join("").slice(-6000)}`);
  else console.log(`\nbackend: ${logs.join("").split("\n").filter((l) => l.includes("[bot ")).slice(-8).join("\n")}`);
} finally {
  server?.kill("SIGTERM");
  stopDb();
  if (code === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`artefatos do E2E em ${work}`);
}
process.exit(code);
