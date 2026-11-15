# Quickstart — validação de Minhas pendências e tarefas

Roteiro para provar a feature de ponta a ponta depois de implementada. Contratos em [contracts/](contracts/), dados em
[data-model.md](data-model.md), decisões em [research.md](research.md).

## Pré-requisitos

- Ambiente do MVP funcionando (ver `specs/001-agente-reunioes-mvp/quickstart.md`): `docker --context default compose
  up -d --build`, login em `http://127.0.0.1:3000`.
- **Antes de aplicar no banco real:** conferir que nenhuma reunião está em processamento (transcrevendo, gerando ata,
  em gravação) e só então reiniciar o backend. Fazer backup (`pg_dump`). A migração é aditiva, mas roda a cada boot.
- Dois usuários para o teste de isolamento: o dono (`sergio`) e outro com papel USER (`npm run user:create -- <nome>`
  no container do backend), mais um ADMIN e um VIEWER para os casos de acesso.

## Testes automatizados

```bash
npm run typecheck
npm test                                        # unitários: derive, identity, query, contratos
npm run test:db -w @meeting-bot/backend         # Postgres descartável: tarefas, acesso, migração
npm run test:e2e                                # Playwright: aprovar → tarefa → filtrar → concluir
npm run build
```

Esperado: tudo verde; `db/tarefas-*.test.ts` cobrem os cenários S1–S9 abaixo e a migração sobre cópia do banco real não
altera nenhuma tabela existente.

## Cenários manuais (navegador)

Use uma reunião real ou fictícia com a chave **Itens** ligada e ao menos 3 pendências propostas (uma com prazo
"30/11", uma com "sexta-feira", uma com responsável "João").

| # | Passo | Resultado esperado |
|---|---|---|
| S1 | Aprovar a pendência com prazo "30/11" e responsável vazio ou o seu nome | Toast "Tarefa criada em Minhas pendências"; em `/pendencias` aparece 1 tarefa `A fazer`, prazo 30/11, projeto da reunião, selo "da reunião" |
| S2 | Aprovar a pendência com "sexta-feira" | Tarefa sem data, com "dito: sexta-feira"; você define a data no diálogo |
| S3 | Aprovar a pendência de "João" `[Q2]` | Nenhuma tarefa nova; aviso "Esta pendência é de João"; **Virar tarefa** cria com responsável "João" |
| S4 | Reabrir e aprovar de novo a pendência do S1 | Continua 1 tarefa (nada duplicado) |
| S5 | **Gerar ata** de novo na reunião (reprocessar) | Itens aprovados e as tarefas permanecem; uma proposta nova parecida, se aprovada, mostra "Já existe uma tarefa parecida" |
| S6 | Num item aprovado de tipo `risco`, clicar **Virar tarefa**, confirmar | Tarefa criada com origem "da reunião"; chip "Tarefa criada" no item |
| S7 | Em `/pendencias`: filtrar Prazo = Atrasadas + Projeto; recarregar a página | Lista filtrada igual; a URL guarda os filtros; contadores coerentes |
| S8 | Mudar o status de uma tarefa para Concluída | Some de "Abertas"; contadores mudam; histórico mostra a mudança; `completedAt` preenchido |
| S9 | **Nova tarefa** só com título; depois editar prazo e excluir | Nasce `A fazer`/média/eu; histórico "Prazo: — → data"; a exclusão pede confirmação |
| S10 | Item proposto/rejeitado: tentar **Virar tarefa** (pela API) | `409 item_not_approved`; no app o botão nem aparece |
| S11 | Celular (360 px) | Lista vira cartões, filtros usáveis, sem rolagem horizontal |
| S12 | Tela Hoje (P3) | Cartão com atrasadas, vencem hoje, abertas e "propostas a revisar"; links filtram a lista |

## Isolamento e compartilhamento (sem tela de compartilhar)

Como a tela de compartilhamento ainda não existe, crie a linha direto no banco de teste (ou use o teste de banco):

```sql
INSERT INTO meeting_shares (meeting_id, user_id, access, granted_by) VALUES ('<reuniao>', '<usuario-b>', 'read', '<dono>');
```

| # | Passo | Resultado esperado |
|---|---|---|
| I1 | Usuário B (acesso `read`) abre a reunião e usa **Virar tarefa** num item aprovado | Cria a própria tarefa; o dono não vê nada novo |
| I2 | Dono, ADMIN e SUPER_ADMIN pedem `GET /api/tasks/<id da tarefa de B>` | `404` para todos; a lista de cada um não a inclui; os contadores não a contam |
| I3 | VIEWER abre `/pendencias` e chama `/api/tasks` | redireciona para `/`; `403` na API |
| I4 | Remover a linha de `meeting_shares` de B `[Q4]` | A tarefa continua na lista de B com o instantâneo; sem link para a reunião, o item ou o áudio |
| I5 | Dono exclui a reunião `[Q4]` | A tarefa de B permanece (ligação nula, instantâneo preservado) |
| I6 | B tenta `POST /api/tasks/from-item` com item de reunião sem acesso | `404` |

## Verificações de segurança e privacidade

- Nenhuma chamada de rede nova: `audit_log` não ganha `egress_blocked` durante o uso; nenhum registro `external_llm`.
- Nenhuma rota lista tarefas de outro usuário (`grep` por `owner_id` no serviço: toda consulta escopada).
- Tentar `PATCH /api/tasks/<id>` com `externalRef` no corpo: `400`.

## Critérios de pronto

SC-001 a SC-008 do `spec.md` verificados, testes verdes, scenarios S1–S12 e I1–I6 conferidos no navegador real, README
nos 3 idiomas atualizado e, antes de declarar a feature pronta, uma reunião real (ou o áudio de teste) percorrendo
S1–S5 (Constituição VII).
