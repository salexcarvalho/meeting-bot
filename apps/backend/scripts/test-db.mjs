// Testes com Postgres real num container descartável (não toca o banco da aplicação).
// Uso: npm run test:db [-- arquivos de teste]
import { spawnSync, execFileSync } from "node:child_process";
import pg from "pg";
import { ensurePostgresImage, PG_TEST_IMAGE } from "./pg-image.mjs";

// Nome próprio por execução: duas execuções ao mesmo tempo (worktrees, agentes) não derrubam o banco uma da outra.
const NAME = `meeting-bot-testdb-${process.pid}`;
const docker = (args, opts = {}) =>
  execFileSync("docker", ["--context", process.env.DOCKER_CONTEXT || "default", ...args], { encoding: "utf8", ...opts });

function stop() {
  try {
    docker(["rm", "-f", NAME], { stdio: "ignore" });
  } catch {
    // já removido
  }
}

// A porta de host é sorteada pelo Docker (TEST_DB_PORT fixa uma, se for preciso).
const publish = process.env.TEST_DB_PORT ? `127.0.0.1:${process.env.TEST_DB_PORT}:5432` : "127.0.0.1::5432";

// Pronto = aceita conexão TCP pela porta publicada, o caminho que os testes usam. pg_isready dentro do
// container responde antes de a porta do host estar de pé (e durante a reinicialização do initdb).
async function accepts(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.end();
    } catch {
      // conexão que nem abriu não precisa fechar
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(1);
  });
}

let code = 1;
try {
  ensurePostgresImage(docker);
  docker([
    "run", "--rm", "-d", "--name", NAME,
    "-e", "POSTGRES_PASSWORD=teste", "-e", "POSTGRES_USER=teste", "-e", "POSTGRES_DB=meetingbot_test",
    "-p", publish,
    "--tmpfs", "/var/lib/postgresql/data",
    PG_TEST_IMAGE,
  ]);
  const port = docker(["port", NAME, "5432/tcp"]).trim().split("\n")[0].split(":").pop();
  const url = `postgres://teste:teste@127.0.0.1:${port}/meetingbot_test`;
  const deadline = Date.now() + 30_000;
  while (!(await accepts(url))) {
    if (Date.now() > deadline) throw new Error("Postgres de teste não subiu em 30 s");
    await new Promise((r) => setTimeout(r, 500));
  }
  const files = process.argv.slice(2);
  const result = spawnSync("npx", ["vitest", "run", ...(files.length ? files : ["test/db"])], {
    stdio: "inherit",
    // LLM externo desligado: os testes nunca chamam a rede. Assistente automático só no teste dele.
    env: {
      ...process.env,
      TEST_DATABASE_URL: url,
      ALLOW_EXTERNAL_LLM: "false",
      LLM_GENERATION_PROVIDER: "local",
      AUTO_ASSISTANT: "false",
    },
  });
  code = result.status ?? 1;
} finally {
  stop();
}
process.exit(code);
