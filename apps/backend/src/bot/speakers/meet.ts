import { ARIA_NAME, ICON_STYLE, MIN_REST_OBSERVATIONS, probeConfig, RING_STYLE, type ProbeConfig, type ProbeLayer } from "./probe";

// Seletores do Meet para ler quem está falando (spec 006). São hipóteses vindas do plano (R1): nada
// foi confirmado numa reunião real ainda (T001/T062). Classes CSS do Meet são ofuscadas e mudam sem
// aviso, então nenhuma é usada. Quando parar de achar os participantes: ligue BOT_SPEAKER_DIAGNOSTIC,
// rode uma reunião, veja como usar em docs/ARCHITECTURE.md (nomes dos falantes) e ajuste só este arquivo.

// Camada 1 (semântica): quadro `[data-participant-id]` (id estável por dispositivo) com o nome em `data-self-name`.
const semantic: ProbeLayer = {
  name: "semantic",
  tile: "[data-participant-id]",
  idAttr: "data-participant-id",
  nameFrom: [
    { sel: "[data-self-name]", attr: "data-self-name" },
    { self: true, attr: "data-self-name" },
    ARIA_NAME,
    { shortest: true },
  ],
  indicators: [
    // 1) atributo de estado de fala no quadro ou no indicador de áudio (se o Meet expuser um)
    { mode: "attr", sel: "[data-audio-level], [data-is-speaking]", attr: "data-is-speaking", match: "^true$" },
    // 2) indicador de áudio animado (barras/anel): muda o estilo em relação ao repouso
    { mode: "style", sel: "[data-audio-indicator], [aria-hidden='true'][jsname]", props: RING_STYLE, minObservations: MIN_REST_OBSERVATIONS },
    // 3) o quadro inteiro ganha anel/contorno
    { mode: "style", props: RING_STYLE, minObservations: MIN_REST_OBSERVATIONS },
  ],
};

// Camada 2 (estrutural): qualquer grupo com vídeo ou avatar e um texto curto; o indicador é o estilo do próprio quadro.
const structural: ProbeLayer = {
  name: "structural",
  tile: "[role='group'], [role='listitem'], figure, [aria-label]",
  requires: "video, canvas, img",
  nameFrom: [ARIA_NAME, { shortest: true }],
  indicators: [{ mode: "style", props: RING_STYLE, minObservations: MIN_REST_OBSERVATIONS }],
};

// Camada 3 (painel): lista de pessoas, só se já estiver aberta pelo usuário (a v1 nunca abre painéis).
const panel: ProbeLayer = {
  name: "panel",
  tile: "[role='list'] [role='listitem']",
  nameFrom: [ARIA_NAME, { shortest: true }],
  indicators: [
    { mode: "style", sel: "svg, [data-icon]", props: ICON_STYLE, minObservations: MIN_REST_OBSERVATIONS },
  ],
};

export function meetProbe(): ProbeConfig {
  return probeConfig([semantic, structural, panel]);
}
