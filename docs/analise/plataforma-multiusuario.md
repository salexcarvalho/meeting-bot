# Plataforma multiusuário de agentes de reunião — auditoria e plano

- **Data:** 2026-09-16
- **Base:** código em `apps/*` depois do MVP (`specs/001-agente-reunioes-mvp`) e da constituição 1.1.0.
- **Referência visual:** `/home/salexcarvalho/Pessoal/Financeiro/web`. O app se chama "Bússola"; a cor principal é teal, e os neutros puxam para o mesmo matiz.

**Legenda de classificação:**

| Sigla | Significado |
|---|---|
| **JE** | já existe |
| **EP** | existe parcialmente |
| **PA** | precisa ajuste |
| **NE** | não existe |
| **DD** | depende de decisão do usuário |
| **DL** | depende de limitação externa |

## 1. Diagnóstico do sistema atual

O sistema é um agente **pessoal e local**. O pedido o transforma em uma **plataforma de vários usuários**. O núcleo (captura, transcrição, extração com evidência, revisão humana, ata e ADR) está sólido e deve ser reaproveitado. A base de identidade e autorização, porém, é de um só usuário.

| Camada | Estado | Onde |
|---|---|---|
| Autenticação | Usuário e senha (scrypt), sessão por cookie com hash do token, limite de tentativas no login, same-origin e CLI de usuários | `auth.ts`, `routes.ts`, `cli/user.ts` |
| Usuário | Só `id`, `username`, `password_hash` e `created_at`; nenhum perfil, papel ou ativo/inativo | `schema.ts` |
| Autorização | **Inexistente.** Qualquer usuário logado vê e altera todas as reuniões | `routes.ts`, `items/routes.ts`, `ata/routes.ts`, `recording/routes.ts` |
| Dono da reunião | A coluna `meetings.created_by` existe e é preenchida, mas nenhuma consulta filtra por ela | `db.ts`, `calendar/service.ts` |
| Tempo real | O WebSocket exige sessão, mas `agenda` e `gpu` vão para **todos** os clientes | `live/hub.ts` |
| Host-agent | Um token (`AGENT_TOKEN`) e uma máquina. O agendador grava **qualquer** reunião agendada | `agent/agentAuth.ts`, `recording/scheduler.ts` |
| Identidade no Modo Agente | O nome vem do `.env` (`BOT_DISPLAY_NAME`); não há foto | `config.ts`, `bot/runner.ts` |
| Nome do microfone | `USER_DISPLAY_NAME`, global no `.env` | `config.ts`, `pipeline.ts` |
| LLM | Interface `LLMProvider` (`generate`, `unload`, `health`), `OllamaProvider`, fila com prioridade e bloqueio de provedor externo | `llm/*` |
| Prompts | **Fixos no código**, sem versão | `agent/prompts.ts` |
| Documentos | Ata (19 seções, montada na leitura), resumo corrente, narrativa e ADRs | `ata/*`, `agent/postAnalysis.ts`, `items/service.ts` |
| Itens | 10 tipos, evidência validada, histórico, aprovação/rejeição e dedup | `items/*`, `agent/*` |
| Tarefas | Não existem; `pendencia` guarda `status_acao` e `responsavel` sem vínculo com usuário | — |
| Jobs | O pipeline é uma fila em memória por processo; o status fica em `meetings.status`. Não há job por tipo de documento | `pipeline.ts` |
| Custos | Não existem (o LLM é local). O `audit_log` registra só eventos de segurança | `security/audit.ts` |
| Frontend | React 19 com CSS próprio (tokens azuis, claro/escuro por `prefers-color-scheme`), barra superior simples e quatro páginas | `apps/frontend/src` |
| Testes | 111 unitários, 11 de banco (Postgres descartável) e pytest do worker e do host-agent. **Não há E2E** | `apps/backend/test` |

### Latência do "Entrar" (medida)

Existem dois botões "Entrar" diferentes.

1. **"Entrar" da agenda e do alerta do desktop.** É um link (`<a target=_blank>`) ou um `xdg-open`, e abre na hora.
2. **Modo Agente ("Enviar bot").** É aqui que está a demora.

| Reunião | Pedido → "entrando" | "entrando" → sala de espera | Espera → na call (humano) | Resultado |
|---|---|---|---|---|
| c3f75493 (Teams) | — | 45 s | — | falhou: 30 s esperando o campo de nome |
| 0cf95ab7 (Teams) | — | **45 s** | 13 s | ok |
| 56a75f88 (Teams) | — | **22 s** | 12 s | ok |

No banco, a diferença entre `created_at` e `started_at` ficou entre 34 e 58 s.

**Causas** (em `bot/platforms.ts`):

- **Esperas fixas em sequência.** Cada `clickIfVisible(x, timeout)` espera o timeout inteiro quando o elemento não aparece:
  - Teams: 15 s em "continuar no navegador", 3 s em "sem áudio" e 3 s em cada chave;
  - Meet: 2 s, 3 s e mais 3 s em cada botão.
- **Timeout ignorado no Meet.** O `isVisible({timeout})` do Playwright não espera nada, então o campo de nome às vezes é pulado.
- **Tela sem progresso.** A tela só mostra "entrando…". Não há etapas nem proteção contra pedido duplicado para o mesmo link.
- **Custo fixo de inicialização.** Criar o sink do PulseAudio e abrir o Chromium headed leva cerca de 2 a 4 s antes do `goto`.

## 2. Funcionalidades existentes (reaproveitar)

- Agenda por `.ics` e cadastro manual.
- Alertas no desktop com "Entrar" e "Não gravar".
- Gravação automática (host-agent) e Modo Agente (bot convidado).
- Transcrição ao vivo local e passe final com diarização.
- ASR externo opcional (Deepgram via OpenRouter), atrás de flag e com auditoria.
- Agente arquiteto ao vivo: 10 tipos de item com evidência, resumo corrente e dedup.
- Pós-análise em map-reduce: narrativa e ADRs sugeridos.
- Revisão humana (editar, aprovar, rejeitar, reabrir) com histórico.
- Ata em Markdown (cópia e download) e ADRs com número atribuído na aprovação.
- Rastreabilidade: clicar na evidência leva ao trecho e toca o áudio.
- Projetos com palavras-chave.
- Segurança: guarda de egress, auditoria, same-origin, limite de login, cookies HttpOnly e caminhos seguros.

## 3. Classificação dos requisitos (gaps)

| # | Requisito | Classe | Observação |
|---|---|---|---|
| 1 | Visual no padrão Bússola, azul, claro/escuro | **PA** | Os tokens azuis já existem. Faltam sidebar, header, cards, KPIs, tabelas, abas e alternância manual de tema |
| 2 | Perfil do usuário (nome real, exibição, agente, fotos) | **NE** | A tabela `users` só tem credenciais |
| 3 | Voz ou nome do agente gravado | **NE** | Gravar e guardar é viável. Usar a voz *dentro* da reunião é **DL** (o bot entra mudo; não há TTS local) |
| 4 | `meeting_display_identity` | **NE** + regra | Viável só no Modo Agente, no campo de nome **antes** de entrar. A constituição (II) exige que o bot se identifique como gravação: o sufixo é obrigatório |
| 5 | Foto na reunião | **DL** | Convidado anônimo não tem foto no Meet nem no Teams, só iniciais. A única imagem possível é a **câmera falsa** (imagem estática como vídeo). Ver Q5 |
| 6 | Latência do "Entrar" com estados e anti-duplicidade | **PA** | Medida acima. Fácil de corrigir |
| 7 | Transcrição local separada da análise | **JE** | Áudio → worker → segmentos → itens/ata |
| 8 | AIProvider híbrido (OpenRouter, OpenAI, local) | **EP** + **DD** | A interface existe. Provedor externo de LLM **viola o princípio I** e a decisão D4: exige emenda e decisão |
| 9 | Agente arquiteto com persona configurável | **EP** | A persona está fixa nos prompts. Falta usar o contexto do usuário |
| 10 | "Configurações > Meu Agente" | **NE** | |
| 11 | Prompts no banco com versão | **NE** | Hoje estão em `agent/prompts.ts` |
| 12 | Isolamento multiusuário | **NE** | `created_by` existe e pode virar o dono. Destino das reuniões atuais: **DD** |
| 13 | RBAC (4 papéis, 5 tabelas, checagem no backend) | **NE** | O que um admin enxerga do conteúdo alheio: **DD** |
| 14 | Administração > Usuários | **NE** | Hoje só existe a CLI |
| 15 | Configurações por categoria | **NE** | A maior parte está no `.env` |
| 16 | Tipos de conteúdo gerado | **EP** | Já existem ata, resumo e ADR. Faltam anotações, pendências pessoais, tarefas, decisões e análise arquitetural como documento |
| 17 | Ata com a estrutura pedida | **PA** | O template de 19 seções cobre quase tudo. Faltam "Objetivo" explícito, "Prazos" e "Riscos" como seções nomeadas: é só ajuste de template |
| 18 | Anotações informais | **NE** | É um prompt novo sobre a mesma base |
| 19 | Minhas pendências | **EP** | Os itens `pendencia` existem. Faltam o vínculo com o usuário (nome ou apelido) e o texto "Responsável não confirmado" |
| 20 | Minhas tarefas (5 status) | **NE** | Nova tabela `tasks`, convertida a partir de uma pendência |
| 21 | Hub "Gerar com IA" | **NE** | Hoje a análise é única, no fim da reunião |
| 22 | Jobs assíncronos com status e reprocessamento | **EP** | Existe a fila do pipeline. Falta tabela `generation_jobs` por tipo |
| 23 | Rastreabilidade | **JE** (itens) / **NE** (documentos novos) | Reusar `item_evidence` e referências `S<n>` |
| 24 | Correção humana e selos | **EP** | Itens e ADR têm `origin`, `edited` e `status`. Faltam documentos e tarefas |
| 25 | Painel pessoal | **EP** | "Hoje" mostra a agenda. Faltam KPIs, pendências, tarefas, decisões e ADRs |
| 26 | Área administrativa | **NE** | |
| 27 | Custo de IA por usuário | **NE** | Com LLM local, o custo é zero, mas tokens e tempo podem ser registrados. Com provedor externo: preço por modelo |
| 28 | Segurança (segredos, isolamento, auditoria) | **EP** | O `.env` tem modo 600. Faltam segredos no banco cifrados e auditoria de ações de admin |
| 29 | Arquitetura sugerida | **EP** | Os módulos batem. Faltam Auth/RBAC e o Orchestrator |
| 30 | Entidades | ver §4 | Reaproveitar `meeting_items` (decisões e pendências), `meeting_notes` (resumo), `adrs` (decisões arquiteturais), `audit_log` e `created_by` |

## 4. Respostas técnicas (as 14 perguntas)

1. **Como o agente entra na reunião?**
   - **Modo Assistente** (padrão): ninguém "entra". O usuário participa com a própria conta, e o host-agent grava o microfone e o áudio do sistema.
   - **Modo Agente:** um Chromium do Playwright, em modo headed dentro do Xvfb no container, abre o link como convidado anônimo. Ele preenche o nome, desliga câmera e microfone, pede para entrar, espera a admissão (a cada 2 s) e grava o sink do PulseAudio com ffmpeg.
2. **Por que o "Entrar" demora?** Ver §1. São 22 a 45 s de esperas fixas e sequenciais antes do pedido de entrada, mais o tempo de admissão humana (cerca de 12 s). A tela não mostra nenhum progresso.
3. **Como o nome do participante é definido?**
   - Modo Agente: o campo "Your name" / "Type your name" da tela de pré-entrada, uma única vez. No Teams, o nome passa por um filtro de caracteres.
   - Modo Assistente: vale o nome da conta do usuário, fora do controle do sistema.
4. **Dá para trocar o nome dinamicamente?** Não. Nem o Meet nem o Teams permitem que um convidado anônimo se renomeie depois de entrar. Trocar o nome exige sair e entrar de novo. Por isso o nome é escolhido **por reunião, antes do envio**.
5. **Há suporte a foto (avatar)?** Não há foto de perfil para anônimo; as duas plataformas mostram iniciais. O que funciona é a **câmera falsa** do Chromium (`--use-file-for-fake-video-capture` com Y4M ou MJPEG), que exibe uma imagem estática como vídeo.
   - Riscos: gasta banda e CPU, e pode esbarrar em regras do organizador. Usar a **foto do próprio usuário** como câmera de um bot pode fazer os outros acharem que ele está presente (comportamento enganoso).
   - Proposta (Q5): só avatar de agente ou imagem própria, sempre com uma **faixa "Assistente automatizado · gravando"** gravada na imagem, e nome com sufixo.
6. **Quais os limites de representar o agente?**
   - Sem API oficial (o tenant bloqueia o Graph).
   - Anônimos podem estar proibidos pelo organizador.
   - Os seletores mudam sem aviso.
   - Não há chat nem voz confiáveis. O bot entra mudo; falar exigiria TTS local e áudio falso, o que é possível no futuro, mas arriscado.
   - Constituição II: o bot **MUST se identificar como gravação**.
7. **Como o áudio é capturado?**
   - Modo Assistente: `parec` captura o microfone e o monitor do sink padrão. O áudio vai por WebSocket (PCM s16le 16 kHz, um canal por conexão), o backend grava `.pcm` com fsync e ack e, no fim, converte para `.ogg`.
   - Modo Agente: um null sink por reunião e ffmpeg lendo o `.monitor` em Opus.
8. **Como é a transcrição?**
   - Ao vivo: blocos de 8 a 30 s cortados em pausas, enviados ao worker-gpu (faster-whisper large-v3-turbo int8) com glossário.
   - Final: o worker transcreve o arquivo inteiro com diarização pyannote. Opcionalmente, o Deepgram via OpenRouter (flag).
   - As evidências são remapeadas para a transcrição final.
9. **Onde ficam os prompts?** Em `apps/backend/src/agent/prompts.ts`, como constantes (extração, consolidação, narrativa, ADR). Não há versão nem personalização.
10. **O que falta para vários usuários?**
    - Um dono em cada recurso, com filtro em todas as consultas.
    - Compartilhamento explícito.
    - Tempo real filtrado por usuário.
    - Host-agent associado a um usuário (o agendador só grava reuniões desse dono).
    - Configurações por usuário (nome do microfone, alertas, identidade).
    - Projetos por usuário ou compartilhados (**DD**).
11. **Como é a autenticação?**
    - Usuário e senha com scrypt (N=2^15). Sessão de 30 dias em cookie HttpOnly e SameSite, com o hash do token no banco.
    - Login com limite de tentativas. Same-origin (Origin, depois Sec-Fetch-Site, depois Referer). WebSocket por cookie e Origin.
    - Troca de senha derruba as outras sessões.
    - Falta: usuário ativo/inativo e reset de senha por admin (hoje só pela CLI).
12. **Existe RBAC?** Não.
13. **Os provedores estão desacoplados?** Em parte. A interface `LLMProvider`, a `LlmQueue` e a fábrica `createProvider` (que bloqueia os externos) existem. Faltam catálogo de provedores e modelos, preferências por usuário, chave cifrada, registro de uso e custo, e o adaptador OpenAI-compatível (OpenRouter e OpenAI usam o mesmo formato).
14. **Que dados devem ficar locais?**
    - Sempre: áudio, transcrição ao vivo, chaves e tokens (cifrados), fotos e voz.
    - Hoje, pela constituição: transcrição e documentos (o LLM é só local).
    - Se a emenda for aprovada (Q1): a transcrição sai apenas para o provedor escolhido, com opt-in e auditoria. Continuam fora do envio o áudio (salvo o ASR externo já permitido), as fotos e as chaves.

## 5. Alterações no banco

Todas as mudanças são **aditivas** no `schema.ts`, que é idempotente (`IF NOT EXISTS`). Não há ferramenta de migração nova. Aplicar no banco real só com confirmação.

**Reaproveitado:**

| Estrutura | Uso novo |
|---|---|
| `meetings.created_by` | vira o **dono** da reunião |
| `meeting_items` | decisões, pendências e riscos |
| `item_evidence` | rastreabilidade |
| `item_history` | correções |
| `adrs` | decisões arquiteturais |
| `meeting_notes` | resumo corrente |
| `audit_log` | ganha as ações de admin |

**Novo por fase:**

| Tabela | Fase | Conteúdo |
|---|---|---|
| `users` + colunas | F1 | `real_name`, `display_name`, `avatar_path`, `active`, `updated_at` |
| `user_settings` | F1 | `user_id` PK e `data JSONB` validado por zod, por categoria (perfil, reuniões, IA, documentação, calendário) |
| `agents` | F1 | um por usuário por enquanto (`owner_id` único): nome, descrição, papel, especialidade, prompt base, contexto, tecnologias, tipos de decisão, formato, idioma, tom, detalhe, avatar, voz |
| `roles`, `permissions`, `role_permissions`, `user_roles` | F2 | papéis de sistema criados por seed idempotente |
| `meeting_shares` | F2 | `meeting_id`, `user_id`, `access` (`read`/`edit`), `granted_by`: a "permissão explícita" |
| `ai_providers`, `ai_models` | F3 | catálogo com preço por mil tokens, contexto e rótulos de custo/qualidade/velocidade |
| `user_ai_settings` | F3 | provedor, modelo, temperatura, max_tokens, contexto e **chave cifrada** (AES-256-GCM com chave mestra do `.env`) |
| `prompt_templates`, `prompt_versions` | F3 | tipo, escopo (global ou usuário), versão, `active`, `created_at`, `updated_at`, autor |
| `generation_jobs` | F4 | tipo, status (`queued`/`running`/`done`/`error`), tentativas, erro, resultado |
| `documents` | F4 | reunião, dono, tipo (ata, anotações, resumo, decisões, análise, pendências), conteúdo, origem (IA/usuário), `edited`, `approved_by`, versão, referências a segmentos |
| `tasks` | F4 | título, descrição, projeto, reunião, item de origem, responsável, prioridade, prazo e status (5 valores) |
| `ai_usage_logs` | F6 | usuário, provedor, modelo, tokens de entrada e saída, custo estimado, reunião, tipo e duração |

**Não criar** `meeting_minutes`, `meeting_decisions`, `action_items`, `architectural_decisions`, `transcripts` ou `calendar_accounts`. Estruturas equivalentes já existem (`documents`, `meeting_items`, `adrs`, `transcript_segments`), ou o recurso está bloqueado pelo tenant (Graph).

## 6. Alterações no backend

- **`authz/` (F2)**
  - `loadPrincipal(user)` carrega papéis e permissões, com cache de 30 s invalidado quando papéis mudam.
  - `requirePermission(key)`.
  - `meetingAccess(principal, meetingId, "read"|"write")` concede acesso ao dono, a quem recebeu compartilhamento, ou a quem tem a permissão global `*.all` (se Q2 permitir). Rota que não passa por essa checagem recebe 404, não 403, para não revelar que o recurso existe.
  - As checagens valem para todas as rotas `/meetings/:id*`, `/items/:id*`, `/adrs/:id*`, áudio, screenshot, ata e WebSocket (`subscribe`).
  - A listagem filtra por dono ou compartilhamento.
  - O tempo real publica a agenda só para o dono e para quem recebeu compartilhamento.
- **`users/` (F1/F2)**
  - `GET/PATCH /me/profile`, `GET/PATCH /me/settings`, `GET/PATCH /me/agent`.
  - Upload de avatar (usuário e agente; PNG, JPEG ou WebP até 2 MB, validado pelos *magic bytes*) e de voz (webm/ogg até 60 s).
  - Admin: `GET/POST /admin/users`, `PATCH /admin/users/:id` (dados, ativo, papéis), `POST /admin/users/:id/reset-password`, `POST /admin/users/:id/reset-settings`. Todas essas rotas geram `audit`.
  - Usuário inativo: login recusado e sessões apagadas.
- **Bot (F1)**
  - `join()` passa a esperar em corrida (`locator.or()` e `waitFor` com um prazo total), sem somar timeouts.
  - Cada etapa registra o tempo (`[bot id] etapa=x ms=y`) e publica o progresso: `preparing`, `launching`, `opening`, `joining`, `waiting_admission`, `in_call`.
  - Anti-duplicidade: um bot por URL normalizada (409 com o id da reunião existente) e um bot por reunião.
  - A identidade vem do perfil do usuário, com sufixo obrigatório.
- **`ai/` (F3)**
  - `AIProvider` (o `LLMProvider` atual, estendido com `usage`).
  - Adaptadores `ollama` e `openai-compatible` (OpenRouter e OpenAI), este último só se a emenda for aprovada.
  - `resolveModel(user, purpose)`.
  - `PromptStore` (banco, com o código como seed).
  - Registro de uso.
- **`generation/` (F4)**
  - Fila persistente (`generation_jobs`) e um gerador por tipo.
  - Ata, anotações, pendências, tarefas, resumo, decisões, análise e ADR, além de "gerar tudo".
  - Validação de evidência reaproveitada.
  - Notificação pelo WebSocket.
- **Host-agent (F2)**
  - O token passa a pertencer a um usuário (`AGENT_OWNER` no `.env` por enquanto).
  - O agendador só considera as reuniões desse dono.
  - Um host-agent por usuário e tokens no banco ficam para depois (Q4).

## 7. Alterações no frontend

- **Shell no padrão Bússola, em azul**
  - Sidebar de 240 px com marca, três grupos (Pessoal, Reuniões, Sistema) e usuário com "Sair" no rodapé. No celular, vira drawer abaixo de 1024 px.
  - Header de 56 px translúcido com o botão "Nova reunião" e a alternância de tema, que é salva no `localStorage` e aplicada antes de o React montar.
  - Conteúdo com largura máxima de 1280 px.
  - Primitivos em CSS puro (sem Tailwind): card, KPI, tabela, badge, abas no estilo *segmented*, dialog, empty state, skeleton e botões com 6 variantes.
  - Ícones do `lucide-react`.
- **Páginas novas:**
  - Painel (F1 simples, F4 completo);
  - Configurações com abas: Perfil, Meu agente, Reuniões, IA, Documentação e Calendário;
  - Administração: Usuários (F2), Provedores e modelos (F3), Uso de IA e Auditoria (F6);
  - Minhas pendências e Minhas tarefas (F4).
- **Reunião**
  - Envio do bot com estados ("Preparando agente…", "Abrindo navegador…", "Abrindo reunião…", "Entrando…", "Aguardando admissão…", "Conectado") e botão travado enquanto o pedido está em andamento.
  - Hub "Gerar com IA" (F4).
- **Avisos fixos na interface:** o bot aparece sempre como "assistente automatizado". A tela de identidade mostra uma prévia de como o nome vai aparecer.

## 8. Estratégia de RBAC

| Papel | Permissões |
|---|---|
| SUPER_ADMIN | todas, incluindo `providers.manage` e a gestão de outros admins |
| ADMIN | `users.*` (exceto conceder ou alterar SUPER_ADMIN), `agents.*`, `settings.manage`, `audit.read` e `ai_usage.read` |
| USER | `meetings.read`, `meetings.manage`, `transcripts.read`, `transcripts.delete`, `documents.generate`, `documents.read`, `agents.read`, `agents.manage` (próprio) e `settings.manage` (próprio) |
| VIEWER | `meetings.read`, `transcripts.read`, `documents.read`, apenas no que foi **compartilhado** |

- **Escopo:** toda permissão de conteúdo vale **só** para recursos próprios ou compartilhados. Ver conteúdo de outro usuário por ser admin exige a permissão `meetings.read_all`. **Por padrão, nenhum papel a recebe** (Q2).
- **Regras invioláveis:**
  - ninguém rebaixa o último SUPER_ADMIN;
  - ninguém altera o próprio papel;
  - toda mudança de papel, ativação ou reset gera auditoria.
- **Bootstrap:** se nenhum usuário tiver papel, o mais antigo vira SUPER_ADMIN e os demais viram USER. A CLI ganha `--role`.
- **Frontend:** esconde o que o usuário não pode usar (lendo `session.permissions`). O backend continua sendo quem decide.

## 9. Estratégia multiusuário

- **Dono de cada recurso:**
  - `meetings.created_by` (as reuniões importadas por `.ics` ficam com quem importou);
  - itens, ADRs, notas e documentos herdam o dono da reunião;
  - tarefas têm dono próprio (`owner_id`), porque podem nascer de uma reunião compartilhada.
- **Compartilhamento:** `meeting_shares` por reunião, com leitura ou edição. Compartilhar por projeto fica para depois.
- **Chave de unicidade do `.ics`:** passa a incluir o dono. Duas pessoas importando o mesmo convite geram duas reuniões, cada uma com sua gravação.
- **Gravação local:** o agendador trabalha por host-agent. Hoje há um só, ligado a `AGENT_OWNER`. As reuniões de outros usuários nunca disparam gravação nesta máquina.
- **Configurações:** `user_settings` substitui `USER_DISPLAY_NAME`, que continua como padrão quando o campo está vazio. Os alertas também vêm do perfil do dono.
- **Tempo real:** cada cliente recebe só os eventos das reuniões a que tem acesso. GPU e sistema vão para todos, pois são metadados.
- **Reuniões atuais (7, do `teste-claude`):** o destino depende da Q3.

## 10. Arquitetura do AIProvider

```text
Rota/Job ──► AIOrchestrator.run(purpose, meeting, user)
                 │  resolveModel(user, purpose) ─► user_ai_settings → admin default → .env
                 │  PromptStore.get(type, user)  ─► versão ativa (usuário > global > seed)
                 │  AgentProfile(user)           ─► persona + contexto + tecnologias
                 ▼
             AIProvider (interface)
               ├─ OllamaProvider          (local, fila de GPU com prioridade)
               └─ OpenAICompatProvider    (OpenRouter/OpenAI — só com ALLOW_EXTERNAL_LLM + opt-in)
                 │  egress guard: apenas o endpoint do provedor
                 ▼
             UsageLogger ─► ai_usage_logs (tokens, custo estimado, duração)
```

- **Interface:**
  - `generate({system, user, schema, maxTokens, temperature, numCtx, label})` devolve `{data, usage: {inputTokens, outputTokens, model, provider, ms}}`;
  - `health()`;
  - `unload()`;
  - `capabilities` (JSON schema, contexto).
- **Seleção de modelo por perfil:**
  - `ao_vivo` usa o modelo rápido local;
  - `ata` e `analise` usam o modelo de qualidade;
  - `resumo` usa o mais barato.
  - O admin define o padrão e o usuário pode sobrepor quando permitido.
- **Chaves:**
  - cifradas com AES-256-GCM e chave mestra `SECRETS_KEY` (32 bytes, no `.env`, modo 600);
  - a interface mostra só os últimos 4 caracteres;
  - nunca são registradas em log.
- **Guardrails:**
  - validação por schema com nova tentativa;
  - toda saída continua "proposta";
  - evidência obrigatória;
  - sem conteúdo da reunião na auditoria.

## 11. Plano por fases

| Fase | Entregas | Depende de |
|---|---|---|
| **F1** | Esta auditoria; shell visual azul com tema manual; correção da latência do "Entrar" (esperas em corrida, tempos por etapa, estados na tela, anti-duplicidade); perfil do usuário; "Meu agente" (nome, descrição, persona, avatar, voz); identidade no bot (com sufixo obrigatório) | — |
| **F2** | RBAC (tabelas, seed, middleware, sessão com permissões); isolamento por dono e compartilhamento; Administração > Usuários; configurações por categoria; host-agent ligado ao dono | Q2 e Q3 (o padrão seguro é implementado antes) |
| **F3** | AIProvider com uso; catálogo de modelos; prompts no banco com versão; agente arquiteto usando o perfil; provedor externo opcional por flag (Q1) — **parcial (2026-09-17):** OpenRouter para ata e ADR pela `.env`, com auditoria de uso e custo | — |
| **F4** | Jobs de geração; documentos (ata, anotações, resumo, decisões, análise); minhas pendências; tarefas; hub "Gerar com IA"; painel completo | — |
| **F5** | ~~Imagem na reunião por câmera falsa~~ (Q5: sem imagem). A identidade por reunião já foi entregue na F1. | — |
| **F6** | Painel de uso e custo; auditoria na interface; painel de admin | — |

**Critérios por entrega:**

- testes unitários e de banco (Postgres descartável);
- E2E com Playwright contra o backend e um banco descartável (a infraestrutura nova entra na F1);
- teste no navegador real;
- regressão com a suíte completa, typecheck e build.

## 12. Decisões (respondidas em 2026-09-16)

| # | Pergunta | Decisão |
|---|---|---|
| Q1 | LLM externo (OpenRouter/OpenAI) na análise? | **Opcional, por flag** (`ALLOW_EXTERNAL_LLM`). O local continua padrão e o ao vivo é sempre local. Constituição 1.2.0; implementação na F3. Em 2026-09-17: a análise inteira pode ir ao OpenRouter, o modelo vem do `.env`, os botões perguntam a cada clique e a análise automática usa o OpenRouter se o `.env` mandar (constituição 1.3.0). |
| Q2 | Admin lê transcrições e documentos de outros usuários? | **Não**, só metadados. Ninguém recebe `meetings.read_all`. |
| Q3 | Destino das 7 reuniões do `teste-claude` | Criar `sergio` (SUPER_ADMIN, `AGENT_OWNER`), transferir as reuniões e desativar o `teste-claude`. |
| Q4 | Host-agent próprio do sócio | **No futuro** (backlog: token por usuário e agendador por máquina). Hoje há um só, o do `AGENT_OWNER`. |
| Q5 | Imagem na reunião | **Sem imagem**: nada de câmera virtual. A F5 fica restrita à identidade por reunião, que já está feita. |
| Q6 | Sufixo obrigatório | `assistente gravando` (formato `Nome - assistente gravando`). |

## 13. Estado da implementação (2026-09-16)

**Pronto e testado:** F1 inteira e a F2 com os padrões seguros das decisões pendentes.

- **Visual:** shell azul com tema claro/escuro manual (persistido), menu lateral e gaveta no celular.
- **"Entrar" do bot:**
  - esperas fixas trocadas por verificação em corrida (`bot/join.ts`), com limite em `BOT_JOIN_TIMEOUT_SECONDS`;
  - cada etapa é registrada com tempo (`etapa=… total_ms=…`) e aparece ao vivo na tela da reunião;
  - bloqueio de duplicidade no backend (mesmo link = 409) e no frontend (clique duplo gera um pedido só).
- **Identidade:**
  - perfil (nome real, nome de exibição, idioma, fuso, foto);
  - "Meu agente" (persona, tecnologias, tipos de decisão, prompt base, contexto, avatar, gravação de voz até 60 s);
  - "Nome na reunião" (meu nome, nome do agente, personalizado), sempre com o sufixo obrigatório.
- **Arquivos de perfil:** tipo conferido pelo conteúdo (SVG recusado); gravados com modo 0600 em `DATA_DIR/profiles/<usuário>/`; voz normalizada para Opus.
- **RBAC:**
  - tabelas `roles`, `permissions`, `role_permissions` e `user_roles`, com seed idempotente;
  - o usuário mais antigo vira SUPER_ADMIN;
  - toda rota confere a permissão no backend.
- **Isolamento:**
  - reuniões por dono, com `meeting_shares` pronta (leitura/edição) mas ainda sem tela;
  - quem não tem acesso recebe 404;
  - quem só lê recebe 403 ao tentar escrever;
  - o WebSocket filtra por público;
  - `.ics` passa a ser único por usuário.
- **Administração > Usuários:**
  - criar, editar, trocar papel, desativar/reativar, redefinir senha e redefinir configurações;
  - só SUPER_ADMIN gerencia ADMIN/SUPER_ADMIN;
  - ninguém altera o próprio papel;
  - sempre sobra um SUPER_ADMIN ativo;
  - tudo vai para a auditoria.
- **Host-agent:** grava só as reuniões do dono (`AGENT_OWNER`; vazio = primeiro usuário cadastrado, se ainda for SUPER_ADMIN ativo). O dono nunca passa sozinho para outra pessoa; as reuniões dos outros ficam como "perdida".

**Testes:**

| Suíte | Resultado |
|---|---|
| Unitários (`npm test`) | 169 |
| Banco (`npm run test:db`, inclui `multiusuario.test.ts` e a migração sobre cópia do banco real) | 41 |
| Host-agent (`uv run pytest`) | 30 |
| E2E Playwright (`npm run test:e2e`, desktop + celular, backend real e Postgres descartável) | 11 |

(Números atualizados em 2026-09-17, com a geração de ata e ADR, as assinaturas, a nova geração limpa e o resumo para enviar.)

Typecheck e build também passaram.

**Revisão de segurança (autorização), já corrigida:**

- **Guard de reunião contornável com maiúsculas** (`/api/MEETINGS/<id>/ata` devolvia a ata de outra pessoa).
  - Correção: o guard passou a decidir pelo padrão da rota registrada (`req.route.path`), não pela URL digitada.
  - Reforço: todos os routers diferenciam maiúsculas.
  - Prova: teste de regressão, com mutação que confirma que ele pega o erro antigo.
- **Ids de reuniões de terceiros** em `/system/status` (captura, gravação, fila), na agenda (captura) e no 409 de `/record`.
  - Correção: agora só aparecem para quem tem acesso; `/system/status` passou a exigir `meetings.read`.
- **Compartilhamento "edit"** podia gravar, parar, reprocessar (inclusive com ASR externo), reagendar e trocar o link da reunião do dono.
  - Correção: essas ações ficaram só com o dono; "edit" mexe só no conteúdo (itens, falantes, ADRs).
- **Dono do host-agent** podia passar sozinho para outro SUPER_ADMIN (rebaixando ou desativando o primeiro).
  - Correção: com `AGENT_OWNER` vazio, o dono é o primeiro usuário cadastrado, e só enquanto for SUPER_ADMIN ativo; sem ele, a máquina não grava.
  - O heartbeat só pede a gravação do dono.

**2026-09-17 — ata e ADR com OpenRouter:**

- Provedor `llm/openrouter.ts` (JSON Schema estrito, `require_parameters`, auditoria `external_llm` com tokens e custo).
- Botões **Gerar ata**, **Gerar ADRs** e **Gerar ADR**, cada um com a escolha local × OpenRouter e aviso antes de enviar.
- Rota `POST /meetings/:id/adrs/generate`, só do dono; `reprocess` aceita `llm`; os pedidos vão para `generation_requested`.
- Quem gerou fica gravado (`analysis_provider`, `generated_by`) e aparece na interface.
- Correção de UX: o aviso "Gerando…" não cobre mais o resultado quando a geração termina antes da resposta.

**2026-09-17 — assinatura pessoal (Claude Code e Codex):**

- Decisões do usuário: os dois; nos botões e na geração automática; aceita os termos de consumidor.
- O host-agent executa o CLI oficial isolado; o backend só troca pedidos e respostas com ele.
- Vale só para as reuniões do `AGENT_OWNER`. Sem a assinatura disponível, a geração automática usa o modelo local.
- Teste real com reunião fictícia: Claude em 76 s e Codex em 63 s, ambos com itens, ata e ADRs válidos.

**2026-09-17 — gerar de novo sem duplicar e resumo para enviar:**

- Problema real: cada "Gerar ata" somava itens (uma reunião chegou a 162 propostos) e a consolidação só via os últimos 60.
- Decisões do usuário: gerar de novo apaga e refaz do zero o que não foi revisado; rejeitados ficam; repetidos são mesclados sozinhos; resumo curto só com aprovados.
- Nova geração apaga os propostos da IA sem ação humana; a consolidação roda em lotes por tipo, com os revisados como âncora.
- Botão **Resumo para enviar** (aba Ata): objetivo, resumo, decisões, pendências com responsável e prazo e riscos, para colar no Teams ou no e-mail.
- Reinício no meio de "Gerar ata" retoma só a análise (antes refazia a transcrição).
- Aba Ata refeita (ficha no topo, índice, seções vazias numa linha, ações num só cabeçalho) e histórico do item em linha do tempo, com rótulos em português e antes/depois.
- Aba ADRs refeita: filtros por status, cartões recolhíveis, seções em duas colunas, link para a decisão de origem. Corrigido o "rejeitado em <data>", que mostrava a data da aprovação.

**Ainda não feito:**

- tela de compartilhamento (quando existir, revogar deve derrubar na hora as assinaturas do WebSocket; hoje a revalidação acontece a cada 30 s);
- resto da F3 (prompts no banco, perfil no agente, cadastro de provedores com chave cifrada) e F4 a F6.
