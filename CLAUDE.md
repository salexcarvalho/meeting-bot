# meeting-bot → Agente Local de Reuniões e Arquitetura

Evolução do meeting-bot (bot Meet/Teams + Whisper + ata) para um agente local
pessoal: calendário, alertas no Ubuntu, captura de áudio local, Whisper na GPU,
agente arquiteto, memória pesquisável.

- Análise, decisões (D1–D8) e backlog: `docs/analise/agente-local.md`
- Agente arquiteto no código (prompts, fluxo ao vivo e pós-reunião): `docs/agente-arquiteto.md`
- Especificação do MVP (Spec Kit): `specs/001-agente-reunioes-mvp/` (spec, plan, research, data-model, contracts, quickstart, tasks)
- Estado atual do código: monorepo `apps/{backend,frontend,worker-gpu,host-agent}` + `packages/contracts` (Node 24 + TS, React, Python 3.12); visão geral em `docs/ARCHITECTURE.md`
- Comandos: `npm run typecheck`, `npm test`, `npm run test:db -w @meeting-bot/backend` (Postgres descartável), `uv run pytest` no host-agent; subir com `docker --context default compose up -d --build`
- Fluxo de trabalho: Spec Kit (`/speckit-*`), commits em português

## Regras do projeto (decididas pelo usuário)

- `LOCAL_ONLY=true` sempre: nenhum áudio, transcrição ou documento sai da máquina; LLM só local (Ollama).
  - Exceção (constituição 1.4.0): LLM externo opcional (`ALLOW_EXTERNAL_LLM=true`) para ata e ADR — OpenRouter ou a assinatura pessoal do dono (Claude Code/Codex, executados pelo host-agent, só nas reuniões do `AGENT_OWNER`); escolhido a cada clique em "Gerar ata/ADR" ou, na análise automática, por `LLM_GENERATION_PROVIDER`; Ollama continua padrão; ao vivo sempre local.
  - Exceção (constituição 1.1.0): ASR externo de teste (Deepgram nova-3 via OpenRouter), só com `ALLOW_EXTERNAL_ASR=true`, só no passe final/upload, escolhido por `.env` ou por reunião. Whisper local continua padrão; ao vivo sempre local.
- Nunca contornar políticas da organização (sem scraping de Outlook/Teams para burlar bloqueio de app).
- Calendário: importação `.ics` + cadastro manual (tenant bloqueia Graph e acesso por e-mail).
- Gravação (constituição 1.5.0): no horário, o assistente convidado entra em toda reunião da agenda com link Teams/Meet (exceto "Não gravar") e grava de dentro da chamada, com transcrição ao vivo (1.6.0). O PC não grava sozinho (o usuário nem sempre entra); sem link, só "Gravar agora", que para após o fim previsto com 3 min sem fala, ou manualmente.
- Áudio é guardado sempre.
- ADR e itens da IA só viram definitivos com aprovação humana.
- Multiusuário (plano em `docs/analise/plataforma-multiusuario.md`):
  - RBAC e isolamento por dono;
  - admin não lê conteúdo alheio;
  - assistente sem sufixo, mas com nome que diz que é a ata (ex.: "Ata do Sérgio"; sem "ata"/"gravação" entra como "Ata de <nome>") e sem foto na reunião (convidado anônimo só mostra iniciais); câmera virtual com o ícone do agente existe, mas desligada por padrão (`BOT_CAMERA`);
  - host-agent grava só as reuniões de `AGENT_OWNER` (host-agent do sócio fica para o futuro).

- Servidor de teste (constituição 2.0.0): VPS com Dokploy, `docker-compose.vps.yml` + `.env.vps.example`; transcrição final pelo OpenRouter (sem GPU), ata/ADR pela assinatura do Claude no container `agent-cli` (`AGENTE_MODE=llm`), sem passe ao vivo e sem gravação pelo PC. Guia: `docs/vps-dokploy.md`.

## Ambiente

- Usar Docker Engine nativo (`docker --context default`). O Docker Desktop é VM: sem GPU e só 4 CPUs.
- GPU: RTX 4050 6 GB; host preparado com `sudo bash scripts/setup-host.sh`.
- Integração com o desktop (notificação, som, PipeWire, keyring) fica num host-agent nativo, não em container.

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
rtk uv run <cmd>        # Compact uv project command output
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
