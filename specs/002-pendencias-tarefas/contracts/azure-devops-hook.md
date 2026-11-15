# Contrato — gancho para o Azure DevOps (não implementado)

Esta feature **não** conversa com o Azure DevOps. Ela só deixa o encaixe pronto para que uma entrega futura o faça
sem migração destrutiva e sem refazer a tela.

## O que existe agora

- Coluna `tasks.external_ref JSONB NULL` (padrão nulo) e o campo `externalRef` em `Task` (somente leitura):

```ts
externalRef: {
  system: "azure-devops",          // string livre; um sistema por tarefa nesta versão
  id: string,                      // id do work item
  url: string | null,              // link para abrir no navegador
  syncedAt: string | null          // ISO da última sincronização
} | null
```

- `TaskPatch`/`TaskInput` **recusam** `externalRef` (`400`); só o código da integração futura o escreve.
- A tela mostra o campo, se existir, como um chip com link (`rel="noopener noreferrer"`, abre fora do app), e nada
  mais. Sem `externalRef`, nada aparece.
- Nenhum job, nenhuma credencial, nenhuma chamada de rede e nenhuma regra de egress nova.

## O que a integração futura precisará (referência, não decisão)

| Tarefa (esta feature) | Work item (Azure DevOps) | Observação |
|---|---|---|
| `title` | `System.Title` | |
| `description` + `source.quote` | `System.Description` | enviar a citação é opcional e é decisão de privacidade |
| `status` | `System.State` | `a_fazer`→To Do, `em_andamento`→Doing, `bloqueada`→Doing + etiqueta `blocked`, `concluida`→Done, `cancelada`→Removed; o processo do projeto define os nomes reais |
| `priority` | `Microsoft.VSTS.Common.Priority` | `urgente`=1, `alta`=2, `media`=3, `baixa`=4 |
| `dueDate` | `Microsoft.VSTS.Scheduling.TargetDate` | |
| `project` | projeto/área do Azure | exigiria um mapa `projects` → projeto do Azure |
| responsável | `System.AssignedTo` | exigiria mapa de usuários; a tarefa pessoal (Q3 = A) não tem `assignee_id` |
| `id` da tarefa | campo ou link de volta | para a sincronização reconhecer a tarefa |

## Condições para implementar (fora desta feature)

1. **Constituição II:** integração corporativa só com aval formal da TI. O tenant bloqueia Microsoft Graph e acesso
   por e-mail; o Azure DevOps é outro serviço e precisa de decisão própria.
2. **Constituição I:** enviar conteúdo de reunião (título, descrição, citação) a um serviço externo é saída de dados
   da infraestrutura do dono. Exige decisão explícita, egress liberado só para o host da organização, auditoria sem
   conteúdo e, se for conteúdo de reunião, emenda de constituição (como as de ASR e LLM externos).
3. **Constituição III:** a tarefa só vai para fora por ação humana (botão "Enviar para o Azure DevOps"), nunca sozinha.
4. **Credenciais:** token pessoal (PAT) cifrado no banco, como a chave do provedor de LLM (F3), nunca no `.env` da
   interface nem em log.
5. **Escopo de dados:** mapas de projeto e de usuário e a regra de conflito (a fonte de verdade é a tarefa local ou o
   work item?) precisam de spec própria.

## Por que `JSONB` e não uma tabela de integrações

Um único vínculo por tarefa cobre o caso de uso previsto. Se aparecer mais de um sistema por tarefa, ou histórico de
sincronização, a coluna migra para uma tabela `task_external_links` com uma cópia aditiva; o contrato `externalRef`
da API permanece.
