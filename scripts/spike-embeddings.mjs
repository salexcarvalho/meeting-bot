// Spike de adoção dos embeddings (specs/003-busca-chat, T006 / Princípio V): mede cada modelo em CPU (`num_gpu: 0`).
// Não baixa nada: os modelos precisam estar no Ollama (`ollama pull bge-m3`, feito pelo dono). Mede tempo por lote de 16,
// 1 h de reunião (~80 trechos), norma dos vetores e VRAM antes/depois (nvidia-smi). Imprime a tabela em Markdown para
// colar em docs/analise/agente-local.md §15.
// Uso: OLLAMA_URL=http://127.0.0.1:11434 node scripts/spike-embeddings.mjs [modelo ...]   (padrão: bge-m3)
import { execFileSync } from "node:child_process";

const URL_BASE = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODELS = process.argv.length > 2 ? process.argv.slice(2) : ["bge-m3"];
const CHUNKS = 80;
const BATCH = 16;
const WORDS = ["decisão", "contrato", "fornecedor", "integração", "certificado", "prazo", "entrega", "migração", "backup", "login"];

function sampleChunk(n) {
  const words = [];
  for (let i = 0; i < 180; i++) words.push(WORDS[(n * 7 + i * 3) % WORDS.length]);
  return `Trecho ${n}: ${words.join(" ")}.`;
}

function vramMiB() {
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8" });
    return Number(out.trim().split("\n")[0]);
  } catch {
    return null;
  }
}

async function embed(model, input) {
  const res = await fetch(`${URL_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, truncate: true, keep_alive: "10m", options: { num_gpu: 0 } }),
  });
  if (!res.ok) throw new Error(`${model}: Ollama respondeu ${res.status} (o modelo foi baixado?)`);
  return (await res.json()).embeddings;
}

const rows = [];
for (const model of MODELS) {
  const before = vramMiB();
  const texts = Array.from({ length: CHUNKS }, (_, n) => sampleChunk(n));
  await embed(model, [texts[0]]); // carrega o modelo fora da medição
  const batchMs = [];
  const started = Date.now();
  let norm = 0;
  let dim = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const t0 = Date.now();
    const vectors = await embed(model, texts.slice(i, i + BATCH));
    batchMs.push(Date.now() - t0);
    dim = vectors[0].length;
    norm = Math.hypot(...vectors[0]);
  }
  const after = vramMiB();
  rows.push({
    model,
    dim,
    batch16: `${Math.round(batchMs.reduce((a, b) => a + b, 0) / batchMs.length)} ms`,
    total: `${((Date.now() - started) / 1000).toFixed(1)} s para ${CHUNKS} trechos`,
    norm: norm.toFixed(3),
    vram: before === null || after === null ? "n/d" : `${after - before} MiB`,
  });
}

process.stdout.write("| Modelo | Dim | Lote de 16 | 1 h de reunião | Norma | VRAM (depois - antes) |\n|---|---|---|---|---|---|\n");
for (const r of rows) process.stdout.write(`| ${r.model} | ${r.dim} | ${r.batch16} | ${r.total} | ${r.norm} | ${r.vram} |\n`);
