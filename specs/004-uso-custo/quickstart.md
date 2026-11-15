# Quickstart — validação da F6 (uso, custo e auditoria)

Prova, de ponta a ponta, que o registro, os painéis, a auditoria e a retenção funcionam. Detalhes
de API em [contracts/](contracts/) e de dados em [data-model.md](data-model.md). Pré-requisitos do
ambiente: ver `specs/001-agente-reunioes-mvp/quickstart.md`.

## Automatizado

```bash
npm run typecheck
npm test                                              # unitários (usage-*, audit-projection)
npm run test:db -w @meeting-bot/backend               # Postgres descartável (uso-*, auditoria)
npm run test:e2e                                      # Playwright desktop + celular (uso.spec.ts)
```

## Manual (navegador real)

Contas: `sergio` (SUPER_ADMIN), um usuário comum `ana` e um `viewer`. Subir com
`docker --context default compose up -d --build` (somente em ambiente de teste; não fazer deploy
com reunião em processamento).

### 1. Registro de LLM (US1)

1. Como `ana`, gerar a ata de uma reunião de teste pelo modelo local, depois pelo OpenRouter
   (se `ALLOW_EXTERNAL_LLM=true`) e pela assinatura (se habilitada).
2. Forçar uma falha (chave inválida ou host-agent desligado) e gerar de novo.
3. Conferir no banco (somente leitura):

```sql
SELECT at, purpose, provider, model, input_tokens, output_tokens, cost_usd, duration_ms,
       compute_ms, attempts, success, error_code
  FROM ai_usage_logs ORDER BY id DESC LIMIT 10;
```

Esperado: uma linha por geração; OpenRouter com `cost_usd`; assinatura e local com `cost_usd`
nulo; a falha com `success = false` e `error_code` curto; nenhuma coluna com texto da reunião.

### 2. Registro de ASR (US2)

1. Processar uma reunião com Whisper local e outra com ASR externo (`ALLOW_EXTERNAL_ASR=true`).
2. Esperado: linhas `asr_final` com `audio_seconds`; a externa com `cost_usd` e uma por canal;
   o ao vivo com poucas linhas (flush a cada 10 min e no fim), não uma por trecho.

### 3. Painel do usuário (US3)

1. Como `ana`: Configurações > Consumo de IA. Conferir totais, quebras por finalidade/provedor/
   modelo, série diária, ASR local × externo e a lista de chamadas.
2. Trocar para o mês anterior e para um intervalo; filtrar "falhas".
3. Como `sergio`, abrir o próprio painel: não aparece nada de `ana`.
4. Compartilhar uma reunião de `ana` com `viewer`: o painel do `viewer` continua vazio.

### 4. Painel de admin (US4)

1. Como `sergio`: Administração > Uso de IA. Ver o total da instância e a quebra por usuário.
2. Abrir as ferramentas de rede do navegador: a resposta de `/api/admin/usage` não tem
   `meetingId`, `title` nem lista por reunião.
3. Como `ana`: o item não aparece no menu; abrir `/admin/uso` redireciona; `GET /api/admin/usage`
   responde 403.

### 5. Auditoria (US5)

1. Entrar com senha errada e depois certa como `ana`; trocar a senha.
2. Como `sergio`, redefinir a senha de `ana` (Administração > Usuários).
3. Como `ana`: Configurações > Segurança mostra a falha (com IP), a entrada, a troca de senha e
   "administrador redefiniu sua senha"; nada de `sergio` além disso.
4. Como `sergio`: Administração > Auditoria mostra todos esses eventos, filtráveis; sem títulos.

### 6. Retenção e histórico (US6)

1. Em ambiente de teste, definir `USAGE_RETENTION_DAYS=1` e `AUDIT_RETENTION_DAYS=1`, inserir uma
   linha com `at` de 3 dias atrás e reiniciar: a linha antiga some, a recente fica, e a auditoria
   mostra `retention_pruned` com contagens.
2. Com `USAGE_RETENTION_DAYS=0`, nada é apagado.
3. Em cópia do banco real: rodar o boot duas vezes e conferir que o total do mês do painel não
   duplica (`SELECT count(*) FROM ai_usage_logs WHERE source = 'audit_backfill'` estável).

## Critérios de aceite resumidos

- SC-001: uma linha por chamada/passe, em todos os provedores.
- SC-002: o total do painel = soma das linhas.
- SC-003/SC-007: zero dado de reunião alheia e zero texto de reunião nos registros.
- SC-008: poda só além do prazo; incorporação idempotente.
