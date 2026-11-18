// Analisa as capturas do modo de diagnóstico (BOT_SPEAKER_DIAGNOSTIC=true) e aponta quais elementos mudam
// de estilo/atributo entre as capturas: candidatos a indicador de fala. Só lê a ESTRUTURA salva pelo bot
// (sem texto, nomes, áudio ou vídeo). Uso:
//   node apps/backend/scripts/capture-speaker-dom.mjs <pasta com 0000.json, 0001.json…> [--top 15]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const topIndex = args.indexOf("--top");
const top = topIndex >= 0 ? Number(args[topIndex + 1]) || 15 : 15;

if (!dir) {
  console.error("Uso: node capture-speaker-dom.mjs <pasta> [--top N]");
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (!files.length) {
  console.error(`Nenhuma captura .json em ${dir}`);
  process.exit(1);
}

// chave de um elemento entre capturas: caminho estrutural + ordem entre os de mesmo caminho
const seen = new Map();
for (const [index, file] of files.entries()) {
  const { frames } = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const counters = new Map();
  for (const frame of frames) {
    for (const node of frame.nodes) {
      const n = (counters.get(node.path) ?? 0) + 1;
      counters.set(node.path, n);
      const key = `${node.path}#${n}`;
      const entry = seen.get(key) ?? { key, tag: node.tag, states: new Map(), shots: 0 };
      const state = JSON.stringify({ style: node.style, attrs: node.attrs, size: node.size });
      entry.states.set(state, [...(entry.states.get(state) ?? []), index]);
      entry.shots++;
      seen.set(key, entry);
    }
  }
}

const changing = [...seen.values()]
  .filter((e) => e.states.size > 1 && e.shots >= 3)
  .map((e) => {
    // o estado de repouso é o mais frequente; o resto são os candidatos a "falando"
    const ranked = [...e.states].sort((a, b) => b[1].length - a[1].length);
    return { ...e, rest: ranked[0], others: ranked.slice(1), variability: e.states.size };
  })
  .sort((a, b) => b.others.reduce((s, o) => s + o[1].length, 0) - a.others.reduce((s, o) => s + o[1].length, 0));

console.log(`${files.length} capturas, ${seen.size} elementos, ${changing.length} mudam de estado.\n`);
for (const e of changing.slice(0, top)) {
  const rest = JSON.parse(e.rest[0]);
  console.log(`# ${e.key}  (${e.shots} capturas, ${e.states.size} estados)`);
  for (const [stateText, shots] of e.others.slice(0, 3)) {
    const state = JSON.parse(stateText);
    const diffs = [];
    for (const group of ["style", "attrs"]) {
      for (const name of new Set([...Object.keys(rest[group] ?? {}), ...Object.keys(state[group] ?? {})])) {
        if (rest[group]?.[name] !== state[group]?.[name]) {
          diffs.push(`${group}.${name}: ${JSON.stringify(rest[group]?.[name])} -> ${JSON.stringify(state[group]?.[name])}`);
        }
      }
    }
    console.log(`  capturas ${shots.slice(0, 12).join(",")}${shots.length > 12 ? "…" : ""}: ${diffs.join("; ") || "só o tamanho mudou"}`);
  }
}
console.log(
  "\nCompare os números das capturas com os horários em que cada pessoa falou (anote durante a reunião, 1 captura a cada ~5 s).",
);
