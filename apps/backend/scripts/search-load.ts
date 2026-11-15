// Teste de carga da busca (specs/003-busca-chat, T068 / SC-002): 100 mil trechos sintéticos num Postgres
// descartável (imagem com pgvector) e latência da busca híbrida com e sem filtro seletivo.
// Uso: npx tsx scripts/search-load.ts   (a partir de apps/backend; não toca o banco da aplicação)
// Variáveis: LOAD_CHUNKS (padrão 100000), LOAD_MEETINGS (padrão 2000), LOAD_QUERIES (padrão 60).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ensurePostgresImage, PG_TEST_IMAGE } from "./pg-image.mjs";

const DOCKER_BIN = process.env.DOCKER_BIN || "/usr/bin/docker";
const NAME = `meeting-bot-loaddb-${process.pid}`;
const CHUNKS = Number(process.env.LOAD_CHUNKS || 100_000);
const MEETINGS = Number(process.env.LOAD_MEETINGS || 2_000);
const QUERIES = Number(process.env.LOAD_QUERIES || 60);
const SELECTIVE_SHARE = 0.05;

const docker = (args: string[], opts: Record<string, unknown> = {}): string =>
  execFileSync(DOCKER_BIN, ["--context", process.env.DOCKER_CONTEXT || "default", ...args], { encoding: "utf8", ...opts }) as string;

function stop(): void {
  try {
    docker(["rm", "-f", NAME], { stdio: "ignore" });
  } catch {
    // já removido
  }
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw new Error("Postgres de carga não subiu em 40 s");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main(): Promise<void> {
  ensurePostgresImage(docker);
  stop();
  docker([
    "run", "--rm", "-d", "--name", NAME, "-e", "POSTGRES_PASSWORD=teste", "-e", "POSTGRES_USER=teste", "-e", "POSTGRES_DB=carga",
    "-p", "127.0.0.1::5432", "--shm-size=512m", "--tmpfs", "/var/lib/postgresql/data", PG_TEST_IMAGE,
  ]);
  try {
    const port = docker(["port", NAME, "5432/tcp"]).trim().split("\n")[0].split(":").pop();
    const url = `postgres://teste:teste@127.0.0.1:${port}/carga`;
    await waitFor(url);
    process.env.DATABASE_URL = url;
    process.env.AGENT_TOKEN = "carga-".repeat(8);
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "agente-carga-"));
    process.env.LOCAL_ONLY = "true";

    const { pool } = await import("../src/db");
    const { migrate } = await import("../src/schema");
    const { setEmbedder } = await import("../src/search/embedder");
    const { runSearch } = await import("../src/search/service");
    await migrate(pool);

    const owners: string[] = [];
    for (const name of ["carga-grande", "carga-seletivo"]) {
      const { rows } = await pool.query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`, [name]);
      owners.push(rows[0].id);
    }
    const selective = Math.max(1, Math.floor(MEETINGS * SELECTIVE_SHARE));
    // o "seletivo" é dono de 5% das reuniões; o "grande", do resto
    await pool.query(
      `INSERT INTO meetings (title, platform, status, source, created_by, scheduled_start)
       SELECT 'Reunião de carga ' || g, 'none', 'done', 'manual', CASE WHEN g <= $2 THEN $3::uuid ELSE $1::uuid END, now() - (g || ' hours')::interval
         FROM generate_series(1, $4::int) g`,
      [owners[0], selective, owners[1], MEETINGS],
    );
    process.stdout.write(`[carga] inserindo ${CHUNKS} trechos com vetores sintéticos…\n`);
    const started = Date.now();
    await pool.query(`SET maintenance_work_mem = '1GB'`);
    await pool.query(
      `INSERT INTO search_chunks (meeting_id, kind, source_id, seq, content, content_hash, embedding, embed_model, embedded_at)
       SELECT m.id, 'transcript', '', s.n,
              'trecho ' || s.n || ' assunto' || (s.n % 50) || ' decisão sobre integração e certificados do módulo ' || (s.n % 997),
              'h' || s.n, (SELECT array_agg(random()::real) FROM generate_series(1, 1024) WHERE s.n IS NOT NULL)::vector,
              'bge-m3', now()
         FROM meetings m CROSS JOIN LATERAL generate_series(1, $1::int) AS s(n)`,
      [Math.ceil(CHUNKS / MEETINGS)],
    );
    process.stdout.write(`[carga] inseridos em ${((Date.now() - started) / 1000).toFixed(0)} s; reindexando o HNSW e o GIN…\n`);
    await pool.query(`REINDEX INDEX idx_search_chunks_hnsw`);
    await pool.query(`ANALYZE search_chunks`);
    const total = (await pool.query(`SELECT count(*)::int AS n FROM search_chunks`)).rows[0].n;
    const sizes = (await pool.query(
      `SELECT pg_size_pretty(pg_relation_size('idx_search_chunks_hnsw')) AS hnsw, pg_size_pretty(pg_relation_size('search_chunks')) AS tabela`,
    )).rows[0];

    const { rows: sample } = await pool.query(`SELECT embedding::text AS v FROM search_chunks ORDER BY random() LIMIT $1`, [QUERIES]);
    let index = 0;
    setEmbedder({
      model: "bge-m3",
      dim: 1024,
      async embedDocuments() {
        throw new Error("não usado");
      },
      async embedQuery() {
        const vector = JSON.parse(sample[index++ % sample.length].v) as number[];
        return { vectors: [vector], inputTokens: null, computeMs: null };
      },
      async health() {
        return { available: true, reason: null };
      },
    });

    const perms = ["meetings.read", "transcripts.read", "documents.read"] as never;
    const users = {
      "sem filtro (vê 95% das reuniões)": { id: owners[0], username: "carga-grande", roles: [], permissions: perms },
      "seletivo (vê 5% das reuniões)": { id: owners[1], username: "carga-seletivo", roles: [], permissions: perms },
    };
    const report: Record<string, unknown> = { trechos: total, reunioes: MEETINGS, indiceHnsw: sizes.hnsw, tabela: sizes.tabela };
    for (const [label, user] of Object.entries(users)) {
      for (const mode of ["hybrid", "semantic", "text"] as const) {
        const times: number[] = [];
        let hits = 0;
        for (let i = 0; i < QUERIES; i++) {
          const t0 = performance.now();
          const res = await runSearch(user, { q: `assunto${i % 50} certificados integração`, mode, limit: 20, offset: 0 });
          times.push(performance.now() - t0);
          hits += res.hits.length;
        }
        report[`${label} / ${mode}`] = { p50_ms: Math.round(percentile(times, 50)), p95_ms: Math.round(percentile(times, 95)), media_de_hits: +(hits / QUERIES).toFixed(1) };
      }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await pool.end();
  } finally {
    stop();
  }
}

main().catch((err: Error) => {
  stop();
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
