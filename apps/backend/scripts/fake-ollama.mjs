// Serviços de mentira para o E2E do chat (E2E_FAKE_OLLAMA=1): sem rede, sem modelo, determinístico.
// - Ollama (HTTP): só os embeddings da busca, /api/tags e /api/embed.
// - OpenRouter (HTTPS, certificado autoassinado do e2e.mjs): /chat/completions para o chat sobre reuniões.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DIM = 1024;
const NO_ANSWER = "Não encontrei registro sobre isso nas reuniões consultadas.";
const QUOTE_CHARS = 60;

function normalize(text) {
  return text.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase();
}

/** Vetor determinístico: cada palavra (radical de 5 letras) soma 1 em um eixo; depois normaliza (L2). */
export function embed(text) {
  const vector = new Array(DIM).fill(0);
  for (const word of normalize(text).split(/[^a-z0-9]+/)) {
    if (word.length < 3) continue;
    const axis = createHash("sha256").update(word.slice(0, 5)).digest().readUInt16BE(0) % DIM;
    vector[axis] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

/** Resposta do chat: cita o primeiro trecho (quote literal) ou "não encontrei" se a pergunta pedir "zebra". */
export function chatAnswer(userMessage) {
  const question = /^PERGUNTA: (.*)$/m.exec(userMessage)?.[1] ?? "";
  if (normalize(question).includes("zebra")) return { answered: false, answer: NO_ANSWER, citations: [] };
  const lines = userMessage.split("\n");
  const at = lines.findIndex((line) => line.startsWith("[1] "));
  const body = at >= 0 ? (lines[at + 1] ?? "") : "";
  if (!body) return { answered: false, answer: NO_ANSWER, citations: [] };
  return { answered: true, answer: "O trecho consultado traz o que foi combinado [1].", citations: [{ ref: 1, quote: body.slice(0, QUOTE_CHARS) }] };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

export function startFakeOllama(port, models) {
  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url === "/api/tags") return send(200, { models: models.map((name) => ({ name })) });
    const body = await readBody(req);
    if (req.url === "/api/embed") return send(200, { embeddings: (body.input ?? []).map(embed), prompt_eval_count: 8 });
    return send(200, {});
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** OpenRouter de mentira: responde o chat no formato /chat/completions, com a mesma regra de citação. */
export function startFakeOpenRouter(port, tls) {
  const server = https.createServer(tls, async (req, res) => {
    const body = await readBody(req);
    const user = (body.messages ?? []).find((m) => m.role === "user")?.content ?? "";
    const reply = {
      model: body.model ?? "fake",
      choices: [{ message: { role: "assistant", content: JSON.stringify(chatAnswer(user)) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Uso como processo à parte (o e2e.mjs bloqueia o laço de eventos com spawnSync):
// node fake-ollama.mjs <porta do Ollama> <porta do OpenRouter> <chave.pem> <certificado.pem> <modelo...>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, routerPort, keyFile, certFile, ...models] = process.argv.slice(2);
  await startFakeOllama(Number(port), models);
  await startFakeOpenRouter(Number(routerPort), { key: readFileSync(keyFile), cert: readFileSync(certFile) });
}
