# Meeting Agent (meeting-bot)

[Português](README.md) · **English** · [Español](README.es.md)

**Local** meeting and software architecture agent. It:

- brings the day's agenda via `.ics` invites or manual registration;
- alerts on the desktop 15, 5, and 1 minute before each meeting;
- at the scheduled time, sends the **assistant** into the call (Teams/Meet), which records even if you don't join;
- transcribes live and, at the end, produces a better final transcription, with speaker diarization;
- extracts decisions, pending items, risks, and requirements during the meeting, always with the source excerpt;
- generates the meeting minutes (19-section template) and ADR suggestions;
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
- **Nova reunião** ("New meeting"): manual registration with title, start time, duration, link, and project.
- The project is **suggested** based on keywords in the title. Confirm it under **Editar** ("Edit").
- **Não gravar** ("Don't record"): available on the screen or in the desktop alert; the assistant doesn't join.
- **Enviar assistente agora** ("Send assistant now"): sends the assistant before the scheduled time, or again after a failure.
- **Gravar agora** ("Record now"): only for meetings without a link; records via the computer (microphone and PC audio).

### During the Meeting

- At the scheduled time, the **assistant** joins every meeting with a Teams/Meet link that isn't marked
  "Não gravar" ("Don't record"), with the configured name and the suffix "assistente gravando" ("assistant recording"). Admit it from the waiting room.
  - It joins muted and without a camera; the meeting shows the initials of the name (guests have no photo).
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
  the running summary, and the item panels.
- Clicking a timestamp or an item's evidence jumps to the excerpt and plays the audio.

### After the Meeting

- The final transcription replaces the live one. Item evidence is remapped.
- The agent re-analyzes the meeting, consolidates the items, and generates the meeting minutes and suggested ADRs.
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

When the assistant doesn't join, check the screenshot under **Áudio e debug** ("Audio and debug").

### Settings

Each user has their own settings:

- **Perfil** ("Profile"): real name, display name, language, timezone, and photo.
- **Meu agente** ("My agent"): architect agent persona, technologies, decision types, base prompt, avatar, and spoken name recording.
- **Reuniões:** identity in the room.
- **Documentação** ("Documentation"): level of detail and formats.
- **Consumo de IA** ("AI usage"): tokens and cost for the month per provider, model, and meeting, plus the latest calls.
  It comes from `audit_log`, is read-only, and doesn't block generation. The subscription doesn't charge per call: only
  tokens. Each person sees the usage for the meetings they can see.

## Main Configuration (`.env`)

| Variable | Default | Usage |
|---|---|---|
| `AGENT_TOKEN` | — | Secret shared with the host-agent (≥ 32 characters) |
| `USER_DISPLAY_NAME` | `Sérgio` | Microphone channel name |
| `APP_TIMEZONE` | `America/Sao_Paulo` | Timezone for the agenda and the meeting minutes |
| `ASR_MODEL` / `ASR_COMPUTE_TYPE` | `large-v3-turbo` / `int8_float16` | Whisper on the worker |
| `HF_TOKEN` | empty | Speaker diarization |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Local LLM |
| `LIVE_EXTRACT_MIN_SPEECH_SECONDS` | 90 | Live extraction every N s of new speech… |
| `LIVE_EXTRACT_MAX_INTERVAL_SECONDS` | 180 | …or at most every M s |
| `LIVE_CONSOLIDATE_INTERVAL_SECONDS` | 900 | Running summary and deduplication |
| `SILENCE_STOP_SECONDS` / `MAX_RECORDING_MINUTES` | 180 / 240 | Stop rules |
| `AGENT_OWNER` | empty | User whose meetings this machine's host-agent records (empty = first registered user, if still an active SUPER_ADMIN; always set it when there's more than one user) |
| `DEFAULT_AGENT_NAME` | `Assistente` | Initial agent name for each user |
| `BOT_JOIN_TIMEOUT_SECONDS` | 45 | Time limit for the assistant to reach the room or the waiting area |
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
- **Sharing a meeting** doesn't have a screen yet (the `meeting_shares` structure already exists in the backend).
- **The assistant only shows initials** in the meeting: an anonymous guest has no photo on Meet
  or Teams. The virtual camera (`BOT_CAMERA`) shows the icon, but as a video frame.
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
