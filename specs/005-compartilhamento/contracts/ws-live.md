# Contrato: eventos ao vivo de compartilhamento (`/api/live`)

Complementa `specs/001-agente-reunioes-mvp/contracts/ws-live.md`. Tipos novos entram em `LiveServerMessage`
(`packages/contracts/src/events.ts`).

## Mensagem nova (direcionada)

```ts
{
  type: "meeting_access",
  meetingId: string,
  change: "granted" | "changed" | "revoked" | "deleted",
  access: "edit" | "read" | null,          // null em revoked e deleted
  by: string | null,                        // nome de quem agiu (null em deleted)
  title: string | null,                     // só em granted e changed (o destinatário já tem acesso)
  meeting: MeetingListItem | null           // só em granted: o item com o `access` do destinatário
}
```

Entrega: `LiveHub.publishToUser(userId, msg)` para **todas as conexões** do usuário (abas), estejam inscritas na
reunião ou não. Nunca difundida. Não passa por `publishBoth`/`publishAll`.

## Regras do hub

1. **granted**: não inscreve sozinho; o cliente envia `subscribe` ao abrir a reunião (o hub checa `meetingAccess`).
2. **changed**: mantém a inscrição; o cliente atualiza o `access` do estado local (botões de edição).
3. **revoked / deleted**: o hub MUST (nesta ordem) chamar `invalidateAudience(meetingId)`, remover `meetingId` de
   `state.meetings` de todas as conexões do usuário e só então enviar `meeting_access`. Depois disso nenhum evento
   da reunião (`segments`, `items`, `adrs`, `summary`, `recording`, `processing`, `bot`) chega a esse usuário.
4. A revalidação de 30 s (`sweep`) continua como rede de segurança, mas não é o caminho normal.
5. `subscribe` de reunião já revogada é ignorado (comportamento atual de `meetingAccess === null`).

## Invariantes

- O evento difundido `{ type: "meeting"; meeting: MeetingSummary }` **não ganha** `access`, `shareCount` nem
  `shareUnseen`. O cliente preserva esses campos ao mesclar o resumo na lista (`upsert`).
- `title` e `meeting` só vão a quem acabou de ganhar acesso (ou o mantém); `revoked` nunca leva título.
- O dono (autor) não recebe `meeting_access` pelas próprias ações; a resposta REST já traz o estado final.

## Comportamento do cliente

| Evento | Lista | Página da reunião | Aviso |
|---|---|---|---|
| `granted` | insere `meeting` (selo e "Nova") | n/a | toast "<by> compartilhou «<title>» com você (<nível>)" |
| `changed` | atualiza `access` | troca botões sem recarregar | toast discreto |
| `revoked` | remove | mostra "Seu acesso a esta reunião foi removido" e volta para a lista | toast |
| `deleted` | remove | idem, com "A reunião foi excluída pelo dono" | toast |
