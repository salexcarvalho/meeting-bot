# Modelo de dados: Compartilhamento de reunião

**Feature**: `specs/005-compartilhamento/` | Mudanças **aditivas** e idempotentes em `apps/backend/src/schema.ts`
(`IF NOT EXISTS`, sem ferramenta de migração nova). Aplicar em banco real só com confirmação do usuário.

## CURRENT

```sql
meeting_shares (
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  access     TEXT NOT NULL CHECK (access IN ('read','edit')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
)
idx_meeting_shares_user (user_id)
```

## PROPOSED

```sql
-- Um único statement, idempotente: o backfill só roda na primeira vez (quando a coluna ainda não existe),
-- para os compartilhamentos que já existem não aparecerem como "Nova" e a cada boot nada ser remarcado.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'meeting_shares' AND column_name = 'seen_at') THEN
    ALTER TABLE meeting_shares
      ADD COLUMN seen_at    TIMESTAMPTZ,
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE meeting_shares SET seen_at = created_at, updated_at = created_at;
  END IF;
END $$;
```

| Coluna | Uso |
|---|---|
| `updated_at` | Mostra "alterado em" ao dono; atualizada em `PUT`. |
| `seen_at` | `NULL` = destinatário ainda não abriu; marcada por `POST /shared-with-me/:id/seen` e ao abrir o detalhe pela UI. Volta a `NULL` quando o nível muda para cima (`read` para `edit`), para o aviso reaparecer. |

Sem coluna de escopo ou de série: o lote é resolvido na hora (D5 da pesquisa). Sem tabela nova (consistente com
"não criar estruturas equivalentes", `plataforma-multiusuario.md` §5).

### Índices

- `PRIMARY KEY (meeting_id, user_id)`: lookup por reunião.
- `idx_meeting_shares_user (user_id)`: já existe; cobre `scope=shared` e `visibleMeetingsSql`.
- Opcional: `CREATE INDEX IF NOT EXISTS idx_meeting_shares_unseen ON meeting_shares (user_id) WHERE seen_at IS NULL`
  para o contador de "Nova" (parcial, barato). Incluído em T006.

### Invariantes (garantidas no serviço e testadas no banco)

1. Dono nunca é linha de `meeting_shares` (`user_id <> meetings.created_by`).
2. `access = 'edit'` só para usuário com `meetings.manage` no momento da concessão.
3. Alvo ativo no momento da concessão.
4. Só o dono (`meetings.created_by = req.user.id`) escreve; o destinatário só apaga a própria linha.
5. Lote `following`: mesma série e mesmo dono; início igual ou posterior ao da reunião de referência.

## Entidades de API (zod em `packages/contracts/src/platform.ts` e `domain.ts`)

```ts
ShareAccess = "read" | "edit"
ShareScope  = "occurrence" | "following"

ShareEntry = {
  userId, username, name,
  access: ShareAccess,
  effectiveAccess: ShareAccess,      // "read" se o usuário hoje não tem meetings.manage
  active: boolean,
  grantedAt, updatedAt,
  seen: boolean
}

UserLookupItem = { id, username, name, canEdit: boolean }

MeetingListItem = MeetingSummary & {
  access: "owner" | "edit" | "read",
  ownerName: string | null,          // null quando o espectador é o dono
  shareCount: number | null,         // só para o dono
  shareUnseen: boolean               // só para destinatário
}

MeetingDetail += { ownerName: string | null }
```

## Auditoria (`audit_log.kind`, `detail` só com metadados)

| kind | detail |
|---|---|
| `meeting_share_granted` | `{ meetingId, target, access, scope, affected }` |
| `meeting_share_changed` | `{ meetingId, target, from, to, scope, affected }` |
| `meeting_share_revoked` | `{ meetingId, target, scope, affected }` |
| `meeting_share_left` | `{ meetingId }` (o ator é o próprio destinatário) |

`user_id` da linha de auditoria = quem agiu. Nunca título, participantes, link ou conteúdo.

## Consultas principais

```sql
-- escopo shared (compartilhadas comigo)
... WHERE EXISTS (SELECT 1 FROM meeting_shares s WHERE s.meeting_id = m.id AND s.user_id = $1)
-- escopo mine
... WHERE m.created_by = $1
-- escopo shared_by_me
... WHERE m.created_by = $1 AND EXISTS (SELECT 1 FROM meeting_shares s WHERE s.meeting_id = m.id)

-- projeção por espectador
CASE WHEN m.created_by = $1 THEN 'owner' ELSE s.access END AS access,
(m.created_by <> $1 AND s.seen_at IS NULL) AS share_unseen,
CASE WHEN m.created_by = $1 THEN (SELECT count(*) FROM meeting_shares x WHERE x.meeting_id = m.id) END AS share_count

-- série (lote)
-- manual: m.series_id = ref.series_id
-- .ics:   m.created_by = ref.created_by AND m.ical_uid = ref.ical_uid AND ref.ical_uid IS NOT NULL
-- ambos:  AND COALESCE(m.scheduled_start, m.created_at) >= COALESCE(ref.scheduled_start, ref.created_at)
```

`scope=all` mantém `visibleMeetingsSql`. O filtro `scope` combina com `projectId`, `status` e `before`.
