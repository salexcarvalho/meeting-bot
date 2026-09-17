// Testes com Postgres real num container descartável (não toca o banco da aplicação).
// Uso: npm run test:db [-- arquivos de teste]
import { spawnSync, execFileSync } from "node:child_process";

const NAME = "meeting-bot-testdb";
const PORT = process.env.TEST_DB_PORT || "55432";
const docker = (args, opts = {}) =>
  execFileSync("docker", ["--context", process.env.DOCKER_CONTEXT || "default", ...args], { encoding: "utf8", ...opts });

function stop() {
  try {
    docker(["rm", "-f", NAME], { stdio: "ignore" });
  } catch {
    // já removido
  }
}

stop();
docker([
  "run", "--rm", "-d", "--name", NAME,
  "-e", "POSTGRES_PASSWORD=teste", "-e", "POSTGRES_USER=teste", "-e", "POSTGRES_DB=meetingbot_test",
  "-p", `127.0.0.1:${PORT}:5432`,
  "--tmpfs", "/var/lib/postgresql/data",
  "postgres:16-alpine",
]);

let code = 1;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      docker(["exec", NAME, "pg_isready", "-U", "teste", "-d", "meetingbot_test", "-h", "127.0.0.1"], { stdio: "ignore" });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("Postgres de teste não subiu em 30 s");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const url = `postgres://teste:teste@127.0.0.1:${PORT}/meetingbot_test`;
  const files = process.argv.slice(2);
  const result = spawnSync("npx", ["vitest", "run", ...(files.length ? files : ["test/db"])], {
    stdio: "inherit",
    // LLM externo desligado: os testes nunca chamam a rede.
    env: { ...process.env, TEST_DATABASE_URL: url, ALLOW_EXTERNAL_LLM: "false", LLM_GENERATION_PROVIDER: "local" },
  });
  code = result.status ?? 1;
} finally {
  stop();
}
process.exit(code);
