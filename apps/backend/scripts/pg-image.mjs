// Imagem do Postgres dos testes: a mesma do compose (postgres:16-alpine + pgvector, docker/postgres).
// Construída uma vez; as execuções seguintes reaproveitam o cache local.
import { existsSync } from "node:fs";
import path from "node:path";

export const PG_TEST_IMAGE = "meeting-bot-postgres:16-pgvector";
const CONTEXT_DIR = path.resolve(import.meta.dirname, "../../../docker/postgres");

/** Constrói a imagem se ela ainda não existir neste Docker. `docker` é o helper de cada script. */
export function ensurePostgresImage(docker) {
  try {
    docker(["image", "inspect", PG_TEST_IMAGE], { stdio: "ignore" });
    return;
  } catch {
    // ainda não construída
  }
  if (!existsSync(path.join(CONTEXT_DIR, "Dockerfile"))) throw new Error(`Dockerfile do Postgres ausente em ${CONTEXT_DIR}`);
  process.stdout.write(`[testes] construindo ${PG_TEST_IMAGE} (uma vez)…\n`);
  docker(["build", "-t", PG_TEST_IMAGE, CONTEXT_DIR], { stdio: "inherit" });
}
