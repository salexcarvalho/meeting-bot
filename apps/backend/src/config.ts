import path from "path";
import { recorderName } from "./bot/identity";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`variável de ambiente ${name} não definida`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} precisa ser número inteiro`);
  return n;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function agentToken(): string {
  const token = required("AGENT_TOKEN");
  if (token.length < 32) throw new Error("AGENT_TOKEN precisa ter ao menos 32 caracteres (openssl rand -hex 32)");
  return token;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "sim"].includes(raw.trim().toLowerCase());
}

export type AsrProvider = "local" | "openrouter";

// ASR externo de teste (Constituição 1.1.0, princípio I): só com ALLOW_EXTERNAL_ASR=true.
function externalAsr() {
  const allowed = bool("ALLOW_EXTERNAL_ASR", false);
  const url = (process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  if (allowed && !url.startsWith("https://")) throw new Error("OPENROUTER_URL precisa ser https");
  return {
    allowed,
    url,
    apiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
    model: process.env.OPENROUTER_STT_MODEL || "deepgram/nova-3",
  };
}

function asrProvider(allowed: boolean): AsrProvider {
  const raw = (process.env.ASR_PROVIDER || "local").trim().toLowerCase();
  if (raw === "local") return "local";
  if (raw !== "openrouter") throw new Error(`ASR_PROVIDER inválido: ${raw} (use local ou openrouter)`);
  if (!allowed) {
    throw new Error("ASR_PROVIDER=openrouter exige ALLOW_EXTERNAL_ASR=true (o áudio sai da máquina).");
  }
  return "openrouter";
}

const external = externalAsr();

export type GenerationProvider = "local" | "openrouter" | "claude" | "codex";

// LLM externo opcional (Constituição 1.3.0, princípio I): só com ALLOW_EXTERNAL_LLM=true.
// Usa o mesmo OpenRouter (URL e chave) do ASR externo.
function externalLlm() {
  const allowed = bool("ALLOW_EXTERNAL_LLM", false);
  if (allowed && !external.url.startsWith("https://")) throw new Error("OPENROUTER_URL precisa ser https");
  return {
    allowed,
    url: external.url,
    apiKey: external.apiKey,
    model: (process.env.OPENROUTER_LLM_MODEL || "anthropic/claude-sonnet-5").trim(),
    timeoutMs: int("OPENROUTER_LLM_TIMEOUT_SECONDS", 180) * 1000,
    // modelos que raciocinam (ex.: DeepSeek) gastam parte disso antes da resposta
    maxTokens: int("OPENROUTER_LLM_MAX_TOKENS", 32000),
  };
}

// Assinaturas pessoais (Constituição 1.4.0): o host-agent executa o CLI oficial (claude/codex)
// com o login do dono da máquina. Também exige ALLOW_EXTERNAL_LLM=true.
function subscriptionLlm(allowed: boolean) {
  const claude = bool("CLAUDE_CLI_ENABLED", false);
  const codex = bool("CODEX_CLI_ENABLED", false);
  if ((claude || codex) && !allowed) {
    throw new Error("CLAUDE_CLI_ENABLED/CODEX_CLI_ENABLED exigem ALLOW_EXTERNAL_LLM=true (a transcrição sai da máquina).");
  }
  const model = (name: string, fallback: string) => {
    const raw = (process.env[name] ?? fallback).trim();
    if (raw && !/^[\w.:/-]{1,80}$/.test(raw)) throw new Error(`${name} inválido: use só letras, números e . : / - _`);
    return raw;
  };
  return {
    claude: { enabled: claude, model: model("CLAUDE_CLI_MODEL", "sonnet") },
    codex: { enabled: codex, model: model("CODEX_CLI_MODEL", "") },
    timeoutSeconds: int("SUBSCRIPTION_LLM_TIMEOUT_SECONDS", 600),
  };
}

function generationProvider(
  allowed: boolean,
  subscriptions: ReturnType<typeof subscriptionLlm>,
): GenerationProvider {
  const raw = (process.env.LLM_GENERATION_PROVIDER || "local").trim().toLowerCase();
  if (raw === "local") return "local";
  if (raw !== "openrouter" && raw !== "claude" && raw !== "codex") {
    throw new Error(`LLM_GENERATION_PROVIDER inválido: ${raw} (use local, openrouter, claude ou codex)`);
  }
  if (!allowed) {
    throw new Error(`LLM_GENERATION_PROVIDER=${raw} exige ALLOW_EXTERNAL_LLM=true (a transcrição sai da máquina).`);
  }
  if (raw !== "openrouter" && !subscriptions[raw].enabled) {
    throw new Error(`LLM_GENERATION_PROVIDER=${raw} exige ${raw.toUpperCase()}_CLI_ENABLED=true.`);
  }
  return raw;
}

const llmExternal = externalLlm();
const llmSubscriptions = subscriptionLlm(llmExternal.allowed);

function localOnly(): boolean {
  const raw = (process.env.LOCAL_ONLY ?? "true").toLowerCase();
  if (raw !== "true") {
    // Constituição, princípio I: LOCAL_ONLY=true é o único modo suportado.
    throw new Error("LOCAL_ONLY=false não é suportado: este projeto só usa modelos locais.");
  }
  return true;
}

export const config = {
  port: int("PORT", 3000),
  databaseUrl: required("DATABASE_URL"),
  dataDir: path.resolve(process.env.DATA_DIR || "/data"),
  publicDir: path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, "..", "public")),
  trustProxy: process.env.TRUST_PROXY || "",
  maxConcurrentBots: int("MAX_CONCURRENT_BOTS", 2),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  sessionTtlHours: int("SESSION_TTL_HOURS", 24 * 7),
  appTimezone: process.env.APP_TIMEZONE || "America/Sao_Paulo",
  userDisplayName: process.env.USER_DISPLAY_NAME || "Sérgio",

  // Modo Agente (bot convidado)
  /** nome usado só quando o dono da reunião não existe mais */
  botDisplayName: recorderName(process.env.BOT_DISPLAY_NAME || "Ata Bot"),
  /**
   * Câmera virtual com o ícone do agente (imagem parada). Desligada por padrão: no Teams a
   * câmera vira um quadro de vídeo, que parece apresentação (decisão do usuário em 2026-09-17).
   */
  botCamera: bool("BOT_CAMERA", false),
  /** transcrição ao vivo do áudio que o assistente grava na chamada */
  botLiveTranscription: bool("BOT_LIVE_TRANSCRIPTION", true),
  /** silêncio que faz o assistente sair de uma reunião sem horário previsto */
  botSilenceStopMs: int("BOT_SILENCE_STOP_MINUTES", 10) * 60_000,
  defaultAgentName: (process.env.DEFAULT_AGENT_NAME || "Assistente").trim().slice(0, 40),
  botJoinTimeoutMs: int("BOT_JOIN_TIMEOUT_SECONDS", 45) * 1000,
  fakeMicFile: process.env.FAKE_MIC_FILE || "/app/assets/silence.wav",
  admissionTimeoutMs: int("ADMISSION_TIMEOUT_MINUTES", 10) * 60_000,
  maxMeetingMs: int("MAX_MEETING_MINUTES", 240) * 60_000,
  aloneTimeoutMs: int("ALONE_TIMEOUT_MINUTES", 5) * 60_000,
  /** reuniões da agenda com link do Teams/Meet: o assistente entra sozinho no horário */
  autoAssistant: bool("AUTO_ASSISTANT", true),
  /** o PC grava sozinho no horário (desligado: grava só quem está na chamada, o assistente) */
  autoLocalRecording: bool("AUTO_LOCAL_RECORDING", false),
  maxUploadMb: int("MAX_UPLOAD_MB", 500),

  // Privacidade
  localOnly: localOnly(),
  egressAllowlist: list("EGRESS_ALLOWLIST", ["ollama", "worker-gpu", "localhost", "127.0.0.1"]),

  // host-agent: a máquina grava só as reuniões deste usuário (vazio = SUPER_ADMIN mais antigo)
  agentToken: agentToken(),
  agentOwner: (process.env.AGENT_OWNER || "").trim().toLowerCase(),

  // Perfis: fotos e voz do agente
  maxAvatarBytes: int("MAX_AVATAR_KB", 2048) * 1024,
  maxVoiceBytes: int("MAX_VOICE_KB", 4096) * 1024,
  maxVoiceSeconds: int("MAX_VOICE_SECONDS", 60),

  // Transcrição
  workerUrl: (process.env.WORKER_URL || "http://worker-gpu:8000").replace(/\/+$/, ""),
  transcriptionLanguage: process.env.TRANSCRIPTION_LANGUAGE || "pt",
  asrProvider: asrProvider(external.allowed),
  externalAsr: external,

  // LLM local
  llmProvider: (process.env.LLM_PROVIDER || "ollama").toLowerCase(),
  ollamaUrl: (process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/+$/, ""),
  ollamaModel: process.env.OLLAMA_MODEL || "qwen3.5:4b",
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || "30m",
  // Gerações pós-reunião e sob demanda: local ou OpenRouter (ao vivo é sempre local)
  generationProvider: generationProvider(llmExternal.allowed, llmSubscriptions),
  /** geração automática com assinatura: quanto esperar o host-agent/CLI voltar antes de desistir */
  subscriptionWaitMs: int("SUBSCRIPTION_WAIT_MINUTES", 30) * 60_000,
  externalLlm: llmExternal,
  subscriptionLlm: llmSubscriptions,
  liveExtractMinSpeechSeconds: int("LIVE_EXTRACT_MIN_SPEECH_SECONDS", 90),
  liveExtractMaxIntervalSeconds: int("LIVE_EXTRACT_MAX_INTERVAL_SECONDS", 180),
  liveConsolidateIntervalSeconds: int("LIVE_CONSOLIDATE_INTERVAL_SECONDS", 900),

  // Gravação local
  maxRecordingMs: int("MAX_RECORDING_MINUTES", 240) * 60_000,
  silenceStopMs: int("SILENCE_STOP_SECONDS", 180) * 1000,
};
