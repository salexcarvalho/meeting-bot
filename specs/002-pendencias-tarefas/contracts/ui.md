# Contrato — telas e rotas do frontend

React 19 + react-router, no padrão visual atual (shell azul, primitivos em CSS puro, `lucide-react`). Tudo em
português do Brasil. O frontend só esconde; o backend decide (RBAC).

## Rotas

| Rota | Tela | Permissão para exibir |
|---|---|---|
| `/pendencias` | **Minhas pendências** | `tasks.read` (item "Minhas pendências" no grupo "Pessoal" do menu, ícone `ListChecks`) |
| `/pendencias?tarefa=<id>` | mesma tela, com o diálogo da tarefa aberto | idem |
| `/reunioes/:id` | ganha chip "Tarefa criada", botão **Virar tarefa** e a seção "Tarefas desta reunião" | `tasks.read`/`tasks.manage` |
| `/` (Hoje) | ganha o cartão "Minhas pendências" (P3) | `tasks.read` |

Quem não tem `tasks.read` e abre `/pendencias` é redirecionado para `/`.

## Minhas pendências

Estrutura (de cima para baixo):

1. Cabeçalho: título, botão **Nova tarefa**.
2. Contadores clicáveis (cada um aplica o filtro): **Abertas**, **Atrasadas**, **Vencem hoje**, **Sem responsável
   confirmado**; segmento por status (A fazer, Em andamento, Bloqueada, Concluída, Cancelada) com a contagem.
3. Filtros: Status (padrão Abertas), Projeto, Prazo, Responsável (+ nome), Prioridade, Reunião, busca por texto,
   ordenação. **Limpar filtros** volta ao padrão.
4. Lista (tabela no desktop, cartões abaixo de 640 px):

| Coluna | Conteúdo |
|---|---|
| Tarefa | título; abaixo, projeto e reunião (link, se houver acesso) |
| Status | seletor que salva na hora |
| Prioridade | rótulo com ícone (não só cor) |
| Prazo | data; "atrasada há N dias" com ícone; "dito: sexta-feira" quando só há prazo dito |
| Responsável | "Eu", nome, ou o selo **Responsável não confirmado** |
| Origem | selo "da reunião" (IA aprovada), "manual" |

5. Paginação por **Carregar mais** (limite 100).

Estados: carregando (esqueleto), erro com **Tentar de novo**, vazio sem tarefas (explica como criar), vazio com
filtros ("Nenhuma tarefa com estes filtros" + Limpar).

**URL como estado:** `?status=a_fazer,bloqueada&projeto=<id|none>&prazo=overdue&resp=me|none|other&nome=<texto>&prioridade=alta&reuniao=<id>&q=<texto>&ordem=due`.
Valores fora do conjunto são ignorados (nunca quebram a tela).

## Diálogo da tarefa (criar e editar)

- Campos: Título*, Descrição, Status, Prioridade, Prazo (data) + prazo dito (somente leitura, com botão "Usar como
  prazo" quando houver), Projeto, Reunião (só na criação; lista as reuniões visíveis), Responsável (Eu / Outra pessoa
  + nome / Não confirmado).
- Bloco **Origem** (se veio de item): reunião, tipo do item, trecho ("00:20:34, canal remoto") e links para o item e
  para o trecho; sem acesso à reunião, mostra só o instantâneo e a nota "Você não tem mais acesso à reunião".
  Se o item foi reaberto ou rejeitado, aviso "O item de origem está reaberto/rejeitado".
- Histórico em linha do tempo (reaproveita o padrão de `ItemHistory`): "Prazo: 30/11 → 05/12 · Sérgio · há 2 h".
- **Excluir** pede confirmação e explica que o item de origem continua.
- Salvar fecha e atualiza a lista e os contadores; erro mostra a mensagem do backend no próprio diálogo.

## Reunião

- `ItemCard`: item **aprovado** mostra **Virar tarefa** (abre o diálogo de confirmação com os campos derivados já
  preenchidos); com tarefa, mostra o chip **Tarefa criada · <status>** que leva a `/pendencias?tarefa=<id>`.
- Ao aprovar uma pendência `[Q1]`: toast "Tarefa criada em Minhas pendências" com **Abrir**; se vier
  `taskNotice.possible_duplicate`: "Já existe uma tarefa parecida" com link; se `assignee_other`: "Esta pendência é de
  <nome>; use Virar tarefa para acompanhá-la".
- Seção **Tarefas desta reunião** (do usuário): lista curta e **Nova tarefa** com a reunião pré-selecionada.
- O mapa `item → tarefa` vem de `GET /meetings/:id/tasks` (uma chamada ao abrir a reunião e após cada ação).

## Hoje (P3)

Cartão "Minhas pendências": **Atrasadas**, **Vencem hoje**, **Abertas**, **Propostas a revisar**; cada número é um
link para `/pendencias` já filtrada (o último leva a `/reunioes`). Sem `tasks.read` o cartão não aparece.

## Acessibilidade e responsividade

- Foco visível; todo controle por teclado; diálogo com `aria-modal`, foco preso e `Esc` fecha.
- Atrasada e prioridade comunicadas por texto e ícone, nunca só por cor; contraste dos temas claro e escuro.
- Seletor de status com rótulo acessível ("Status da tarefa <título>").
- Sem rolagem horizontal em 360 px; alvos de toque ≥ 40 px.
