# Contrato interno — instrumentação do registro de uso

Não é HTTP: define como o código chama o registrador. Garante um registro por chamada, sem
conteúdo e sem poder quebrar a geração.

## `UsageSample` (entrada do registrador)

```ts
interface UsageSample {
  category: "llm" | "asr";
  purpose: UsagePurpose;            // explícito, nunca deduzido de texto
  provider: UsageProvider;
  model: string | null;
  meetingId: string | null;         // o registrador resolve o dono (meetings.created_by)
  userId?: string | null;           // só quando não há reunião (ex.: teste); senão derivado
  channel?: "mic" | "remote" | "mixed" | null;
  inputTokens: number | null;
  outputTokens: number | null;
  audioSeconds: number | null;
  costUsd: number | null;           // exatamente o `usage.cost` do provedor; nunca calculado
  durationMs: number | null;        // só a chamada ao provedor (sem fila da GPU)
  computeMs: number | null;         // inferência local mensurada
  attempts: number;                 // >= 1
  success: boolean;
  errorCode: UsageErrorCode | null; // obrigatório se !success
  label: string | null;             // <= 80 chars, rótulo interno
}
```

Regras do registrador (`apps/backend/src/usage/recorder.ts`):

1. `recordUsage(sample): void` é síncrona para o chamador e **nunca lança**; o INSERT é
   assíncrono com `.catch(console.error)` (mesmo padrão de `security/audit.ts`).
2. Valida e normaliza (tokens inteiros ≥ 0, `label` truncado em 80, `errorCode` do enum); amostra
   inválida é descartada com aviso, nunca grava lixo.
3. Resolve `user_id` por `meetings.created_by` do `meetingId`, com cache de 60 s; reunião
   inexistente → `user_id` nulo.
4. Não registra nada que contenha texto de reunião; o tipo `UsageSample` não tem campo para isso.

## Pontos de chamada

| # | Ponto | Arquivo | O que faz |
|---|---|---|---|
| 1 | Funil de LLM | `apps/backend/src/llm/index.ts#generate` | mede `durationMs`, recebe `usage` do provedor (ou do erro), classifica `errorCode`, chama `recordUsage`; devolve só `data` ao chamador |
| 2 | Ollama | `llm/ollama.ts` | soma `prompt_eval_count`/`eval_count` e `prompt_eval_duration + eval_duration` (ns → ms) das tentativas |
| 3 | OpenRouter LLM | `llm/openrouter.ts` | soma `usage.prompt_tokens`, `usage.completion_tokens`, `usage.cost` das tentativas; `audit("external_llm")` continua, agora com `userId` |
| 4 | Assinatura | `llm/hostCli.ts` | `result.usage.inputTokens/outputTokens`, `result.durationMs`, `costUsd = null`; `audit("external_llm")` com `userId` |
| 5 | Finalidade | `agent/postAnalysis.ts`, `agent/liveAgent.ts` | passam `purpose` (e `meetingId` no ao vivo) em todo `generate` |
| 6 | ASR externo | `asr/openrouter.ts#transcribeFileExternal` | uma linha por canal: soma `usage.seconds`, `usage.cost`, tokens das fatias; erro numa fatia → linha com `success=false` e minutos já feitos |
| 7 | ASR local final | `pipeline.ts` (bloco do `runTranscriptionJob`) | uma linha por passe: `audio_seconds` = soma de `duration` dos canais, `duration_ms` = tempo de parede |
| 8 | ASR ao vivo | `recording/liveSession.ts` + `usage/liveAsr.ts` | acumulador por `(meetingId, channel)` de `duration`, `speech_seconds`, `elapsed`; flush a cada `USAGE_ASR_FLUSH_MINUTES` e no `close()` |
| 9 | Auditoria de envio externo | `llm/openrouter.ts`, `llm/hostCli.ts`, `asr/openrouter.ts` | `userId` do dono passa a ser gravado |
| 10 | Auth | `routes.ts` (`/auth/login`, `/auth/logout`, `/auth/password`) | novos eventos `auth_*` |

## Contrato dos provedores (mudança de interface)

```ts
interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  computeMs: number | null;
  attempts: number;
  model: string | null;           // o efetivo, quando o provedor devolve
}
interface Generation<T> { data: T; usage: LlmUsage }

interface LLMProvider {
  generate<T>(req: GenerateRequest<T>): Promise<Generation<T>>;   // antes: Promise<T>
}
// Em falha, o provedor lança UsageCarryingError(cause, usage parcial).
```

`GenerateRequest` ganha `purpose: UsagePurpose` (obrigatório). `llm/index.ts#generate` mantém a
assinatura pública (`Promise<T>`), então `postAnalysis`, `liveAgent` e `agent/module.ts` não
mudam de forma.

## `UsageErrorCode`

`timeout`, `unavailable`, `schema_invalid`, `refused`, `truncated`, `disabled`, `cancelled`,
`other`, ou `http_<status>` (três dígitos). Classificação em `usage/errorCode.ts` (função pura,
testada com os erros reais dos três provedores). A mensagem original do provedor **não** é
gravada.

## Garantias testáveis

- Uma chamada de `generate` (com ou sem retentativas) = exatamente uma linha.
- Falha do INSERT não muda o retorno nem lança.
- Para cada provedor: os números gravados são os da resposta simulada (fixtures com o formato real
  da documentação oficial).
- Nenhuma coluna de texto contém trecho da transcrição de teste.
