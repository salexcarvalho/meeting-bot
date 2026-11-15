# Meeting Agent (meeting-bot)

[Português](README.md) · **English** · [Español](README.es.md)

**Local** meeting and software architecture agent. It:

- brings the day's agenda via `.ics` invites or manual registration;
- alerts on the desktop 15, 5, and 1 minute before each meeting;
- at the scheduled time, sends the **assistant** into the call (Teams/Meet), which records even if you don't join;
- transcribes live and, at the end, produces a better final transcription, with speaker diarization;
- extracts decisions, pending items, risks, and requirements, always with the source excerpt, in the meetings where you turn on the **Itens** ("Items") switch (off by default);
- generates the meeting minutes (19-section template; just the summary when items are off) and ADR suggestions;
- leaves everything as **proposed** until you review it.

Everything runs on the machine: Whisper (faster-whisper) and LLM (Ollama, `qwen3.5:4b`) on the local GPU. The
only exception is the **test external ASR**, which is off by default
([see below](#test-external-asr-optional)).

The **audio/video upload** and **Agent Mode**, where a guest bot joins Meet/Teams, are also still
available.

- MVP specification: [specs/001-agente-reunioes-mvp/spec.md](specs/001-agente-reunioes-mvp/spec.md)
- Plan, contracts, and validation: [specs/001-agente-reunioes-mvp/](specs/001-agente-reunioes-mvp/)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Project constitution: [.specify/memory/constitution.md](.specify/memory/constitution.md)

## Architecture at a Glance

```text
 Ubuntu (host)                                Docker Engine nativo (GPU)
┌──────────────────────────┐   heartbeat 5 s  ┌────────────────────────────────────────┐
│ host-agent (systemd)     │ ───────────────► │ backend (Node 24) :3000                │
│  alertas, som, xdg-open  │   WS PCM 16 kHz  │  agenda, gravação, agente, ata, UI     │
│  parec: mic + monitor    │ ───────────────► │   │            │             │         │
└──────────────────────────┘                  │ postgres   worker-gpu      ollama      │
 navegador → http://127.0.0.1:3000            │            (whisper,       (qwen3.5:4b)│
                                              │             pyannote)                  │
                                              └────────────────────────────────────────┘
```

| Folder | Content |
|---|---|
| `apps/backend` | API, WebSockets, recording scheduler, architect agent, meeting minutes, Agent Mode (Playwright) |
| `apps/frontend` | React UI (Today, Meetings, Meeting, Projects) |
| `apps/worker-gpu` | FastAPI with faster-whisper and pyannote |
| `apps/host-agent` | Desktop service: alerts, PipeWire capture, audio upload, and generation with your subscription (Claude Code/Codex) |
| `packages/contracts` | Shared types and schemas |

## Requirements

- Ubuntu with a graphical session (GNOME), PipeWire, and an NVIDIA GPU (measured on an RTX 4050, 6 GB)
- **Native Docker Engine** + NVIDIA Container Toolkit (Docker Desktop can't see the GPU or audio)
- `uv`, `parec`/`pactl`, `notify-send`, `zenity`, `canberra-gtk-play`, and `xdg-open` on the host

## Installation

```bash
sudo bash scripts/setup-host.sh          # NVIDIA Container Toolkit + pulseaudio-utils (one time)
cp .env.example .env                     # fill in POSTGRES_PASSWORD and AGENT_TOKEN
export DOCKER_CONTEXT=default            # always the native Engine
docker compose up -d --build
docker compose exec ollama ollama pull qwen3.5:4b
docker compose exec backend npm run user:create -- sergio --role=SUPER_ADMIN
apps/host-agent/install.sh               # desktop service (systemd --user)
```

- Generate `AGENT_TOKEN` with `openssl rand -hex 32`.
- On the first transcription, the worker downloads the Whisper model (~1.6 GB).
- The interface is available at http://127.0.0.1:3000.

### Users and Roles

Each user only sees their own meetings (and the ones shared with them).

Roles:

- **SUPER_ADMIN:** everything;
- **ADMIN:** their own content and management of regular users;
- **USER:** their own content;
- **VIEWER:** read-only.

The backend checks permissions on every route.

When migrating an old database, the oldest user becomes SUPER_ADMIN and the rest become USER.

In the interface, use **Administração > Usuários** ("Administration > Users") (for those with `users.read`). From the command line:

```bash
docker compose exec backend npm run user:create -- socio            # USER role (the 1st user becomes SUPER_ADMIN)
docker compose exec backend npm run user:create -- ana --role=ADMIN
docker compose exec backend npm run user:list
docker compose exec backend npm run user:passwd -- socio   # resets the password and drops the sessions
docker compose exec backend npm run user:delete -- socio
```

### Speaker Diarization (Optional)

1. Accept the terms of
   [`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Create a read token at https://huggingface.co/settings/tokens.
3. Put it in `HF_TOKEN` in `.env` and run `docker compose up -d worker-gpu`.

Without a token, the meeting audio shows up as "Remoto" ("Remote"). The microphone is always you
(`USER_DISPLAY_NAME`). After the first download, the model runs offline.

## Usage

### Today

- **Importar convites** ("Import invites"): in Outlook, save the invite as `.ics` and drag it onto the
  **Hoje** ("Today") screen. Re-importing updates the meeting without duplicating it; a cancellation marks it as canceled.
- **Agenda from Aurora (Outlook)**: the external assistant sends the day's agenda to
  `POST /api/agent/calendar/import` (`AGENT_TOKEN`, on behalf of `AGENT_OWNER`). Same `uid` + start
  updates instead of duplicating (a single event is the same as one from an `.ics`; a series occurrence rescheduled within the day keeps the meeting and its choices); a future same-day meeting
  missing from the list is canceled (it comes back if it reappears), but an empty list only clears the day with
  `confirmEmpty: true` and an event outside the day is skipped without failing the upload. Other days, manual/`.ics` meetings and the user's choices (do not record, generate items) are
  untouched, and the upload enables no extra recording: the usual rules apply. Details in
  [`rest-api.md`](specs/001-agente-reunioes-mvp/contracts/rest-api.md) (Portuguese).
  The same day's agenda can be read with `GET /api/agent/meetings?date=YYYY-MM-DD` (same token; defaults to
  today; read-only, scoped to `AGENT_OWNER`; returns `icalUid`, times, link, platform, "do not record", status and
  `recurring`).
- **Nova reunião** ("New meeting"): manual registration with title, start time, duration, link, and project.
- **No agenda on weekends** (`WORKING_DAYS`, default Monday to Friday, in the agenda timezone): series (manual
  recurrence, `.ics` and Aurora) generate no occurrence on Saturday and Sunday. A single meeting on those days shows
  up in the agenda, but with no reminder and no assistant joining on its own; use **Avisar e gravar neste dia**
  ("Remind and record on this day") on it (or **Enviar assistente agora**).
- The project is **suggested** based on keywords in the title. Confirm it under **Editar** ("Edit").
- **Não gravar** ("Don't record"): available on the screen or in the desktop alert; the assistant doesn't join.
- **Enviar assistente agora** ("Send assistant now"): sends the assistant before the scheduled time, or again after a failure.
- **Gravar agora** ("Record now"): only for meetings without a link; records via the computer (microphone and PC audio).

### During the Meeting

- At the scheduled time, the **assistant** joins every meeting with a Teams/Meet link that isn't marked
  "Não gravar" ("Don't record"), with the configured name, which already says it is the minutes (e.g., "Ata do Sérgio"). Admit it from the waiting room.
  - It joins muted and without a camera; the meeting shows the initials of the name (guests have no photo).
  - If the network drops while opening the link, it retries (3 attempts). A meeting that failed only because of the network is resent automatically, within the scheduled time, up to 3 times with 1 min between them.
  - The transcription appears live on the meeting page, along with the architect agent and the running summary.
  - It waits to be admitted until the scheduled end time and doesn't leave for being alone before then.
  - It leaves when the call ends, when it's alone on the call for 5 min (counting the people in the
    Teams/Meet bar) past the scheduled end time, when it goes past the scheduled end time with 3 min of no sound,
    on **Parar** ("Stop"), or at 4 h. With no scheduled time (assistant sent manually), it leaves after 10 min of no sound.
  - If the backend restarts midway and it's still within the scheduled time, it joins again.
  - The computer doesn't record on its own (`AUTO_LOCAL_RECORDING=false`); a meeting without a link isn't recorded,
    except via **Gravar agora**.
- Recording via the computer stops when the scheduled time has passed and there have been 3 min without speech, on
  clicking **Parar**, or upon reaching 4 h.
- The **Ao vivo** ("Live") tab shows the transcription (a few seconds of delay), the channel status, the GPU,
  the running summary, and the item panels. With **Itens** off, live extraction does not run.
- Clicking a timestamp or an item's evidence jumps to the excerpt and plays the audio.

### After the Meeting

- The final transcription replaces the live one. Item evidence is remapped.
- The agent re-analyzes the meeting, consolidates the items, and generates the meeting minutes and suggested ADRs. With **Itens** off, it produces only the summary (no items or ADRs).
- **Itens** ("Items"): approve, reject, reopen, edit, and view the history. Manually created items are already
  born approved. The history is a timeline: who did what and when, with the previous text
  struck through on edits.
- **Ata** ("Meeting minutes"): always assembled from the current state of the items. Rejected ones disappear and proposed ones appear
  flagged. It can be copied or downloaded as `.md`.
  - On the screen, date, time, duration, project, and participants sit in a card at the top; there's an index
    of the sections, and empty sections appear as a single line. The copied or downloaded `.md` keeps all 19 sections.
- **Resumo para enviar** ("Summary to send") (Ata tab): short text to paste into Teams or email, with objective,
  summary, decisions, architectural decisions, open pending items (owner and deadline), and risks.
  Only approved items are included; the dialog warns how many still-unreviewed items were left out.
- **ADRs**: edit and approve. The final number (`ADR-001`…) is only assigned upon approval.
  - Active, Proposed, Approved, and Rejected filters; the proposed ones come first.
  - Cards stay collapsed, showing the start of the decision ("Expandir todos" ("Expand all") opens them all).
  - The link to the source decision opens the Itens ("Items") tab already on its card.
- **Falantes** ("Speakers"): rename "Speaker 1", etc., on the Transcrição ("Transcript") tab.
- **Reprocessar** ("Reprocess"): redoes the final transcription and the analysis.
- **Items on/off** (switch below the live panel, owner only): decisions, action items, risks,
  requirements and ADRs are only generated in meetings where you turn the switch on. It starts **off**;
  a test-assist or delivery meeting ends up with just the transcript and minutes with the summary.
  - Off: live extraction does not run, and the post-meeting analysis produces only the summary (no items, no ADR).
  - **Gerar itens** ("Generate items") turns the switch on and asks where to generate (local, OpenRouter or subscription), like Gerar ata.
    Turned on mid-meeting, live extraction starts from that point.
  - **Desligar itens** ("Turn items off") deletes nothing: what exists stays, and creating items by hand still works.
  - Meetings that predate this switch and already had items or an analysis are marked as on.
- **Gerar ata** ("Generate meeting minutes") (Ata tab): redoes only the analysis on the final transcription, without transcribing again.
  - Generating again starts from scratch: it deletes the AI-proposed items that no one touched (and the ADRs
    suggested from them). The approved, rejected, edited, and manually created ones remain.
  - Duplicate items are merged automatically. If a new one repeats one already reviewed, it's absorbed by the
    reviewed one (the evidence transfers to the approved one; a duplicate of a rejected one is discarded).
- **Gerar ADRs** ("Generate ADRs") (ADRs tab) and **Gerar ADR** ("Generate ADR") (on each architectural decision, on the Itens ("Items") tab): generate or
  redo the suggested ADRs. ADRs that are approved, rejected, or manually edited aren't overwritten.
- Each button asks where to generate: **modelo local** ("local model"), **OpenRouter**, or **sua assinatura** ("your subscription")
  (Claude Code or Codex), depending on what's enabled. What was generated externally shows up flagged
  ("OpenRouter", "Claude", or "Codex" on the item, the ADR, and the meeting minutes).

### Sharing a meeting

On the meeting page, the owner clicks **Compartilhar** ("Share"), searches for a person by name or username (3 letters minimum) and picks **Leitura** (read) or **Edição** (edit):

- **Read:** the person sees the meeting (link, participants, transcript, audio, items and minutes).
- **Edit:** also edits items, ADRs and speaker names. Recording, stopping, reprocessing, rescheduling, changing the link, "do not record", "no-agenda day", cancelling, generating minutes/ADRs, turning items on and deleting stay owner-only. Users who cannot manage meetings (VIEWER) only receive read access.
- The owner sees **Quem tem acesso** ("Who has access"), changes the level and removes people. It applies immediately, even to someone with the meeting open (the live transcript stops arriving). Only the owner sees the list; a recipient sees their own level and the owner's name.
- For a recurring meeting, the dialog offers **this occurrence only** or **this and the following ones already on the agenda**. Past occurrences are left out and occurrences created later do not inherit access.
- Under **Reuniões**, the filters **Todas** (all), **Minhas** (mine), **Compartilhadas comigo** (shared with me) and **Compartilhadas por mim** (shared by me) (`?escopo=`); a badge with the level and owner, a **Nova** ("New") mark until opened, and an on-screen notice. Nothing leaves the machine (no e-mail).
- **Sair desta reunião** ("Leave this meeting") removes your own access. Admins do not read other people's content, and deactivating the owner does not remove recipients' access.
- Sharing, changing, revoking and leaving are recorded in `audit_log` with ids only (never title or content).

### My tasks (pending items)

**Minhas pendências** menu (`tasks.read`/`tasks.manage`; the Viewer role does not have them). A task is **personal**: only the person who owns it sees or changes it. Administrators and super administrators cannot read someone else's task either.

- **Approving creates a task:** approving a meeting **pending item** (`pendencia`) creates your task, without duplicates (approving again, reopening and approving, or regenerating the minutes keeps a single one). It is only created automatically when the owner is you ("eu", your username or your name) or empty, and then it shows as **Unconfirmed owner**. A pending item that belongs to someone else does not become a task by itself: the notice says whose it is.
- **Turn into task:** on any approved item (risk, requirement, decision...) the button creates the task, with editable title, due date and priority. Proposed or rejected items cannot become tasks. If a similar task already exists in the meeting, the dialog warns and lets you create it anyway.
- **Due date:** it is only filled in when the text is unambiguous (`30/11`, `until 12/5`, `today`, `tomorrow`); "Friday" or "next week" stay as the **spoken due date** next to the field, so you decide.
- **Screen:** clickable counters (open, overdue, due today, unconfirmed owner) and filters by status, project, due date, owner, priority, meeting and search; the filter lives in the URL (`?status=...&prazo=overdue`). Status changes inline. "Today" and "overdue" use the user's timezone.
- **Manual task:** **Nova tarefa** (also inside a meeting) with project, due date, priority and owner; edit, delete and see the history (before and after, who and when).
- **Shared meeting:** whoever received the meeting creates their own tasks from the items they can see. If access is revoked, the task stays, without the link to the meeting, item and audio (what was copied while access existed remains). Deleting the meeting does not delete the tasks.
- **Today screen:** card with overdue, due today, open and proposed pending items to review.
- Nothing leaves the machine and no AI is called. The migration is additive (`tasks`, `task_history`) and does not create tasks from old meetings; use **Virar tarefa**.

### Searching and asking your meetings

**Search** menu (shortcut `Ctrl+K`). Requires `meetings.read`; transcripts also need `transcripts.read`, and minutes, items and ADRs need `documents.read`.

- **Search:** **hybrid** by default (Portuguese full text, accent- and inflection-insensitive, plus **semantic** search by meaning, fused with RRF). Filters by project, period, content type and mode; each result shows the highlighted snippet and whether it was found by text or semantics. Clicking opens the meeting at the segment and time (`?seg=`, `?t=`, `?item=`, `?adr=`) with the audio cued but not playing. Rejected items never appear; proposed items and ADRs appear flagged.
- **Ask:** the **Ask** tab (local RAG). The answer uses only snippets from meetings you can read, each claim carries a clickable citation checked against the snippet, and without evidence the answer is **"I found no record"**. Items and ADRs not yet approved are labeled "proposed by the AI". The conversation history stays in the browser only. The chat **always runs on the local Ollama** (never OpenRouter or a subscription), queues behind the live analysis and, during a live meeting, uses a smaller context and warns it may take longer.
- **Privacy:** permission is applied inside the query itself (owner or share); revoking a share removes the meeting from the results immediately; administrators do not read other people's content; search text, questions, answers and snippets never reach logs or the audit trail. Usage shows in **AI usage** (purposes "Search (embeddings)" and "Chat on meetings").
- **Index:** pgvector in the same Postgres; embeddings (`bge-m3`) run on Ollama **on CPU** (0 MiB of VRAM) and wait while a recording or call is in progress; text search works even with Ollama down. Old meetings are indexed in the background (newest first, resumable after a restart). **Settings > Search** shows the state and **Reindex my meetings**; from the terminal: `docker compose exec backend npm run search:reindex`.
- **Test server (VPS):** text search only; semantic search and chat are off (`SEARCH_SEMANTIC=off`).

### Upload and Agent Mode

In **Reuniões** ("Meetings"):

- upload an audio/video file to transcribe;
- or send the guest assistant to a Meet/Teams link. Admit the assistant from the waiting room.

The meeting screen shows the live steps (the UI is in Portuguese): "Preparando agente" (preparing), "Conectando" (connecting), "Abrindo reunião" (opening the meeting), "Entrando" (joining), "Aguardando admissão" (awaiting admission), "Conectado" (connected).

The same link doesn't receive two assistants at the same time.

On the login screen, the eye icon shows the typed password, and "Esqueceu sua senha?" ("Forgot your password?")
explains the path (an administrator resets it under Configurações > Usuários ("Settings > Users"); alone, use
`npm run user:passwd`). There's no email recovery: nothing leaves the machine.

The name in the room follows **Configurações > Reuniões** ("Settings > Meetings"): my name, the agent's name, or a
custom name. There's no suffix: the name needs to say it's the meeting minutes (e.g., "Ata do Sérgio" ("Sérgio's
minutes")), and a name without "ata" ("minutes"), "gravação" ("recording"), or "transcrição" ("transcript") is
entered as "Ata de <nome>" ("<name>'s minutes"). An anonymous guest has no photo on Meet/Teams: the name's initials
show up. With `BOT_CAMERA=true`, the assistant turns on a virtual camera with the agent's avatar (a still image),
but on the call this becomes a video frame.

**Agent account on Teams** (Configurações > Meu agente, "Settings > My agent"): without it, the assistant joins Teams as a guest with no account, and Teams flags that. With a Microsoft account **dedicated to the agent** (never your own), it joins signed in and shows up under the account's name, which must also say it's the minutes (e.g., "Ata do Sérgio"; the system reads the account's real name from the session and rejects one that doesn't say so, including a person's own account).
1. On the project machine: `npm run teams:login`. In the browser that opens, sign in with the agent's account and choose "Stay signed in"; go back to the terminal and press Enter. This produces the `teams-session.json` file.
2. In My agent, enter the account name and upload the file. Then delete the file: it is as sensitive as a password.
3. The password never goes through the system. Only the session is kept, encrypted (AES-256-GCM, key derived from `AGENT_TOKEN`) and per user; changing `AGENT_TOKEN` means connecting again. On every meeting Teams renews the session and the system stores the new one.
4. A session from a person's account (name without "ata") is rejected; if it was already saved, the screen shows "Não usada" ("Not used") and the assistant joins as a guest.
5. If the session expires, the assistant falls back to guest, the screen shows "Sessão vencida" ("Session expired"), and you repeat step 1. The account only applies to Teams; on Meet the assistant remains a guest.

When the assistant doesn't join, check the screenshot under **Áudio e debug** ("Audio and debug").

### Settings

Each user has their own settings:

- **Perfil** ("Profile"): real name, display name, email, language, timezone, and photo. The email (the same one on your Outlook/Teams invites) recognizes you among the `.ics` participants: your invite is not listed twice next to your microphone channel in the minutes.
- **Meu agente** ("My agent"): architect agent persona, technologies, decision types, base prompt, avatar, spoken name recording, and the agent's Teams account.
- **Reuniões:** identity in the room.
- **Documentação** ("Documentation"): level of detail and formats.
- **Consumo de IA** ("AI usage"): every LLM call (local model, OpenRouter, subscription) and every transcription (local
  Whisper or external Deepgram) is recorded with purpose, provider, model, tokens, audio minutes, time and result
  (failures too, with a short code only). The panel shows the month or a free range (up to 24 months): totals, by
  purpose, provider, model and day, local x external ASR minutes, the meetings that consumed the most and the latest
  calls, with a failures filter. The cost is what the provider reported (never estimated): the subscription and the
  local model show "sem custo por chamada" (no cost per call). It is read-only and doesn't block generation. Each person
  sees only the usage of the meetings they created: the cost is the owner's, and a shared meeting does not count.
- **Segurança** ("Security"): the events that concern you (sign-ins and refused attempts, with the IP only on refusals,
  password change, Teams account, administrator actions on your account and anything sent off the machine on your
  behalf), without meeting content.
- **Administration > Uso de IA** (`ai_usage.read`) shows usage aggregated by user, provider, model, purpose and day,
  with no meeting title or id; **Administration > Auditoria** (`audit.read`) shows system events, always through an
  allow-list of fields.
- **Retention:** AI usage is kept for 24 months (`USAGE_RETENTION_DAYS=730`) and the audit log for 12 months
  (`AUDIT_RETENTION_DAYS=365`), pruned daily; `0` keeps everything. Audio stays indefinite.

## Main Configuration (`.env`)

| Variable | Default | Usage |
|---|---|---|
| `AGENT_TOKEN` | — | Secret shared with the host-agent (≥ 32 characters) |
| `USER_DISPLAY_NAME` | `Sérgio` | Microphone channel name |
| `APP_TIMEZONE` | `America/Sao_Paulo` | Timezone for the agenda and the meeting minutes |
| `WORKING_DAYS` | `1,2,3,4,5` | Days with an agenda (ISO, 1 = Monday … 7 = Sunday). Outside them there is no reminder or automatic recording |
| `ASR_MODEL` / `ASR_COMPUTE_TYPE` | `large-v3-turbo` / `int8_float16` | Whisper on the worker |
| `HF_TOKEN` | empty | Speaker diarization |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Local LLM |
| `SEARCH_ENABLED` / `SEARCH_SEMANTIC` | `true` / `auto` | Turns search on; `auto`/`on` require pgvector (boot fails with a clear message without it), `off` = text only |
| `EMBED_MODEL` / `EMBED_DIM` | `bge-m3` / `1024` | Embedding model (Ollama, on CPU) and the `vector` column dimension |
| `EMBED_KEEP_ALIVE` / `EMBED_BATCH` | `10m` / `16` | How long the model stays in RAM and texts per request |
| `SEARCH_INDEX_DEBOUNCE_SECONDS` | 20 | Groups nearby edits before reindexing the meeting |
| `CHAT_MIN_SIMILARITY` | `0.45` | Minimum relevance for the chat to answer (below it: "no record found") |
| `CHAT_MAX_CONTEXT_TOKENS` / `CHAT_MAX_CONTEXT_TOKENS_LIVE` | 3500 / 2000 | Chat context (normal / with a live meeting) |
| `LIVE_EXTRACT_MIN_SPEECH_SECONDS` | 90 | Live extraction every N s of new speech… |
| `LIVE_EXTRACT_MAX_INTERVAL_SECONDS` | 180 | …or at most every M s |
| `LIVE_CONSOLIDATE_INTERVAL_SECONDS` | 900 | Running summary and deduplication |
| `SILENCE_STOP_SECONDS` / `MAX_RECORDING_MINUTES` | 180 / 240 | Stop rules |
| `AGENT_OWNER` | empty | User whose meetings this machine's host-agent records (empty = first registered user, if still an active SUPER_ADMIN; always set it when there's more than one user) |
| `DEFAULT_AGENT_NAME` | `Assistente` | Initial agent name for each user |
| `BOT_JOIN_TIMEOUT_SECONDS` | 45 | Time limit for the assistant to reach the room or the waiting area (at least 120 s with the agent's Teams account) |
| `BOT_SILENCE_STOP_MINUTES` | 10 | Silence that ends a meeting with no scheduled time |
| `BOT_CAMERA` | `false` | Virtual camera with the agent's avatar (still image; becomes a video frame on the call) |
| `BOT_LIVE_TRANSCRIPTION` | `true` | Live transcription of the audio recorded by the assistant |
| `MAX_AVATAR_KB` / `MAX_VOICE_KB` / `MAX_VOICE_SECONDS` | 2048 / 4096 / 60 | Profile file limits |
| `EGRESS_ALLOWLIST` | `ollama,worker-gpu,localhost,127.0.0.1` | Hosts the backend can access |

### Test External ASR (Optional)

To compare quality, the final pass and uploads can use **Deepgram nova-3 via
OpenRouter**.

> **Warning:** with this option, the **audio leaves the machine**. Only use it with audio that your
> organization's policy allows sending to third parties. The live transcription and the entire LLM
> remain local.

```bash
# .env
ALLOW_EXTERNAL_ASR=true
OPENROUTER_API_KEY=sk-or-...          # https://openrouter.ai/settings/keys
ASR_PROVIDER=local                    # default; "openrouter" uses Deepgram on every final pass
OPENROUTER_STT_MODEL=deepgram/nova-3
```

Then, `docker compose up -d backend`.

- The per-meeting choice appears on **upload** and under **Reprocessar**.
- A meeting transcribed externally shows a warning.
- Each submission is logged in `audit_log` (`external_asr`), without content.
- Egress only allows `https://openrouter.ai/api/v1/audio/transcriptions`.
- Speakers are renumbered every 20 min of audio, because the provider doesn't keep identity
  across requests.

### External LLM (Optional)

The meeting minutes and ADRs can be generated by an **OpenRouter** model (better quality than the local
4B, with a cost per use).

> **Warning:** with this option, the **entire meeting transcription leaves the machine**. Only use it
> with content that your organization's policy allows sending to third parties. The live analysis
> always remains local.

```bash
# .env
ALLOW_EXTERNAL_LLM=true
OPENROUTER_API_KEY=sk-or-...                    # the same key as the external ASR
OPENROUTER_LLM_MODEL=anthropic/claude-sonnet-5  # any model with structured outputs
LLM_GENERATION_PROVIDER=local                   # "openrouter" = automatic post-meeting analysis is also external
OPENROUTER_LLM_TIMEOUT_SECONDS=180
OPENROUTER_LLM_MAX_TOKENS=32000             # reasoning models spend part of this
```

Then, `docker --context default compose up -d backend`.

- The **Gerar ata**, **Gerar ADRs**, and **Gerar ADR** buttons ask, on every click, whether the generation
  is local or on OpenRouter, and warn before sending.
- With `LLM_GENERATION_PROVIDER=openrouter`, the automatic processing after each meeting
  also uses OpenRouter. Without `ALLOW_EXTERNAL_LLM=true`, the backend won't start with this option.
- The response follows a strict JSON Schema (`response_format`) and only goes to providers that
  support it (`provider.require_parameters`).
- Each call is logged in `audit_log` (`external_llm`), with tokens and cost, without content. Each request
  made through the interface is logged in `generation_requested`.
- Egress only allows `https://openrouter.ai/api/v1/chat/completions`.
- Only the meeting owner generates documents (someone who received a share can't generate).

### Your Subscription: Claude Code or Codex (Optional)

Instead of paying per use on OpenRouter, the meeting minutes and ADRs can come from **your subscription** to
Claude (Pro/Max) or ChatGPT (Codex). The one that runs it is the **host-agent**, with `claude` or `codex`
installed on your machine and your login; the backend never sees credentials.

> **Warning:** the transcription leaves the machine and goes to Anthropic or OpenAI through your
> personal plan, which follows consumer terms. Check in your account whether conversations can be used
> for training. Only use it with content that your organization's policy allows sending.

```bash
# .env (also requires ALLOW_EXTERNAL_LLM=true)
CLAUDE_CLI_ENABLED=true
CLAUDE_CLI_MODEL=sonnet          # sonnet, opus, or the full model name
CODEX_CLI_ENABLED=true
CODEX_CLI_MODEL=                 # empty = Codex default
LLM_GENERATION_PROVIDER=claude   # optional: automatic analysis via the subscription
```

1. Install the host-agent (`apps/host-agent/install.sh`); it needs to be running.
2. **Claude:** uses the regular Claude Code login (`claude` → `/login`).
3. **Codex:** uses its own folder, without your settings and skills. Log in once:
   `CODEX_HOME=~/.config/agente-reunioes/codex codex login --device-auth`
4. `docker --context default compose up -d backend`

Rules:

- Applies only to the meetings of the host-agent owner (`AGENT_OWNER`). The subscription is personal: another
  person's meetings never use your plan.
- The dialog shows why the option is unavailable (host-agent off, CLI not logged in,
  another person's meeting).
- In automatic analysis, if the subscription is unavailable for a while (host-agent restarting, CLI
  not logged in), the meeting waits up to `SUBSCRIPTION_WAIT_MINUTES` (30) with the warning "Aguardando a
  assinatura" ("Waiting for the subscription"). If it doesn't come back, it's left with an error and the
  transcription saved; the meeting minutes come out via **Gerar ata**. It never falls back to the local model
  for this reason. Only another person's meeting uses the local model.
- The CLI runs isolated: no tools, hooks, MCP, or user instructions, in a
  temporary folder, with the text passed via stdin. It consumes your plan's limit (no per-use cost).
- Each call is logged in `audit_log` (`external_llm`, with tokens), without content.

## Publish on the Network (HTTPS)

Don't expose port 3000 without TLS. With the included Caddy:

```bash
# .env: DOMAIN=ata.suaempresa.com.br, COOKIE_SECURE=true, TRUST_PROXY=1
docker compose --profile https up -d
```

### Upgrading an existing installation for search (pgvector)

Postgres now uses its own image (`docker/postgres`: `postgres:16-alpine` with pgvector compiled in). It is the **same major version and the same Alpine base**, so the `pgdata` volume opens as is: no `pg_upgrade`, no dump/restore and no `REINDEX`. Do it with the backend **idle** (nothing recording or processing):

```bash
export DOCKER_CONTEXT=default
mkdir -p ~/backups && docker compose exec postgres pg_dump -U meetingbot -Fc meetingbot > ~/backups/meetingbot-$(date +%F).dump
docker compose build postgres                       # image with pgvector
docker compose up -d postgres ollama                # recreates both with the existing volumes
docker compose exec ollama ollama pull bge-m3       # one-time download of the embedding model
docker compose up -d --build backend                # the migration creates the extension and tables; indexing runs in the background
```

- The migration is idempotent (`CREATE EXTENSION IF NOT EXISTS vector`) and **fails with a clear message** if Postgres is not yet the new image (or use `SEARCH_SEMANTIC=off` for text only).
- `OLLAMA_MAX_LOADED_MODELS` becomes 2 (CPU embedding and GPU LLM loaded together).
- Restoring the dump needs Postgres of the same major version (16). **Rollback:** `SEARCH_ENABLED=false` in `.env` and `docker compose up -d backend`; to go back to the old image, run `DROP EXTENSION vector CASCADE;` before switching to `postgres:16-alpine` (the `search_*` tables are rebuildable).

### Test Server (VPS with Dokploy)

`docker-compose.vps.yml` brings up the same application on a server, without a GPU and without a desktop: the
final transcription goes through OpenRouter, the meeting minutes and ADRs go through your Claude subscription
(`agent-cli` container), and the one recording is the assistant inside the call — it works with your computer
turned off. Step-by-step guide, limits, and data copy: [`docs/vps-dokploy.md`](docs/vps-dokploy.md).

## Development

```bash
npm install                    # workspaces: contracts, frontend, backend
npm run typecheck
npm test                       # backend unit tests (Vitest)
npm run test:db -w @meeting-bot/backend      # disposable Postgres in a container
# E2E (real Chromium, real backend, disposable Postgres on 55434, app on 3310)
npm run build -w @meeting-bot/frontend && npm run test:e2e -w @meeting-bot/backend
E2E_SHOTS=/tmp/capturas npm run test:e2e -w @meeting-bot/backend   # keeps screen captures
(cd apps/host-agent && uv run pytest -q)
# worker without downloading torch: only the test dependencies
(cd apps/worker-gpu && uv run --no-project --python 3.12 --with fastapi --with numpy \
  --with httpx --with pytest --with pydantic python -m pytest -q)
npm run dev:backend            # needs Postgres, worker-gpu, and Ollama accessible
npm run dev:frontend           # Vite with proxy to /api
scripts/fixture-ics.sh 20      # test invite starting in 20 min
```

- The script for testing the live agent is in `scripts/roteiro-arquitetura.md`.
- The validation scenarios are in `specs/001-agente-reunioes-mvp/quickstart.md`.

## Known Limitations

- **Meet/Teams selectors break** when the platforms change their screens (assistant and Agent
  Mode). They live in `apps/backend/src/bot/platforms.ts`.
- **One computer recording at a time** ("Gravar agora" or `AUTO_LOCAL_RECORDING=true`). In a
  meeting immediately following another, the second one waits for the first to stop (3 min without speech
  past the scheduled time) or for **Parar**; the host-agent warns about the conflict. The assistant inside
  the call doesn't have this limit: it joins up to `MAX_CONCURRENT_BOTS` meetings at the same time.
- **The live analysis uses the local 4B model**, which makes mistakes and repeats items. That's why every
  item is born proposed, with validated evidence, and duplicate items are merged in the final analysis.
  Meeting minutes and ADRs come out better with the external LLM or the subscription
  (`LLM_GENERATION_PROVIDER`).
- **A manually created architectural decision** has no associated transcript excerpt: its ADR is
  generated using only the description and the meeting summary.
- **One host-agent per machine**, tied to a single user (`AGENT_OWNER`). Other users use the
  upload or the guest assistant.
- **The guest assistant only shows initials** in the meeting: an anonymous guest has no photo on Meet
  or Teams. The virtual camera (`BOT_CAMERA`) shows the icon, but as a video frame. On Teams, the
  agent account replaces the guest with the account's name.
- **A single-occurrence `.ics` invite** doesn't bring the series' recurrence. The import warns about it;
  export the entire series from Outlook.
- **Docker Desktop on Linux** doesn't work: its VM can't see the GPU or show the native
  Docker containers. Use the native Docker Engine.
- **Test server (VPS)** has no live transcription or computer recording: only the
  assistant on the call and the final pass via OpenRouter.

**Notify the participants** that the meeting is being recorded and transcribed (LGPD). The assistant's name
already indicates it's the meeting minutes, but that doesn't replace the notice.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): branch flow (`develop` → `homolog` → `main`),
required tests, and rules that no change can break. Security issues:
[SECURITY.md](SECURITY.md). Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE). Anyone who modifies and offers the system
as a service, including over the web, must make the source code of the changes available.
