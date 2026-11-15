# Quickstart: validar o compartilhamento de reunião

**Pré-requisitos**: backend e frontend rodando (`docker --context default compose up -d --build` ou
`npm run dev`), três contas: `ana` (USER, dona), `bia` (USER) e `leo` (VIEWER), criadas em Administração >
Usuários. Duas janelas do navegador (uma por usuário). **Não aplicar em banco real sem confirmação.**

## 1. Compartilhar (US1)

1. Como `ana`, abra uma reunião própria e clique em **Compartilhar**.
2. Digite `bi`: nada aparece (mínimo 3 caracteres). Digite `bia`: aparece "Bia" com nível permitido.
3. Escolha **Leitura** e confirme. Bia aparece em "Quem tem acesso".
4. Procure `leo`: aparece com "só leitura". Tente **Edição**: a API recusa (422).
5. Procure `ana`: ela mesma não aparece.

Esperado: toast de sucesso; `meeting_share_granted` no `audit_log` só com ids.

## 2. Destinatário (US3)

1. Como `bia`, em **Reuniões**, escolha **Compartilhadas comigo**: a reunião está lá com
   "Compartilhada por Ana · leitura" e a marca **Nova**.
2. Abra a reunião: a marca some; os botões de editar, gravar e reprocessar não aparecem.
3. Em **Minhas**, a reunião não aparece.

## 3. Alterar e revogar ao vivo (US2)

1. Mantenha `bia` com a reunião aberta e a transcrição visível.
2. Como `ana`, mude Bia para **Edição**: em `bia`, os botões de edição de itens aparecem sem recarregar; gravar,
   reprocessar e reagendar continuam ausentes (e a API devolve 403 se chamados).
3. Como `ana`, remova o acesso de Bia: em até 2 s `bia` vê "Seu acesso a esta reunião foi removido" e volta para a
   lista; a reunião sumiu; `GET /api/meetings/<id>` devolve 404.

## 4. Série (US4)

1. Como `ana`, crie uma reunião recorrente diária (5 ocorrências) e abra a primeira futura.
2. Em **Compartilhar**, escolha Bia, **Esta e as próximas** ("Vale para N ocorrências") e confirme.
3. Conferir na lista de Bia: só as futuras; passadas não aparecem; ocorrência criada depois pela extensão da série
   não herda (o diálogo avisa).

## 5. Isolamento (US5)

1. Como admin que não é dono nem destinatário: `GET /api/meetings/<id>/shares` devolve 404; `/admin/users`
   não mostra nada de reunião.
2. Como `bia` com **Edição**: `POST /api/meetings/<id>/shares` devolve 403; `/api/MEETINGS/<id>/shares` também.
3. Desative `bia` em Administração > Usuários: ela some da busca; `ana` vê "Desativado" na lista; reativar
   restaura o acesso.
4. Como `bia` (destinatária), `GET /api/llm/usage` não mostra consumo de reuniões da Ana.

## 6. Comandos de verificação

```bash
npm run typecheck
npm test
npm run test:db -w @meeting-bot/backend
npm run test:e2e -w @meeting-bot/backend
```

Critério de aceite: tudo verde, sem `console.log` novo, sem literais repetidos três vezes ou mais nos arquivos
alterados (checklist do Sonar) e README nos três idiomas atualizado.
