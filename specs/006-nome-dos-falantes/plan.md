# Implementation Plan: Nome dos falantes pela chamada

**Branch**: `006-nome-dos-falantes` | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)

**Input**: `specs/006-nome-dos-falantes/spec.md`

## Summary

O assistente (Playwright/Chromium em `apps/backend/src/bot/`) passa a ler, na própria tela da chamada,
quem está falando e grava uma linha do tempo `(participante, início, fim)` em segundos do áudio gravado.
No passe final (`pipeline.ts` → `replaceWithFinal`), um casamento puro por sobreposição temporal liga
cada "Speaker N" ao nome mais compatível; ao vivo (`liveSession.ts`), cada segmento do canal `mixed`
recebe o nome dominante do intervalo. Sem dados válidos, tudo continua como hoje. A leitura roda
**dentro da página** (poll leve, só mudanças saem para o Node), com seletores isolados por plataforma e
verificação de saúde; falha nunca derruba a gravação.

Abordagem em uma linha por plataforma:

- **Teams** (convidado e conta logada): tiles do palco com nome + indicador de voz; fallback na lista de
  pessoas; dois perfis de seletor (`guest`, `account`) com a mesma interface.
- **Meet**: tiles `[data-participant-id]` com nome e indicador de áudio; fallback no painel de pessoas.
- **Casamento**: matriz rótulo × pessoa por sobreposição ponderada, deslocamento estimado por reunião,
  limiares de evidência/pureza/margem; nome manual prevalece.

## Technical Context

**Language/Version**: Node 24 + TypeScript (backend), React/Vite (frontend), Python 3.12 (worker, sem
mudança prevista)

**Primary Dependencies**: `playwright` 1.63 (já no backend; leitura via `page.exposeBinding` +
`page.evaluate`), `pg`, `zod` (contracts), Vitest. **Nenhuma dependência nova** (jsdom NÃO é usado: o
indicador depende de estilo computado, que o jsdom não calcula; ver "Testes sem reunião real")

**Storage**: Postgres: tabela nova `speaker_activity`; colunas novas em `meeting_speakers` e
`meetings`

**Testing**: Vitest (unidade: normalização, linha do tempo, relógio, casamento, resolução ao vivo);
Vitest + Playwright/Chromium em `page.setContent` (fixtures de HTML); `npm run test:db -w
@meeting-bot/backend` (migração e aplicação de nomes); validação com reunião real (Princípio VII)

**Target Platform**: Linux, container do backend com Chromium headed no Xvfb (como hoje)

**Project Type**: monorepo web (`apps/{backend,frontend,worker-gpu,host-agent}` + `packages/contracts`)

**Performance Goals**: leitura < 3% de um núcleo com 8 participantes; nenhuma espera no ciclo de 5 s
do bot; casamento em < 1 s para 1 h de reunião (centenas de segmentos × dezenas de intervalos)

**Constraints**: `LOCAL_ONLY` (LLM externo só pela exceção da constituição 3.0.0); sem biometria; só o que o convidado vê; falha isolada; GPU intocada

**Scale/Scope**: reuniões de 2 a ~30 participantes; viewport do bot 1280×720 (limita tiles
visíveis)

## Constitution Check

*GATE: aprovado para a Phase 0; reavaliado após o design (sem novas violações). Revisado contra a Constituição 3.0.0 em 2026-11-18.*

| Princípio | Como o plano atende | Status |
|---|---|---|
| I. Local-first e Privacidade | Leitura, linha do tempo e casamento rodam no backend local, sem chamada nova de rede; diarização (pyannote) e Whisper seguem locais, e nenhum modelo novo é adicionado. No ASR externo (exceção de teste) só o áudio sai, como hoje, e os nomes são aplicados localmente. Não existe LLM local (3.0.0): ata, itens ao vivo, ADR e chat usam o provedor externo de `LLM_GENERATION_PROVIDER` (padrão `claude`), só com `ALLOW_EXTERNAL_LLM=true`. Os nomes da chamada passam a fazer parte da transcrição enviada a esse provedor, como o título e os falantes renomeados já fazem (Decisão 3); sem a flag não há envio e a busca, a transcrição e os nomes seguem normalmente. O backend nunca envia a linha do tempo (`speaker_activity`), só os nomes já aplicados aos segmentos, e a chamada ao provedor continua registrada com uso e custo, sem conteúdo. Nomes de terceiros são dado pessoal: guardados com a reunião e apagados junto (Decisão 1). Sem biometria nem vetores de voz. | ✅ |
| II. Respeito às Políticas da Organização (NÃO NEGOCIÁVEL) | Lê só o DOM que o convidado já vê; sem endpoints internos, sem interceptar tráfego, sem pedir permissão, sem simular ações para obter dado liberado só a outros papéis. Sem ligar legendas nem abrir painéis na v1. Risco de interpretação: "automação que simule o usuário para obter dados" — aqui não há ação do usuário simulada, só leitura passiva. | ⚠️ exige emenda MINOR 3.1.0 registrando a leitura passiva (Decisão 2, aprovada; aplicar antes do merge da implementação, T063) |
| III. Humano no Controle | Nome automático é proposta: marcado "da chamada" + confiança, editável, reversível; manual prevalece. O que o LLM externo gera com esses nomes continua proposta. | ✅ |
| IV. Rastreabilidade | Linha do tempo guarda a evidência do nome (intervalos por pessoa); segmentos e evidências dos itens não mudam (só o `speaker`). Retranscrição refaz o casamento. | ✅ |
| V. Orçamento de GPU | Nenhum uso de GPU/VRAM (a GPU atende só o Whisper); casamento é CPU puro. Sem Ollama nem modelo generativo local. | ✅ |
| VI. Desktop Nativo, Serviços em Container | Tudo no backend (container); host-agent intocado. | ✅ |
| VII. Incremental e Verificável | Fixtures + testes automatizados por módulo puro; **validação com reunião real obrigatória** (tarefas T060–T062) antes de declarar pronto; seletores são hipóteses até a captura (T001). | ✅ |
| VIII. Stack e Idioma | Node/TS, React, Postgres, contratos em zod; textos e commits em pt-BR. | ✅ |
| Regras operacionais | Gravação continua do assistente; áudio guardado; `Remoto`/`user` preservados; acesso por RBAC reaproveita `meetings.manage`. | ✅ |

## Phase 0 — Pesquisa e decisões técnicas

### R1. Fonte da informação: o que o convidado vê

Hipóteses de seletor a **confirmar na captura (T001)**. Os nomes de atributos abaixo vêm de
conhecimento geral sobre as telas e de bots de terceiros; **nada foi verificado neste repositório**, e as
classes CSS do Meet/Teams são ofuscadas e mudam sem aviso, então nenhuma classe CSS é usada como
seletor principal.

| Plataforma | Descoberta de tiles (camada 1: semântica) | Nome | Indicador de fala | Camada 2 (estrutural) | Camada 3 (painel) |
|---|---|---|---|---|---|
| Meet | `[data-participant-id]` (cada tile; id estável por dispositivo) | `data-self-name`, texto do rótulo no tile, `aria-label` | elemento do indicador de áudio dentro do tile: mudança de classe/atributo ou estilo animado (barras/anel); lido por estado, não por classe fixa | contêiner com `video`/avatar + texto curto; indicador = descendente cujo estilo computado (animação, `outline`/`box-shadow`, altura de barras) difere do repouso | lista de pessoas (`role="list"` + `listitem`) com ícone de microfone animado |
| Teams (convidado e conta) | `[data-tid]` do tile de participante/stream no palco (candidatos: tile de vídeo, `voice-level-stream-outline`); `aria-label` do tile com o nome | `aria-label` do tile / rótulo com o nome (sem estado de microfone) | anel/contorno de voz ativa do tile (candidato `data-tid="voice-level-stream-outline"`): presença do elemento ou estilo (contorno visível) | mesma heurística estrutural do Meet | painel de pessoas: `role="menuitem"/"listitem"` com `aria-label` "Nome, ..." e ícone de microfone animado |

Regras comuns para todas as camadas:

- **Perfis**: Teams tem `guest` (tela leve de convidado) e `account` (app completo, ~36 s para
  carregar; ver `ACCOUNT_JOIN_TIMEOUT_MS` em `runner.ts`). O perfil só define a **ordem** das
  tentativas; o leitor tenta todos até achar tiles (a tela real é a verdade). Cada perfil tem fixture.
- **Camadas em cascata por ciclo de descoberta (a cada 5 s)**: camada 1 → 2 → 3, parando na primeira
  que devolver ao menos um tile com nome. A camada usada vai no estado (`source`), para diagnosticar
  deriva.
- **Frames**: o leitor percorre `page.frames()`; se a chamada vier em iframe, é lida lá.
- **Locale**: o bot abre com `--lang=en-US`; rótulos localizados (pt) entram nas mesmas expressões
  regulares (como em `platforms.ts`).
- **Nome**: texto do rótulo → `normalizeDisplayName`: remove `(Você)/(You)/(Eu)`, `(Guest)/(Convidado)/
  (External)/(Externo)`, ", Microphone on/muted…", sufixo de função, espaços extras, caracteres de
  controle; limite de 120 caracteres. Chave: `data-participant-id` no Meet; no Teams, o
  identificador do tile se existir, senão o nome normalizado.
- **Ignorados**: tile cujo nome normalizado é igual a `identity.name` (o assistente), marcado "(You)"
  na conta logada, vazio, ou "… apresentando/presenting" (tile de compartilhamento).
- **Fala "ativa"** (por tile): verdadeiro se o indicador estiver presente/animado por estado (atributo
  ARIA ou `data-*` quando existir; senão diferença de estilo computado em relação ao próprio repouso do
  tile, aprendido nos primeiros ciclos sem som). Sem classe fixa, sem posição de pixel.

### R2. Mecanismo: MutationObserver × polling e frequência

Decisão: **polling dentro da página, disparado por `setInterval` (não `requestAnimationFrame`, que o
Chromium estrangula em segundo plano) a cada 250 ms**, avaliando uma função pura
`snapshot(document) → [{key, name, speaking}]`. Só **mudanças de estado** (borda de subida/descida) saem
para o Node, agrupadas a cada 1 s por um binding (`page.exposeBinding("__mbSpeakers", …)`).

- Por que não só `MutationObserver`: o indicador do Meet é animação (barras mudam de altura) e o do Teams
  é estilo/contorno; muitas vezes não há mutação de atributo para observar, e o Teams gera rajadas de
  mutações que custariam mais CPU do que um `querySelectorAll` de ≤ 50 tiles a cada 250 ms.
- `MutationObserver` entra só como **dica barata**: observa o contêiner do palco para invalidar o cache
  de tiles quando alguém entra/sai/renomeia (reduz custo de redescoberta), sem decidir fala.
- Custos: `getComputedStyle` só nos candidatos a indicador; cache de tiles entre ciclos; intervalo sobe
  para 500 ms com > 30 tiles. Meta e medição em T038.
- **Histerese** (no coletor Node): intervalo só abre após ≥ 300 ms de fala contínua; só fecha após ≥
  500 ms sem fala; intervalos da mesma pessoa com intervalo < 500 ms se fundem (o indicador pisca nas
  pausas curtas).
- **Isolamento**: o leitor é injetado por `page.evaluate` dentro de `try/catch` com `Promise.race` de 2 s;
  falha de injeção (navegação, frame destruído) tenta de novo na próxima descoberta; exceções dentro da
  página são capturadas na própria página e contadas, nunca propagadas; o coletor Node não é aguardado
  pelo ciclo principal do `runner.ts` (só chama `collector.check()` com `.catch`).

### R3. Alternativas consideradas

- **Legendas ao vivo (CC)** do Teams/Meet trazem nome por fala, mas exigem mudar a tela do bot
  (ligar legendas), dependem de política do tenant e geram mais DOM; descartadas na v1, reavaliar
  após a captura (Decisão 6).
- **Painel de pessoas aberto o tempo todo**: lista todos (útil em reuniões grandes), mas é um clique de
  interface e muda o layout; fica como camada 3, ativada só se as camadas 1–2 não acharem tiles.
- **Áudio por pessoa** (stream de cada participante via WebRTC): descartado — exigiria interceptar a
  mídia da plataforma (viola o espírito do Princípio II) e é biometria-adjacente.
- **jsdom para os testes**: descartado (estilo computado) e exigiria pacote novo.

### R4. Deepgram (ASR externo) traz diarização?

Sim, quando o provedor aceita as opções: `transcribeFileExternal` envia `provider.options.deepgram.diarize`
e numera os falantes **por fatia de 20 min** (`SLICE_SECONDS = 20 * 60`): "Speaker N" numa fatia única,
"Speaker N (parte i)" quando há mais de uma. Se o OpenRouter recusa as opções (HTTP 400), repete sem
diarização e `speaker` fica `null`. Consequências:

- O casamento é por rótulo, então "Speaker 1 (parte 1)" e "Speaker 2 (parte 2)" podem receber o mesmo
  nome — melhora o resultado (hoje o usuário renomearia cada parte).
- Sem diarização (`speaker = null`), o passe final não tem rótulos: aplica-se o **modo por segmento**
  (US1 estendido, tarefa T034): o segmento recebe o nome dominante da linha do tempo, igual ao ao vivo.
- Nada de novo sai da máquina: só o áudio vai ao provedor (como hoje); nomes e linha do tempo ficam
  locais.

## Phase 1 — Design

### D1. Módulos e fluxo

```text
runner.ts (já existente)
  └─ após isInCall: startSpeakerCollector(page, meetingId, platform, profile, identity, anchor)
        │ (try/catch; nunca await no ciclo; stop() com timeout no finally, antes de leaveCall)
        ├─ bot/speakers/probe.ts        função pura de página: snapshot(), saúde, contadores
        ├─ bot/speakers/teams.ts        perfis guest/account: seletores + normalização do tile (Teams)
        ├─ bot/speakers/meet.ts         seletores do Meet
        ├─ bot/speakers/collector.ts    binding, histerese, relógio, buffer e flush em lotes
        └─ bot/speakers/health.ts       regras de saúde (sem tiles, sem indicador, preso, correlação)
  recording/speakerTimeline.ts          Map<meetingId, SpeakerTimeline> em memória (consulta ao vivo)
  recording/liveSession.ts              rotula segmentos `mixed` (usa speakerTimeline.dominant)
  meetings/speakerNames.ts              casamento puro Speaker N ↔ nome (+ deslocamento)
  repo/speakerActivity.ts               insert em lote, leitura, delete; estado da leitura
  pipeline.ts                           após replaceWithFinal: applyCallNames(meetingId, segments)
```

Seletores e heurísticas de DOM ficam **só** em `bot/speakers/{teams,meet}.ts` (analogia com
`platforms.ts`: "quando parar de funcionar, ajuste aqui"). O `PlatformDriver` ganha um método
opcional `speakerProbe(profile)` que devolve a configuração do leitor; plataformas sem probe (ou
`BOT_SPEAKER_NAMES=false`) não instalam nada.

### D2. Linha do tempo: armazenamento e relação com o offset do áudio

**Migração** (apenas descrita; entra como statements idempotentes em `apps/backend/src/schema.ts`,
no padrão `IF NOT EXISTS`, sem rodar nada nesta etapa):

```sql
CREATE TABLE IF NOT EXISTS speaker_activity (
  id BIGSERIAL PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL,                -- 'teams' | 'meet'
  start_seconds NUMERIC NOT NULL,        -- relativo ao início do áudio gravado
  end_seconds NUMERIC NOT NULL CHECK (end_seconds >= start_seconds)
);
CREATE INDEX IF NOT EXISTS idx_speaker_activity_meeting
  ON speaker_activity (meeting_id, start_seconds);

ALTER TABLE meeting_speakers
  ADD COLUMN IF NOT EXISTS name_source TEXT CHECK (name_source IN ('call','manual')),
  ADD COLUMN IF NOT EXISTS name_confidence REAL;
-- legado: renomeações feitas à mão antes desta feature viram 'manual'
UPDATE meeting_speakers SET name_source = 'manual'
 WHERE name_source IS NULL AND display_name <> label AND label <> 'user';

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_timeline_meta JSONB;
-- { status: 'ok'|'partial'|'unavailable'|'off', source, layer, people, intervals, skewMs, reason? }
```

- `renameSpeaker` passa a gravar `name_source = 'manual'` (nome igual ao rótulo = "voltar ao rótulo":
  `name_source = NULL`).
- `seedSpeakers` continua `ON CONFLICT DO NOTHING`; em retranscrição, antes do `seedSpeakers` as linhas
  com `name_source = 'call'` ou `NULL` (padrão) são apagadas para refazer o casamento; as `manual`
  ficam (Decisão 5).
- Exclusão: `ON DELETE CASCADE` com a reunião; "excluir transcrição" também apaga
  `speaker_activity` (Decisão 1: cascade, sem retenção própria).

**Relógio.** O áudio gravado (`.ogg`) e o PCM ao vivo saem do mesmo `ffmpeg` e começam no mesmo
instante de captura; `LiveSession` já usa `offsetBytes / 32000` como segundos desde o início. O
coletor usa essa mesma régua:

1. `startRecording` já entrega cada bloco PCM; o runner acumula `B` (bytes recebidos) e `W` (o
   `performance.now()` da chegada).
2. A âncora do relógio é `anchorMs = min(W_k − B_k / 32 )` (32 bytes/ms): cada bloco chega depois de
   capturado, então o mínimo é a melhor estimativa do instante `t = 0` do áudio (erro = menor latência
   do pipe, dezenas de ms).
3. Cada evento de fala lido na página chega ao Node com o relógio da página, que é traduzido para o
   `performance.now()` do Node no registro do binding (diferença de relógios medida no início:
   `Date.now()` da página × do Node) e então para `t = (nowMs − anchorMs) / 1000`.
4. O restante da defasagem (indicador visual × áudio; geralmente 0,2–1,5 s) é tratado **no casamento**,
   por reunião, e não por constante fixa (R5). `BOT_SPEAKER_SKEW_MS` (padrão 0) existe só como
   ajuste manual de calibração e como chute inicial do ao vivo.

`meetings.started_at` NÃO serve de âncora (é gravado depois de `startRecording`, com latência de
banco). Persistência: buffer em memória; flush a cada 10 s (insert multi-linha dos intervalos
fechados) e flush final no `finally` do runner (intervalos abertos fecham no instante da parada).

### D3. Casamento "Speaker N" ↔ nome

Função pura `matchSpeakers(segments, intervals, opts)` em `apps/backend/src/meetings/speakerNames.ts`.

Entrada: segmentos do passe final (`label`, `start`, `end`), intervalos `(key, name, start, end)`,
duração do áudio. Saída: `Map<label, {name, key, confidence}>` + diagnóstico (`skewMs`, `coverage`,
rótulos sem decisão e o motivo).

1. **Preparação**: ignora rótulos `user` e `Remoto`; remove intervalos < 0,3 s; funde intervalos da
   mesma chave com lacuna < 0,5 s; ignora segmentos < 0,3 s.
2. **Deslocamento global** `δ ∈ [−2,0 s; +2,0 s]` (passo 0,1 s, indicador atrasado ou adiantado em
   relação ao áudio): para cada δ, `score(δ) = Σ sobreposição(segmento, intervalos deslocados em δ)`
   (qualquer pessoa). Escolhe o δ de maior score se ele superar a mediana dos scores em ≥ 15%; senão
   usa `BOT_SPEAKER_SKEW_MS`. Estimar em toda a reunião é robusto: o atraso é sistemático.
3. **Matriz** `M[rótulo][chave]`: o eixo do tempo é dividido nas fronteiras de intervalos; em cada fatia
   com `k ≥ 1` pessoas ativas e um segmento do rótulo, soma `duração / k` para cada pessoa (**fala
   simultânea**: ninguém leva o tempo todo).
4. **Métricas por rótulo L**: `D = Σ duração dos segmentos`; `C = Σ_p M[L][p]` (tempo coberto por algum
   indicador); melhor `p*`, segunda `p2`; `coverage = C / D`; `purity = M[L][p*] / C`;
   `margin = M[L][p*] / max(M[L][p2], ε)`.
5. **Decisão** (constantes iniciais, a calibrar em T060–T062): atribui o nome se
   `M[L][p*] ≥ max(2,0 s; 0,15·D)` (evidência), `coverage ≥ 0,30`, `purity ≥ 0,60` e `margin ≥ 1,5`.
   Caso contrário o rótulo fica "Speaker N" com o motivo no diagnóstico.
6. **Confiança**: `purity × min(1, coverage / 0,6)`. Faixas na UI: `≥ 0,75` alta; `0,50–0,75` "conferir";
   abaixo disso nem atribui (a decisão já exigiria purity ≥ 0,6).
7. **Mesma pessoa em 2 clusters** (pyannote dividiu a voz): permitido, os dois rótulos recebem o mesmo
   nome (a UI mostra "Maria (Speaker 1)" e "Maria (Speaker 4)"); a lista de participantes deduplica por
   nome normalizado (sem acento/caixa) em `participantNames` (`meetings/participants.ts`, T033).
8. **Um cluster com duas pessoas** (pyannote fundiu vozes): `purity` cai abaixo de 0,6 → sem nome. Dividir
   por segmento fica fora da v1 (o modo por segmento só vale sem diarização).
9. **Nomes iguais de pessoas diferentes** (chaves distintas): o 2º em diante ganha " (2)", " (3)" na
   ordem da primeira fala.
10. **O próprio dono e o assistente**: o assistente é excluído já na leitura. O dono, quando está na
    chamada, aparece como qualquer participante e é nomeado como os demais. O canal do microfone
    (`USER_SPEAKER_LABEL = "user"`, gravação pelo host-agent) nunca é renomeado pelo casamento; sem
    assistente não há linha do tempo e nada muda. `REMOTE_SPEAKER_LABEL = "Remoto"` (sem diarização)
    só é nomeado se, após a normalização, **uma única pessoa** concentra ≥ 95% da fala detectada na
    chamada; caso contrário permanece (tarefa opcional T036).
11. **Nome manual prevalece**: a escrita usa `name_source` — `manual` nunca é sobrescrito; `call`/`NULL`
    podem ser refeitos. Os nomes entram em `meeting_speakers.display_name` com `name_source='call'` e
    `name_confidence`.
12. **Validação cruzada com o áudio**: a fração do tempo de linha do tempo que cai sobre fala do ASR
    (`speechCoverage`) precisa ser ≥ 0,5; abaixo disso (relógio ou seletor errado) a linha do tempo é
    marcada `partial` e nenhum nome é aplicado.

**Modo por segmento** (sem diarização e para o ao vivo): `dominant(t0, t1)` = pessoa com maior tempo
ativo no intervalo, aceita se tempo ≥ 50% do segmento e ≥ 0,5 s; o desempate favorece quem tem mais
tempo no intervalo, senão sem nome.

### D4. Ao vivo

`LiveSession.process` (apenas canal `mixed`, apenas com linha do tempo em memória) calcula, para cada
segmento ASR, `dominant(base + s.start, base + s.end)` e grava `speaker = "live:<Nome>"`
(constante `LIVE_SPEAKER_PREFIX` em contracts). `speakerNameResolver` remove o prefixo e devolve o
nome, então `toSegmentJson`, o agente arquiteto (`agent/module.ts`) e a ata ao vivo já enxergam o
nome sem mudar de assinatura. Esses rótulos nunca entram em `meeting_speakers` (só `seedSpeakers`
do passe final cria linhas) e somem quando `replaceWithFinal` apaga os segmentos `live`. Intervalos
abertos (a pessoa ainda fala) valem até "agora" no momento da consulta. O deslocamento do ao vivo usa
`BOT_SPEAKER_SKEW_MS` (a estimativa por reunião só existe no passe final).

### D5. Saúde e degradação (`health.ts`)

O coletor mantém contadores e, a cada 30 s, avalia:

| Regra | Condição | Efeito |
|---|---|---|
| sem tiles | 0 tiles nomeados por > 60 s e `participantCount > 1` | `unavailable` (reason `no_tiles`) |
| sem indicador | tiles ok, mas nenhuma fala detectada em > 120 s de som (usa `hasSound` do runner) | `partial` (`no_indicator`) |
| indicador preso | ≥ 80% dos tiles "falando" por > 20 s seguidos | `partial` (`stuck`) e interrompe o registro |
| exceções | > 20 exceções de leitura na página em 1 min | `unavailable` (`errors`) |
| correlação | no casamento, `speechCoverage` < 0,5 (D3.12) | `partial` (`low_correlation`) |

Estado `partial`/`unavailable`: o coletor para de gravar intervalos suspeitos (ou descarta no
casamento), registra **uma** linha de log por mudança de estado e grava `speaker_timeline_meta`. A UI
mostra o aviso (US2). Nada disso lança exceção para o runner.

### D6. Testes sem reunião real

1. **Captura controlada (T001)**: script de desenvolvimento
   `apps/backend/scripts/capture-speaker-dom.mjs` roda dentro do assistente numa reunião do próprio
   usuário (Teams convidado, Teams conta, Meet) e salva instantâneos do DOM dos tiles com nomes
   substituídos por "Pessoa A/B/C" e sem URLs/ids reais; os HTML sanitizados viram fixtures. Nenhum
   dado real é commitado.
2. **Fixtures** em `apps/backend/test/fixtures/speakers/`: `teams-guest-stage.html`,
   `teams-account-stage.html`, `meet-grid.html`, `meet-people-panel.html`, `*-large.html` (palco
   parcial), `broken.html` (sem tile) e `stuck.html` (todos "falando"). Cada fixture expõe
   `window.__setSpeaking(name, on)` para simular a fala sem reunião.
3. **Testes** (Vitest + Playwright/Chromium com `page.setContent`, como `bot-*.test.ts`, sem pacote
   novo; pulam com aviso se o Chromium não existir): descoberta por camada, normalização do nome,
   bordas de subida/descida, histerese, ignorar o assistente, nomes duplicados, indicador preso,
   falha do leitor sem exceção.
4. **Unidade pura**: `normalizeDisplayName`, estimador de âncora, fusão/histerese de intervalos,
   `dominant`, `matchSpeakers` com tabela de cenários: empate, 2 clusters, fala simultânea, atraso de
   +1,2 s e −0,8 s, indicador preso, cobertura baixa, nomes iguais, manual prevalece, `user`/`Remoto`
   intactos, rótulos de Deepgram "(parte i)".
5. **Banco** (`test:db`): migração idempotente, legado → `manual`, `applyCallNames` respeitando
   `manual`, exclusão em cascata.
6. **Fim a fim sem reunião**: áudio sintético de fixture + linha do tempo sintética + diarização
   falsa do worker, rodando o `pipeline` até `speakers` na API.
7. **Validação real (Princípio VII)**: T060–T062 (Teams convidado, Teams conta, Meet).

## Project Structure

### Documentation (this feature)

```text
specs/006-nome-dos-falantes/
├── spec.md
├── plan.md       # este arquivo (research e data-model incorporados)
└── tasks.md
```

### Source Code (repository root)

```text
apps/backend/
├── scripts/capture-speaker-dom.mjs          # nova: captura anonimizada de DOM (dev)
├── src/
│   ├── bot/
│   │   ├── platforms.ts                      # + speakerProbe(profile) opcional no driver
│   │   ├── runner.ts                         # inicia/para o coletor, âncora de relógio
│   │   └── speakers/{probe,teams,meet,collector,health}.ts   # novos
│   ├── recording/{liveSession.ts,speakerTimeline.ts}         # ao vivo (novo: timeline)
│   ├── meetings/{speakerNames.ts,participants.ts}            # casamento (novo), dedupe
│   ├── repo/{transcripts.ts,speakerActivity.ts}              # seed/rename; nova repo
│   ├── pipeline.ts                           # aplica nomes após o passe final
│   ├── ata/routes.ts                         # POST apply-call-names; PATCH com origem
│   ├── schema.ts, config.ts, db.ts           # migração, BOT_SPEAKER_NAMES/SKEW, estado
│   └── security/audit.ts                     # eventos só com contadores
├── test/{speakers-*.test.ts,fixtures/speakers/*,db/falantes.test.ts}
apps/frontend/src/{components/Speakers.tsx,components/Transcript.tsx,pages/Reuniao.tsx}
packages/contracts/src/{domain.ts,events.ts} (+ schemas gerados)
```

**Structure Decision**: sem app novo; um subpacote `bot/speakers/` isola os seletores e o coletor, e
um módulo puro `meetings/speakerNames.ts` isola o algoritmo. O restante só ganha ganchos pequenos.

### Impacto em contracts

- `Speaker`: `+ nameSource: "call" | "manual" | null`, `+ nameConfidence: number | null`.
- `MeetingDetail`: `+ speakerTimeline: { status: "ok"|"partial"|"unavailable"|"off"; reason?: string;
  people: number; source?: string } | null`.
- `LIVE_SPEAKER_PREFIX = "live:"`; esquema do corpo de `POST …/speakers/apply-call-names` (vazio) e da
  resposta `{ applied: number, skipped: number }`; o `PATCH` ganha a variação "voltar ao rótulo".
- Regenerar `packages/contracts/schemas`. Nenhuma mudança em eventos WebSocket além do `transcript_replaced`
  já existente.

### Impacto no frontend

- `Speakers.tsx`: selo de origem ("da chamada"/"manual"), faixa de confiança (alta / conferir), ações
  "Voltar ao Speaker N" e "Reaplicar nomes da chamada" (some para leitor).
- `Transcript.tsx`: sem mudança de formato (já usa `speakerName`); rótulo ao vivo sem estilo especial.
- `pages/Reuniao.tsx`: aviso do estado da leitura (`partial`/`unavailable`) e texto de ajuda.

### README (listar; atualizar os três idiomas)

`README.md`, `README.en.md`, `README.es.md`: (1) "Separação de falantes": parágrafo "Nome dos falantes
pela chamada" (como funciona, só com o assistente, nada sai da máquina, sem biometria); (2) "Durante a
reunião": nomes ao vivo; (3) "Depois da reunião": origem e confiança, reaplicar; (4) tabela do `.env`:
`BOT_SPEAKER_NAMES`, `BOT_SPEAKER_SKEW_MS`; (5) "Limitações conhecidas": seletores quebram, reuniões
grandes mostram só parte dos participantes, só com assistente, aviso LGPD de nomes. Também: `CLAUDE.md`
(regras do projeto), `CHANGELOG.md`, `.env.example`, `.env.vps.example`, `docs/ARCHITECTURE.md`,
`docs/agente-arquiteto.md` (nomes ao vivo) e a constituição (emenda MINOR 3.1.0, aprovada; T063).

## Riscos principais

| # | Risco | Mitigação |
|---|---|---|
| 1 | DOM do Teams/Meet muda ou difere por perfil/tenant | camadas em cascata, isolado em `bot/speakers/*`, saúde + descarte, fixtures, aviso na UI, script de captura para reajuste |
| 2 | Nome errado atribuído com confiança | limiares conservadores, "conferir", manual prevalece, validação real antes de declarar pronto, thresholds calibráveis |
| 3 | Palco parcial em reuniões grandes (viewport 1280×720) | camada 3 (painel), nomes só para quem aparece; aceitar "Speaker N" para o resto |
| 4 | Defasagem indicador × áudio | estimativa de δ por reunião, correlação com o áudio como trava |
| 5 | CPU/estabilidade da leitura na página | poll leve com cache, 250–500 ms, medição (T038), isolamento de falha |
| 6 | Nomes de terceiros (LGPD) | tratado como dado local, cascade, Decisões 1 e 3, auditoria sem nomes |
| 7 | Interpretação do Princípio II | emenda MINOR 3.1.0 aprovada (aplicar antes do merge da implementação); leitura passiva do que o convidado vê |
| 8 | Retranscrição renumera rótulos e deixa nome manual no cluster errado | refazer casamento, manter manual por rótulo e avisar (decisão 5) |

## Complexity Tracking

Sem violações que exijam justificativa; o ponto do Princípio II está coberto pela Decisão 2 (emenda MINOR 3.1.0 aprovada).

## Decisões tomadas (2026-11-18)

O usuário decidiu as seis questões que estavam em aberto. O plano e as tarefas seguem estas decisões.

1. **Linha do tempo com nomes de terceiros**: guardada com a reunião (`speaker_activity`) e apagada
   junto com ela e com "excluir transcrição" (cascade). Permite reaplicar e retranscrever. Sem prazo
   próprio de retenção.
2. **Emenda à constituição (Princípio II, MINOR 3.1.0)**: aprovada. Registra que o assistente lê
   passivamente o que o convidado já vê na tela (nomes e indicador de fala). Deve ser aplicada antes do
   merge da implementação (T063), com Sync Impact Report. Não é aplicada neste PR de documentação.
3. **Nomes da chamada no que vai para LLM externo e ata**: tratados como o resto do conteúdo (já vão o
   título, os participantes e os falantes renomeados), sob `ALLOW_EXTERNAL_LLM` e o provedor de
   `LLM_GENERATION_PROVIDER`. O aviso existente na UI cobre.
4. **Padrão**: ligado (`BOT_SPEAKER_NAMES=true`), desligável pelo `.env`.
5. **Nomes manuais ao retranscrever**: mantidos por rótulo (comportamento atual), com aviso na UI de que
   a numeração dos "Speaker N" pode mudar.
6. **Fontes na tela**: a v1 lê só os tiles do palco, sem abrir o painel de pessoas nem ligar legendas;
   reavaliar após a captura real (T001).

Continua valendo: os seletores de DOM deste plano são hipóteses até a captura real (T001), e as
validações T060–T062 dependem de reunião real do usuário.
