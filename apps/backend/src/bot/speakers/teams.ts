import { ARIA_NAME, ICON_STYLE, MIN_REST_OBSERVATIONS, probeConfig, RING_STYLE, type ProbeConfig, type ProbeLayer } from "./probe";

// Seletores do Teams (convidado e conta logada) para ler quem está falando (spec 006). São hipóteses
// do plano (R1): nada foi confirmado numa reunião real ainda (T001/T060/T061). Os `data-tid` do Teams
// mudam sem aviso; o leitor tenta todas as camadas e perfis até achar quadros com nome (a tela real é a
// verdade), e o perfil só decide a ordem. Para recalibrar: BOT_SPEAKER_DIAGNOSTIC + docs/ARCHITECTURE.md.

export type TeamsProfile = "guest" | "account";

const VOICE_STYLE = [...RING_STYLE, "outline-color", "border-color", "opacity"];

const NAME_FROM = [
  ARIA_NAME,
  { sel: "[data-tid='display-name'], [data-tid*='participant-name']", text: true },
  { shortest: true },
];

// Quadro de vídeo/participante no palco da tela leve de convidado.
const guestSemantic: ProbeLayer = {
  name: "semantic",
  tile: "[data-tid='video-stream-container'], [data-tid*='participant-tile'], [data-stream-type]",
  nameFrom: NAME_FROM,
  indicators: [
    { mode: "style", sel: "[data-tid='voice-level-stream-outline']", props: VOICE_STYLE, minObservations: MIN_REST_OBSERVATIONS },
  ],
};

// Palco do app completo (conta logada): quadros "calling-participant" com o mesmo contorno de voz.
const accountSemantic: ProbeLayer = {
  name: "semantic",
  tile: "[data-tid*='calling-participant'], [data-tid='participant-stream'], [data-tid*='video-stream']",
  nameFrom: NAME_FROM,
  indicators: [
    { mode: "style", sel: "[data-tid='voice-level-stream-outline']", props: VOICE_STYLE, minObservations: MIN_REST_OBSERVATIONS },
    { mode: "attr", attr: "aria-label", match: "\\bspeaking\\b|\\bfalando\\b" },
  ],
};

const structural: ProbeLayer = {
  name: "structural",
  tile: "[role='group'], [role='listitem'], figure, [aria-label]",
  requires: "video, canvas, img",
  nameFrom: [ARIA_NAME, { shortest: true }],
  indicators: [{ mode: "style", props: RING_STYLE, minObservations: MIN_REST_OBSERVATIONS }],
};

// Painel de pessoas: só se já estiver aberto pelo usuário (a v1 nunca abre painéis).
const panel: ProbeLayer = {
  name: "panel",
  tile: "[role='menuitem'], [role='list'] [role='listitem']",
  nameFrom: [ARIA_NAME, { shortest: true }],
  indicators: [
    { mode: "style", sel: "svg, [data-tid*='mic']", props: ICON_STYLE, minObservations: MIN_REST_OBSERVATIONS },
  ],
};

export function teamsProbe(profile: TeamsProfile): ProbeConfig {
  const semantics = profile === "account" ? [accountSemantic, guestSemantic] : [guestSemantic, accountSemantic];
  return probeConfig([...semantics, structural, panel]);
}
