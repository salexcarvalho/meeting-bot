# Changelog

[Português](#português) · [English](#english) · [Español](#español)

Formato: [Keep a Changelog](https://keepachangelog.com/). Versões: [SemVer](https://semver.org/).

---

## Português

### [Não lançado]

- Uso e custo de IA e auditoria visível (F6, `specs/004-uso-custo`): cada chamada de LLM (local, OpenRouter, assinatura) e cada passe de ASR (Whisper final, ao vivo agregado, Deepgram) vira uma linha em `ai_usage_logs` (finalidade, provedor, modelo, tokens, minutos de áudio, custo informado pelo provedor, tempo, tentativas, resultado com código curto; nunca conteúdo). Aba **Consumo de IA** reescrita (`GET /api/usage/me`, `/api/usage/me/calls`: mês ou intervalo de até 24 meses, por finalidade, provedor, modelo e dia, reuniões que mais consumiram, filtro de falhas); **Administração > Uso de IA** (`GET /api/admin/usage`, permissão nova `ai_usage.read`, agregado por usuário sem dado de reunião); aba **Segurança** (`GET /api/audit/me`) e **Administração > Auditoria** (`GET /api/admin/audit`, `audit.read`, projeção por lista permitida de campos). Login, falha de login (IP só na falha), logout e troca de senha passam a ser auditados; os envios externos gravam o dono. Retenção (constituição 2.3.0): `USAGE_RETENTION_DAYS=730` e `AUDIT_RETENTION_DAYS=365`, poda diária (`0` = guardar sempre). `GET /api/llm/usage` foi removido (substituído por `/api/usage/me`); o histórico `external_*` do `audit_log` é incorporado uma vez, de forma idempotente. Migração aditiva: tabela `ai_usage_logs` e índice `idx_audit_target`. **Implantação:** backup do Postgres, backend ocioso e confirmação antes de aplicar.
- Minhas pendências e tarefas (F4, `specs/002-pendencias-tarefas`): menu **Minhas pendências** com tarefas **pessoais** (`tasks.read` e `tasks.manage`; Leitor sem as duas; administrador não lê tarefa alheia). Aprovar uma pendência cria a tarefa de quem aprovou (sem duplicar: uma tarefa por item e por pessoa) quando o responsável é o aprovador ou está vazio; **Virar tarefa** em qualquer item aprovado (`POST /api/tasks/from-item`); tarefa manual, status (a fazer, em andamento, bloqueada, concluída, cancelada), prioridade, prazo (data civil no fuso do usuário; prazo dito vira data só quando inequívoco), projeto, responsável (eu, outra pessoa, não confirmado), histórico antes/depois, contadores e filtros na URL (`GET /api/tasks`, `/api/tasks/summary`, `/api/meetings/:id/tasks`), cartão na tela Hoje. Reunião compartilhada: cada destinatário cria as próprias tarefas; revogar o acesso ou excluir a reunião mantém a tarefa sem o vínculo. `POST /api/items/:id/approve` ganha `task` e `taskNotice`. Migração aditiva: tabelas `tasks` e `task_history`. **Implantação:** fazer backup do Postgres, aplicar com o backend ocioso (sem reunião em processamento) e só depois de confirmar; a migração roda no boot e não cria tarefas retroativas.
- host-agent: o heartbeat deixava de ser enviado em silêncio (UI "Agente do desktop: Offline" com o processo vivo). Uma exceção no ciclo (resposta inválida, falha ao salvar o cache, `converge`) matava a task do laço sem log, porque as tasks nunca eram aguardadas. Agora cada iteração dos laços (heartbeat, status dos CLIs, geração, alertas) trata e loga a exceção com traceback e segue no próximo ciclo; heartbeat e `converge` têm teto de tempo (15 s e 30 s) e o `notify-send` tem 10 s; tasks avulsas (alertas, conflito, spools) logam falhas; se um laço terminar fora do encerramento o agente loga em CRITICAL e sai com código 1 para o systemd (`Restart=on-failure`) reiniciar; WARNING se o último heartbeat bem-sucedido tiver mais de 15 s (no máximo 1 por minuto).
- Compartilhamento de reunião: o dono compartilha com outro usuário (leitura ou edição) pela página da reunião, vê quem tem acesso, troca o nível e revoga, com efeito imediato inclusive no WebSocket (`meeting_access`). Filtros Todas, Minhas, Compartilhadas comigo e Compartilhadas por mim, selo com nível e dono, marca "Nova" e aviso na tela; "Sair desta reunião"; "esta e as próximas" em séries (sem herança para ocorrências futuras). Busca de usuário mínima (`GET /users/lookup`, 3 letras, até 8, limite de taxa). Só o dono vê a lista de acessos. Auditoria `meeting_share_*` só com ids. O consumo de IA (`/llm/usage`) passou a mostrar só as reuniões do próprio usuário. Migração aditiva: `meeting_shares.seen_at` e `updated_at`.
- Sem agenda no fim de semana (`WORKING_DAYS`, padrão `1,2,3,4,5`, dias ISO no fuso `APP_TIMEZONE`): séries não geram ocorrência em dia não útil (recorrência do cadastro manual e sua extensão, RRULE do `.ics` e `recurring: true` na Aurora, que lista o evento em `ignoredEvents` com `reason: "non_working_day"` e nunca cancela linha existente por isso). Reunião avulsa em dia não útil continua na agenda, mas sem lembrete (host-agent: `AgentMeeting.noAlerts`) e sem entrada/gravação automática; "Enviar assistente agora", "Gravar agora" ou o novo "Avisar e gravar neste dia" (`POST /api/meetings/:id/auto-off-day`, coluna `meetings.auto_on_off_day`) a ligam. `MeetingSummary` ganha `offDay` e `autoOnOffDay`. Ocorrências já existentes em fim de semana deixam de disparar, sem apagar histórico.
- Agenda da Aurora: remarcar no mesmo dia uma ocorrência de série (ex.: 10h para 15h) atualiza a reunião existente em vez de cancelar e criar outra, e preserva Não gravar, Gerar itens, projeto e descrição. Envios simultâneos do mesmo dia deixam de falhar com erro 500 (serializados por lock de transação).
- Agenda do dia enviada pela Aurora (assistente externo, a partir do Outlook): `POST /api/agent/calendar/import` com `Authorization: Bearer $AGENT_TOKEN`, em nome do `AGENT_OWNER`. Idempotente (mesmo `uid` + início não duplica), cancela as reuniões do mesmo dia que sumiram da lista e não mexe em outros dias, em reuniões manuais nem nas escolhas do usuário (Não gravar, Gerar itens). Novas colunas `meetings.import_source` e `import_removed_at`. Evento único tem a mesma chave do `.ics` (não duplica nos dois sentidos) e a sequência do convite não bloqueia nem é rebaixada; só cancela por sumiço reunião futura `scheduled`/`skipped`; lista vazia só limpa o dia com `confirmEmpty: true` (resposta `removalSkipped`); evento fora do dia é ignorado (`ignoredEvents`) sem derrubar o envio; falhas auditadas sem conteúdo; `.ics` limitado a 150 000 caracteres.
- Itens (decisões, pendências, riscos, requisitos, ADRs) só são gerados após você ligar "Gerar itens" na reunião; o padrão é desligado, e a ata sai só com o resumo.
- Conta do agente no Teams (Configurações > Meu agente): o assistente entra logado com uma conta Microsoft dedicada, em vez de convidado sem conta. Sessão gerada por `npm run teams:login`, guardada cifrada, sem senha; o nome da conta precisa dizer que é a ata (constituição 2.2.0). O sistema lê o nome real da conta na sessão e recusa conta de pessoa.
- Com a conta do agente, o assistente espera até 120 s para chegar à tela de entrada (o Teams logado carrega mais devagar).
- Perfil ganha o campo e-mail: o convite do dono deixa de aparecer duplicado ao lado do canal do microfone na ata e na lista de participantes da análise.
- O assistente repete a abertura do link da reunião quando a rede cai (`ERR_TIMED_OUT` etc.), e o auto-assistente reenvia sozinho reuniões que falharam por rede.

### [1.0.1] — 2026-09-18

- `.env.example`: o exemplo de `USER_DISPLAY_NAME` passa a indicar o nome de quem usa o sistema, não o do agente.

### [1.0.0] — 2026-09-18

Primeira versão pública.

- **Agenda:** importação de convites `.ics` (Outlook, Teams, Google) com recorrência, e cadastro
  manual. A importação avisa quando o arquivo traz só a ocorrência do dia, sem a série.
- **Alertas no desktop** 15, 5 e 1 minuto antes, pelo host-agent nativo.
- **Assistente na chamada:** no horário, entra no Teams/Meet de cada reunião da agenda e grava, mesmo
  sem você na chamada. O nome dele diz que é a ata. Sai sozinho quando a chamada termina, quando fica
  sozinho ou com silêncio depois do fim previsto.
- **Transcrição** ao vivo e passe final com Whisper na GPU, com separação de falantes.
- **Agente arquiteto:** extrai decisões, pendências, riscos e requisitos com o trecho de origem; gera
  a ata em 19 seções e sugestões de ADR. Tudo nasce proposto até a revisão humana.
- **Multiusuário:** papéis, isolamento por dono e auditoria de ações administrativas.
- **Opcionais (desligados por padrão):** ASR externo (Deepgram via OpenRouter), LLM externo
  (OpenRouter) e a assinatura pessoal do Claude Code/Codex para ata e ADR.
- **Consumo de IA:** tokens e custo por mês, provedor, modelo e reunião.
- **Servidor de teste** com Dokploy (`docker-compose.vps.yml`).
- Licença AGPL-3.0-or-later.

---

## English

### [Unreleased]

- AI usage and cost and visible audit (F6, `specs/004-uso-custo`): every LLM call (local, OpenRouter, subscription) and every ASR pass (final Whisper, aggregated live, Deepgram) becomes a row in `ai_usage_logs` (purpose, provider, model, tokens, audio minutes, provider-reported cost, time, attempts, result with a short code; never content). Rewritten **Consumo de IA** tab (`GET /api/usage/me`, `/api/usage/me/calls`: month or a free range up to 24 months, by purpose, provider, model and day, top meetings, failures filter); **Administration > Uso de IA** (`GET /api/admin/usage`, new `ai_usage.read` permission, per-user aggregate with no meeting data); **Segurança** tab (`GET /api/audit/me`) and **Administration > Auditoria** (`GET /api/admin/audit`, `audit.read`, allow-list projection). Sign-in, failed sign-in (IP only on failures), sign-out and password change are now audited; external sends record the owner. Retention (constitution 2.3.0): `USAGE_RETENTION_DAYS=730` and `AUDIT_RETENTION_DAYS=365`, daily pruning (`0` = keep forever). `GET /api/llm/usage` was removed (replaced by `/api/usage/me`); old `external_*` history in `audit_log` is incorporated once, idempotently. Additive migration: `ai_usage_logs` table and `idx_audit_target` index. **Rollout:** Postgres backup, idle backend and confirmation before applying.
- My tasks (F4, `specs/002-pendencias-tarefas`): **Minhas pendências** menu with **personal** tasks (`tasks.read` and `tasks.manage`; Viewer has neither; administrators cannot read someone else's task). Approving a pending item creates the approver's task (no duplicates: one task per item and per person) when the owner is the approver or empty; **Virar tarefa** on any approved item (`POST /api/tasks/from-item`); manual tasks, status (to do, in progress, blocked, done, cancelled), priority, due date (civil date in the user's timezone; a spoken due date becomes a date only when unambiguous), project, owner (me, someone else, unconfirmed), before/after history, counters and URL filters (`GET /api/tasks`, `/api/tasks/summary`, `/api/meetings/:id/tasks`), card on the Today screen. Shared meeting: each recipient creates their own tasks; revoking access or deleting the meeting keeps the task without the link. `POST /api/items/:id/approve` gains `task` and `taskNotice`. Additive migration: `tasks` and `task_history` tables. **Deployment:** back up Postgres, apply with the backend idle (no meeting processing) and only after confirming; the migration runs at boot and creates no retroactive tasks.
- host-agent: the heartbeat could stop silently (UI showed "Desktop agent: Offline" while the process was alive). An exception in the cycle (invalid response, cache write failure, `converge`) killed the loop task with no log because tasks were never awaited. Now every iteration of the loops (heartbeat, CLI status, generation, alerts) catches and logs the exception with a traceback and continues next cycle; heartbeat and `converge` have time limits (15 s and 30 s) and `notify-send` 10 s; fire-and-forget tasks (alerts, conflict, spools) log failures; if a loop ends outside shutdown the agent logs CRITICAL and exits with code 1 so systemd (`Restart=on-failure`) restarts it; WARNING when the last successful heartbeat is older than 15 s (at most once a minute).
- Meeting sharing: the owner shares with another user (read or edit) from the meeting page, sees who has access, changes the level and revokes, taking effect immediately including on the WebSocket (`meeting_access`). Filters All, Mine, Shared with me and Shared by me, a badge with level and owner, a "Nova" (new) mark and an on-screen notice; "Leave this meeting"; "this and the following" for series (no inheritance for future occurrences). Minimal user lookup (`GET /users/lookup`, 3 letters, up to 8, rate limited). Only the owner sees the access list. `meeting_share_*` audit with ids only. AI usage (`/llm/usage`) now shows only the user's own meetings. Additive migration: `meeting_shares.seen_at` and `updated_at`.
- No agenda on weekends (`WORKING_DAYS`, default `1,2,3,4,5`, ISO days in the `APP_TIMEZONE` timezone): series generate no occurrence on a non-working day (manual recurrence and its extension, `.ics` RRULE and `recurring: true` from Aurora, which lists the event in `ignoredEvents` with `reason: "non_working_day"` and never cancels an existing row because of it). A single meeting on a non-working day stays in the agenda but with no reminder (host-agent: `AgentMeeting.noAlerts`) and no automatic joining/recording; "Send assistant now", "Record now" or the new "Remind and record on this day" (`POST /api/meetings/:id/auto-off-day`, column `meetings.auto_on_off_day`) turn them on. `MeetingSummary` gains `offDay` and `autoOnOffDay`. Existing weekend occurrences stop firing, without deleting history.
- Aurora agenda: rescheduling a series occurrence within the same day (e.g. 10am to 3pm) now updates the existing meeting instead of canceling it and creating another, keeping do-not-record, generate items, project and description. Simultaneous uploads for the same day no longer fail with a 500 (serialized by a transaction lock).
- Daily agenda sent by Aurora (external assistant, from Outlook): `POST /api/agent/calendar/import` with `Authorization: Bearer $AGENT_TOKEN`, on behalf of `AGENT_OWNER`. Idempotent (same `uid` + start never duplicates), cancels same-day meetings that disappeared from the list, and leaves other days, manual meetings and the user's choices (do not record, generate items) alone. New columns `meetings.import_source` and `import_removed_at`. A single event has the same key as an `.ics` (no duplicates either way) and the invite sequence neither blocks nor gets lowered; only future `scheduled`/`skipped` meetings are canceled when missing; an empty list only clears the day with `confirmEmpty: true` (`removalSkipped` in the response); an event outside the day is ignored (`ignoredEvents`) without failing the upload; failures are audited without content; `.ics` capped at 150,000 characters.
- Items (decisions, action items, risks, requirements, ADRs) are only generated after you turn on "Gerar itens" in the meeting; off by default, and the minutes carry only the summary.
- Agent account on Teams (Configurações > Meu agente): the assistant joins signed in with a dedicated Microsoft account instead of as a guest with no account. Session generated by `npm run teams:login`, stored encrypted, no password; the account name must say it is the minutes (constitution 2.2.0). The system reads the account's real name from the session and rejects a person's account.
- With the agent account, the assistant waits up to 120 s to reach the join screen (signed-in Teams loads more slowly).
- Profile gains an email field: the owner's invite no longer shows up twice next to the microphone channel in the minutes and in the analysis participant list.
- The assistant retries opening the meeting link when the network drops (`ERR_TIMED_OUT`, etc.), and the auto-assistant resends meetings that failed because of the network.

### [1.0.1] — 2026-09-18

- `.env.example`: the `USER_DISPLAY_NAME` example now points to the name of the person using the system, not the agent's.

### [1.0.0] — 2026-09-18

First public release.

- **Calendar:** `.ics` invite import (Outlook, Teams, Google) with recurrence, plus manual entry. The
  import warns when a file carries only one occurrence instead of the whole series.
- **Desktop alerts** 15, 5 and 1 minute before, through the native host-agent.
- **In-call assistant:** at the scheduled time it joins the Teams/Meet call of each calendar meeting
  and records, even when you are not there. Its name says it is taking the minutes. It leaves on its
  own when the call ends, when it is alone, or after silence past the scheduled end.
- **Transcription:** live and a final pass with Whisper on the GPU, with speaker separation.
- **Architect agent:** extracts decisions, action items, risks and requirements with their source
  excerpt; generates 19-section minutes and ADR suggestions. Everything starts as proposed until a
  human reviews it.
- **Multi-user:** roles, per-owner isolation and an audit log of administrative actions.
- **Optional (off by default):** external ASR (Deepgram via OpenRouter), external LLM (OpenRouter)
  and the owner's personal Claude Code/Codex subscription for minutes and ADRs.
- **AI usage:** tokens and cost per month, provider, model and meeting.
- **Test server** with Dokploy (`docker-compose.vps.yml`).
- AGPL-3.0-or-later license.

---

## Español

### [Sin publicar]

- Uso y costo de IA y auditoría visible (F6, `specs/004-uso-custo`): cada llamada de LLM (local, OpenRouter, suscripción) y cada pase de ASR (Whisper final, en vivo agregado, Deepgram) se vuelve una fila en `ai_usage_logs` (finalidad, proveedor, modelo, tokens, minutos de audio, costo informado por el proveedor, tiempo, intentos, resultado con código corto; nunca contenido). Pestaña **Consumo de IA** reescrita (`GET /api/usage/me`, `/api/usage/me/calls`: mes o rango libre de hasta 24 meses, por finalidad, proveedor, modelo y día, reuniones que más consumieron, filtro de fallos); **Administración > Uso de IA** (`GET /api/admin/usage`, permiso nuevo `ai_usage.read`, agregado por usuario sin datos de reunión); pestaña **Segurança** (`GET /api/audit/me`) y **Administración > Auditoria** (`GET /api/admin/audit`, `audit.read`, proyección por lista permitida). Entrada, entrada fallida (IP solo en el fallo), salida y cambio de contraseña pasan a auditarse; los envíos externos guardan al dueño. Retención (constitución 2.3.0): `USAGE_RETENTION_DAYS=730` y `AUDIT_RETENTION_DAYS=365`, poda diaria (`0` = guardar siempre). `GET /api/llm/usage` fue eliminado (reemplazado por `/api/usage/me`); el historial `external_*` del `audit_log` se incorpora una vez, de forma idempotente. Migración aditiva: tabla `ai_usage_logs` e índice `idx_audit_target`. **Despliegue:** respaldo de Postgres, backend ocioso y confirmación antes de aplicar.
- Mis tareas (F4, `specs/002-pendencias-tarefas`): menú **Minhas pendências** con tareas **personales** (`tasks.read` y `tasks.manage`; Lector no tiene ninguna; el administrador no lee tareas ajenas). Aprobar un pendiente crea la tarea de quien aprobó (sin duplicar: una tarea por ítem y por persona) cuando el responsable es quien aprueba o está vacío; **Virar tarefa** en cualquier ítem aprobado (`POST /api/tasks/from-item`); tarea manual, estado (por hacer, en curso, bloqueada, concluida, cancelada), prioridad, plazo (fecha civil en la zona del usuario; un plazo dicho se vuelve fecha solo si es inequívoco), proyecto, responsable (yo, otra persona, no confirmado), historial antes/después, contadores y filtros en la URL (`GET /api/tasks`, `/api/tasks/summary`, `/api/meetings/:id/tasks`), tarjeta en la pantalla Hoy. Reunión compartida: cada destinatario crea sus propias tareas; revocar el acceso o eliminar la reunión mantiene la tarea sin el vínculo. `POST /api/items/:id/approve` gana `task` y `taskNotice`. Migración aditiva: tablas `tasks` y `task_history`. **Despliegue:** hacer copia de seguridad de Postgres, aplicar con el backend inactivo (sin reunión en procesamiento) y solo tras confirmar; la migración corre al arrancar y no crea tareas retroactivas.
- host-agent: el heartbeat podía dejar de enviarse en silencio (la UI mostraba "Agente del escritorio: Offline" con el proceso vivo). Una excepción en el ciclo (respuesta inválida, fallo al guardar la caché, `converge`) mataba la task del bucle sin log, porque las tasks nunca se esperaban. Ahora cada iteración de los bucles (heartbeat, estado de los CLI, generación, alertas) captura y registra la excepción con traceback y sigue en el próximo ciclo; heartbeat y `converge` tienen tiempo límite (15 s y 30 s) y `notify-send` 10 s; las tareas sueltas (alertas, conflicto, spools) registran fallos; si un bucle termina fuera del apagado, el agente registra CRITICAL y sale con código 1 para que systemd (`Restart=on-failure`) lo reinicie; WARNING si el último heartbeat correcto tiene más de 15 s (como máximo una vez por minuto).
- Compartir reunión: el dueño comparte con otro usuario (lectura o edición) desde la página de la reunión, ve quién tiene acceso, cambia el nivel y revoca, con efecto inmediato incluso en el WebSocket (`meeting_access`). Filtros Todas, Minhas, Compartilhadas comigo y Compartilhadas por mim, insignia con nivel y dueño, marca "Nova" y aviso en pantalla; "Sair desta reunião"; "esta y las siguientes" en series (sin herencia para ocurrencias futuras). Búsqueda mínima de usuario (`GET /users/lookup`, 3 letras, hasta 8, límite de tasa). Solo el dueño ve la lista de acceso. Auditoría `meeting_share_*` solo con ids. El consumo de IA (`/llm/usage`) ahora muestra solo las reuniones del propio usuario. Migración aditiva: `meeting_shares.seen_at` y `updated_at`.
- Sin agenda el fin de semana (`WORKING_DAYS`, por defecto `1,2,3,4,5`, días ISO en la zona `APP_TIMEZONE`): las series no generan ocurrencias en días no laborables (recurrencia del registro manual y su extensión, RRULE del `.ics` y `recurring: true` de Aurora, que lista el evento en `ignoredEvents` con `reason: "non_working_day"` y nunca cancela una fila existente por eso). Una reunión única en día no laborable sigue en la agenda, pero sin recordatorio (host-agent: `AgentMeeting.noAlerts`) y sin entrada/grabación automática; "Enviar asistente ahora", "Grabar ahora" o el nuevo "Avisar y grabar este día" (`POST /api/meetings/:id/auto-off-day`, columna `meetings.auto_on_off_day`) la activan. `MeetingSummary` gana `offDay` y `autoOnOffDay`. Las ocurrencias de fin de semana ya existentes dejan de dispararse, sin borrar historial.
- Agenda de Aurora: reprogramar en el mismo día una ocurrencia de serie (p. ej. de 10h a 15h) actualiza la reunión existente en vez de cancelarla y crear otra, y conserva no grabar, generar ítems, proyecto y descripción. Los envíos simultáneos del mismo día ya no fallan con un 500 (serializados por un lock de transacción).
- Agenda del día enviada por Aurora (asistente externo, desde Outlook): `POST /api/agent/calendar/import` con `Authorization: Bearer $AGENT_TOKEN`, a nombre de `AGENT_OWNER`. Idempotente (mismo `uid` + inicio no duplica), cancela las reuniones del mismo día que desaparecieron de la lista y no toca otros días, reuniones manuales ni las elecciones del usuario (no grabar, generar ítems). Columnas nuevas `meetings.import_source` y `import_removed_at`. Un evento único tiene la misma clave que un `.ics` (no duplica en ningún sentido) y la secuencia de la invitación ni bloquea ni se rebaja; solo se cancelan por ausencia reuniones futuras `scheduled`/`skipped`; una lista vacía solo limpia el día con `confirmEmpty: true` (`removalSkipped` en la respuesta); un evento fuera del día se ignora (`ignoredEvents`) sin tumbar el envío; los fallos se auditan sin contenido; `.ics` limitado a 150 000 caracteres.
- Los ítems (decisiones, pendientes, riesgos, requisitos, ADR) solo se generan después de activar "Gerar itens" en la reunión; viene desactivado y el acta trae solo el resumen.
- Cuenta del agente en Teams (Configurações > Meu agente): el asistente entra con sesión iniciada con una cuenta Microsoft dedicada, en vez de invitado sin cuenta. Sesión generada con `npm run teams:login`, guardada cifrada, sin contraseña; el nombre de la cuenta debe decir que es el acta (constitución 2.2.0). El sistema lee el nombre real de la cuenta en la sesión y rechaza la cuenta de una persona.
- Con la cuenta del agente, el asistente espera hasta 120 s para llegar a la pantalla de entrada (Teams con sesión carga más lento).
- El perfil suma el campo correo: la invitación del dueño deja de aparecer duplicada junto al canal del micrófono en el acta y en la lista de participantes del análisis.
- El asistente reintenta abrir el enlace de la reunión cuando la red se cae (`ERR_TIMED_OUT`, etc.), y el auto-asistente reenvía las reuniones que fallaron por la red.

### [1.0.1] — 2026-09-18

- `.env.example`: el ejemplo de `USER_DISPLAY_NAME` ahora indica el nombre de quien usa el sistema, no el del agente.

### [1.0.0] — 2026-09-18

Primera versión pública.

- **Agenda:** importación de invitaciones `.ics` (Outlook, Teams, Google) con recurrencia, y registro
  manual. La importación avisa cuando el archivo trae solo la ocurrencia del día, sin la serie.
- **Alertas en el escritorio** 15, 5 y 1 minuto antes, a través del host-agent nativo.
- **Asistente en la llamada:** a la hora, entra al Teams/Meet de cada reunión de la agenda y graba,
  aunque no estés. Su nombre dice que está tomando el acta. Sale solo cuando la llamada termina,
  cuando queda solo o con silencio después del fin previsto.
- **Transcripción** en vivo y pase final con Whisper en la GPU, con separación de hablantes.
- **Agente arquitecto:** extrae decisiones, pendientes, riesgos y requisitos con el fragmento de
  origen; genera el acta en 19 secciones y sugerencias de ADR. Todo nace propuesto hasta la revisión
  humana.
- **Multiusuario:** roles, aislamiento por dueño y auditoría de acciones administrativas.
- **Opcionales (apagados por defecto):** ASR externo (Deepgram vía OpenRouter), LLM externo
  (OpenRouter) y la suscripción personal de Claude Code/Codex para actas y ADR.
- **Consumo de IA:** tokens y costo por mes, proveedor, modelo y reunión.
- **Servidor de pruebas** con Dokploy (`docker-compose.vps.yml`).
- Licencia AGPL-3.0-or-later.

[1.0.1]: https://github.com/salexcarvalho/meeting-bot/releases/tag/v1.0.1
[1.0.0]: https://github.com/salexcarvalho/meeting-bot/releases/tag/v1.0.0
