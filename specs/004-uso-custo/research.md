# Research — F6: painel de uso e custo de IA e auditoria visível

Decisões técnicas tomadas na fase de planejamento, com o que foi verificado no código e na
documentação oficial. Pendências de decisão do usuário ficam em `spec.md` (Q1–Q5).

## 1. O que existe hoje (verificado no código, 2026-11-14)

| Área | Estado | Arquivo |
|---|---|---|
| Chamada de LLM | ponto único `generate(priority, req, provider)` roteia para Ollama (fila da GPU), OpenRouter ou assinatura (`HostCliLlm`) | `apps/backend/src/llm/index.ts` |
| Contrato dos provedores | `LLMProvider.generate<T>(req): Promise<T>`: devolve só o dado, o uso se perde | `llm/provider.ts` |
| Uso do OpenRouter | grava `audit("external_llm", {meetingId, label, model, promptTokens, completionTokens, cost, durationMs})` por tentativa, **só no sucesso do HTTP**, **sem `userId`** | `llm/openrouter.ts` |
| Uso da assinatura | idem, com `provider: claude\|codex`, `cost: null`, **sem `userId`** | `llm/hostCli.ts` |
| Uso do Ollama | só `console.log` (`eval_count`, tok/s); nada persistido | `llm/ollama.ts` |
| ASR externo | `audit("external_asr", {meetingId, channel, seconds, model})` **antes** da chamada, sem custo, sem `userId`; custo só em `console.log` | `asr/openrouter.ts` |
| ASR local | passe final: `runTranscriptionJob` sem registro; ao vivo: `transcribeChunk` devolve `duration`, `speech_seconds`, `elapsed` e ninguém guarda | `asr/workerClient.ts`, `pipeline.ts`, `recording/liveSession.ts` |
| Painel atual | `GET /llm/usage?month=` lê `audit_log` (`kind='external_llm'`) com cast de `detail->>`; aba "Consumo de IA" | `llm/usage.ts`, `routes.ts:241`, `pages/settings/ConsumoTab.tsx` |
| Auditoria | `audit(kind, detail, userId)` em `security/audit.ts`; tabela `audit_log(id, at, kind, detail JSONB, user_id)` com índices `at` e `(user_id, at)`; **sem tela**, **sem retenção** | `security/audit.ts`, `schema.ts:203` |
| Login/logout/senha | **não auditados** | `routes.ts:189-236` |
| Permissões | `audit.read` existe (ADMIN); `ai_usage.read` não existe (o plano §8 o prevê) | `contracts/src/platform.ts`, `authz/matrix.ts` |
| Menu | `NAV_GROUPS` com `permission` por item; rotas admin em `App.tsx` | `components/shell/nav.ts`, `App.tsx` |
| `GenerateRequest` | `label` livre e `meetingId` opcional; a análise ao vivo **não** passa `meetingId` | `llm/provider.ts`, `agent/liveAgent.ts:169,220` |

Conclusão: a base é um único funil (`generate`) e um único ponto por provedor de ASR. Instrumentar
ali cobre todas as chamadas sem espalhar código.

## 2. Fontes de uso e custo por provedor (documentação oficial, via context7)

| Provedor | Tokens | Custo | Tempo | Observação |
|---|---|---|---|---|
| OpenRouter `/chat/completions` | `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` (tokenizador nativo do modelo) | `usage.cost` em créditos (USD); `usage.is_byok`; `usage.cost_details.upstream_inference_cost` | medido pelo backend | "OpenRouter always returns detailed usage information" (docs de referência da API): não é preciso pedir `usage: {include: true}`. Com BYOK, `cost` é a taxa do OpenRouter e pode ser 0; o upstream aparece em `cost_details`. |
| OpenRouter `/audio/transcriptions` (Deepgram nova-3) | `usage.input_tokens`, `usage.output_tokens`, `usage.total_tokens` | `usage.cost` | `usage.seconds` = duração do áudio | resposta de exemplo da doc: `{"text": "...", "usage": {"cost": 0.000508, "input_tokens": 83, "output_tokens": 30, "seconds": 9.2, "total_tokens": 113}}` |
| Ollama `/api/chat` (`stream:false`) | `prompt_eval_count`, `eval_count` | nenhum | `total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration` (nanossegundos) | mensagens vazias de carga/descarga (`done_reason: load/unload`) não trazem contagens; o código já ignora `unload` |
| Assinatura (Claude/Codex via host-agent) | `usage.inputTokens`, `usage.outputTokens`, `usage.model` em `AgentLlmResult` (nulos permitidos) | sem custo por chamada | `durationMs` do host-agent | contrato já existe em `packages/contracts/src/domain.ts` |
| Whisper local (worker-gpu) | n/a | nenhum | chunk ao vivo: `duration`, `speech_seconds`, `elapsed` (s); job final: sem `elapsed` no contrato | tempo do passe final = medição do backend em volta de `runTranscriptionJob` (inclui diarização e fila do worker) |

Decisões:

- **Custo é o informado, nunca calculado.** Sem tabela de preços (evita defasagem e estimativa
  inventada). `cost_usd` nulo = "não informado/sem custo por chamada".
- **Nenhuma chamada extra ao provedor** (nada de consultar `/generation` ou `/credits` do
  OpenRouter): mantém o egress guard como está e cumpre "nada sai da máquina" (FR-023).
- **Tokens de reasoning/cache** não são separados: guarda-se só entrada e saída (como o plano).
- **BYOK**: guardar também `is_byok` não vale a complexidade; a tela avisa que o valor é o `cost`
  informado pelo OpenRouter.

## 3. Tabela dedicada × `audit_log` (relacionada ao Q1)

| Critério | `audit_log` (hoje) | `ai_usage_logs` (F6) |
|---|---|---|
| Falhas e chamadas locais | não cabem (só sucesso externo) | uma linha por chamada, `success` e `error_code` |
| Usuário | `user_id` nulo nas chamadas externas | `user_id` do dono da reunião |
| Agregação | `(detail->>'x')::numeric` sem índice | colunas tipadas e índices `(user_id, at)` |
| Retenção | única, junto com segurança | uso e auditoria com prazos próprios |
| Sensibilidade | contém IP em falhas | só números e códigos |

Escolha recomendada: tabela dedicada **e** manter `external_llm`/`external_asr` no `audit_log`
como rastro de saída (Princípio I: "envios externos vão para `audit_log`, sem conteúdo"), agora
com `userId`. O painel passa a ler apenas `ai_usage_logs`; o histórico antigo é incorporado uma vez
(`audit_log_id` único) e depois `llm/usage.ts` é removido.

## 4. Como instrumentar sem espalhar código

- **Contrato dos provedores passa a devolver o uso**: `generate` → `{ data, usage }`, como o plano
  §10 (`AIProvider`) já define. Só `llm/index.ts#generate` consome e desembrulha; os chamadores
  (`postAnalysis`, `liveAgent`) continuam recebendo `T`.
- **Soma por chamada**: cada provedor acumula as tentativas (retries de schema, 2 no máximo) e
  devolve um único `usage` com `attempts`. No erro, o provedor lança um erro que carrega o uso
  parcial (`UsageCarryingError`) para o funil gravar a linha de falha com os tokens já gastos.
- **Finalidade explícita**: `GenerateRequest.purpose: UsagePurpose` obrigatório (o compilador
  aponta quem esqueceu). Mapeamento a partir dos pontos de chamada atuais:

| Chamada (arquivo) | `purpose` |
|---|---|
| `agent/postAnalysis.ts` extração final e consolidação final | `itens` |
| `agent/postAnalysis.ts` narrativa (modo completo) | `ata` |
| `agent/postAnalysis.ts` `runSummaryOnly` (resumo por trechos e narrativa quando `extract_items=false`) | `resumo` |
| `agent/postAnalysis.ts` ADR | `adr` |
| `agent/liveAgent.ts` extração e consolidação ao vivo | `ao_vivo` |

- **Dono**: o recorder resolve `meetings.created_by` pelo `meetingId` (consulta por chave primária,
  com cache curto em memória de 60 s); sem `meetingId` → `user_id` nulo ("instância").
- **Não bloquear**: `recordUsage` é "dispare e esqueça" como `audit()` (captura e loga o erro).
  Nunca lança.
- **`error_code` fechado** (enum de strings, nunca a mensagem do provedor):
  `timeout`, `unavailable` (host-agent/CLI/worker fora), `http_<status>` (ex. `http_402`),
  `schema_invalid`, `refused`, `truncated`, `disabled`, `cancelled`, `other`. A classificação
  fica numa função pura testável (`usage/errorCode.ts`).
- **ASR ao vivo agregado**: acumulador em memória por `(meetingId, channel)` somando
  `duration`, `speech_seconds` e `elapsed` de cada `transcribeChunk`; descarrega uma linha nova
  (append-only, por delta) a cada 10 min e no `close()` da `LiveSession`. Em queda do processo
  perde-se no máximo 10 min de acumulado (aceitável: é estatística, não cobrança).
- **ASR externo**: uma linha por canal (soma das fatias de 10 min), com `usage.seconds`,
  `usage.cost` e tokens; falha numa fatia marca a linha como erro com os minutos já transcritos.
- **ASR local final**: uma linha por passe, `audio_seconds` = soma de `JobChannelResult.duration`,
  `duration_ms` = tempo de parede de `runTranscriptionJob`. Melhoria opcional do worker (campo
  `elapsed` por job, aditivo) fica fora do escopo e é registrada como follow-up.
- **Tempo de GPU**: `compute_ms` = `(prompt_eval_duration + eval_duration)/1e6` do Ollama e
  `elapsed*1000` do Whisper ao vivo. É "tempo de inferência local"; não mede ocupação nem
  energia. Com `LOCAL_ONLY` o Ollama também pode rodar em CPU: o rótulo da UI é "inferência
  local", não "GPU".
- **Fila da GPU**: o tempo de espera na fila (`LlmQueue`) não entra em `duration_ms`
  (a duração é só da chamada ao provedor), para a métrica refletir o modelo e não a contenção.

## 5. Privacidade e isolamento

- `ai_usage_logs` guarda só metadados e números. Colunas livres: `label` (≤ 80 chars, vindo de
  rótulos internos como "extração final 1/3"; nunca texto da reunião) e `error_code` (enum).
  Teste de contrato varre as colunas de texto contra a transcrição de uma reunião de teste.
- **Painel do usuário**: `WHERE user_id = $me`. Reunião compartilhada não entra (o custo é do
  dono; as gerações são só do dono, conforme a revisão de segurança de 2026-09-16). O join
  com `meetings` para título usa `m.created_by = $me` como segunda trava.
- **Painel do admin**: consultas próprias que **nunca** selecionam `meeting_id`, e que agrupam por
  `user_id`/provedor/modelo/finalidade/dia. A resposta é tipada sem campo de reunião (o tipo
  garante em compilação, o teste de DB garante em execução). Chamadas sem dono formam o grupo
  `instance`. Usuário apagado/NULL vira "usuário removido".
- **Auditoria**: projeção por lista permitida (`audit/projection.ts`): para cada `kind` conhecido,
  quais chaves de `detail` podem aparecer e como são rotuladas em pt-BR. Chaves não listadas e
  `kind` desconhecido são descartados (default deny). `meetingId` não é exposto a admin; ao
  usuário aparece só o provedor e a finalidade, sem título.
- Quem vê o quê na auditoria: usuário = linhas em que `user_id = eu` (ator) **ou**
  `detail->>'target' = eu` (alvo de ação de admin). Admin = `audit.read` (todas as linhas,
  projetadas). Ator/alvo são resolvidos para nome de usuário no servidor.
- A constituição já diz "administradores gerenciam contas, mas não leem o conteúdo de terceiros":
  metadados de uso por usuário não são conteúdo. Nenhuma emenda é necessária para os painéis; a
  retenção de logs pede uma linha nova em "Regras Operacionais" (proposta de emenda MINOR, só com
  aprovação do usuário).

## 6. Banco e desempenho

- Migração aditiva e idempotente em `schema.ts` (padrão do projeto), sem ferramenta nova; aplicar
  no banco real só com confirmação (backup `pg_dump` antes, como o MVP).
- Índices: `(user_id, at DESC)`, `(at DESC)`, `(meeting_id) WHERE meeting_id IS NOT NULL`,
  `UNIQUE (audit_log_id) WHERE audit_log_id IS NOT NULL` (idempotência do histórico).
- Agregação por dia: `date_trunc('day', at AT TIME ZONE $tz)`. O fuso vem de `APP_TIMEZONE`;
  reaproveita `monthRange` de `llm/usage.ts` (mover para `usage/period.ts`).
- Volume esperado: centenas de linhas/dia; 100 mil linhas (meta SC-004) cabem nos índices acima.
- Poda: `DELETE ... WHERE at < now() - interval` em lotes de 5 000 (`ctid IN (SELECT ... LIMIT)`),
  com `pg_try_advisory_lock` para não duplicar (padrão do scheduler); roda no boot e a cada 24 h.
  A poda grava `audit("retention_pruned", {table, deleted, olderThanDays})`.

## 7. Interface

- Reaproveita primitivos existentes (`card`, KPI, `tabs`, tabela, `Skeleton`, `PageHeader`) e o
  padrão de abas de `Configuracoes.tsx`; sem biblioteca de gráfico nova (a série diária usa barras
  em CSS/SVG com `<table>` acessível equivalente). Ícones `lucide-react` (`BarChart3`,
  `ShieldCheck`).
- Rotas novas no front: `/admin/uso` (`ai_usage.read`) e `/admin/auditoria` (`audit.read`);
  aba nova "Segurança" em Configurações; a aba "Consumo de IA" é reescrita.
- Formatação em `format.ts`: tokens (`12,3 mil`), USD (`US$ 0,0042`; 6 casas se < 0,01), minutos
  de áudio (`h min`), duração, "—" para nulo.

## 8. Riscos de integração (outros agentes mexem em 002, 003, 005)

- `schema.ts`, `contracts/src/platform.ts`, `authz/matrix.ts`, `nav.ts` e `App.tsx` são pontos de
  colisão provável. Mitigação: edições pequenas e no fim dos blocos; migração desta feature em
  bloco comentado `-- F6 uso e custo` ao final de `schema.ts`; rebase sobre `develop` antes de
  cada fase. Numeração de tarefas é local à feature.
- Se a feature 002/003 trouxer o catálogo de provedores/modelos (F3), `provider` e `model` aqui
  continuam texto livre (rótulo), sem chave estrangeira, para não acoplar.

## 9. Alternativas descartadas

- **Calcular custo por tabela de preços**: defasa, e a assinatura não tem preço por chamada.
- **Consultar a API de geração/créditos do OpenRouter**: nova saída de rede e nova superfície.
- **Gravar o prompt/resposta para auditoria**: viola o Princípio I e a regra "sem conteúdo".
- **Teto de gasto com bloqueio**: decisão do usuário (2026-09-17) é só visualizar.
- **Uma linha por trecho de áudio ao vivo**: milhares de linhas por reunião sem ganho analítico.
- **Biblioteca de gráficos**: peso e dependência para duas visualizações simples.
