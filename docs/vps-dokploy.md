# Servidor de teste no VPS (Dokploy)

Ambiente de teste com a mesma aplicação, rodando fora do computador do Sérgio. Decisões dele em
2026-09-17: transcrição final pelo **Deepgram via OpenRouter**, ata e ADR pela **assinatura do
Claude** (login feito no próprio servidor), **domínio com HTTPS** pelo Dokploy e **cópia do banco**
desta máquina para começar.

> **Privacidade:** o áudio e as transcrições copiados saem desta máquina e passam a viver no
> servidor alugado. Isso mudou a constituição (2.0.0, princípio I): o dado fica na infraestrutura do
> dono, e não só no computador dele. Use senhas fortes, HTTPS e apague o ambiente quando o teste
> acabar.

## O que muda em relação à máquina do Sérgio

| | Máquina do Sérgio | VPS de teste |
|---|---|---|
| Transcrição final | Whisper na GPU | Deepgram via OpenRouter (`ASR_PROVIDER=openrouter`) |
| Transcrição ao vivo | sim (worker local) | **não** (`BOT_LIVE_TRANSCRIPTION=false`): o ao vivo é sempre local |
| Ata, itens e ADR | assinatura do Claude pelo host-agent nativo | assinatura do Claude no serviço `agent-cli` (`AGENTE_MODE=llm`) |
| Gravação | assistente na chamada + "Gravar agora" no PC | só o assistente na chamada (servidor não tem desktop) |
| Alertas no desktop | sim | não |
| Acesso | `127.0.0.1:3000` | domínio com HTTPS pelo Traefik do Dokploy |

O assistente entra nas reuniões a partir do servidor: funciona mesmo com o computador desligado.

## Requisitos do VPS

- 4 vCPU e 8 GB de RAM (o Chromium do assistente usa ~1,5 GB por reunião; `MAX_CONCURRENT_BOTS=2`).
- 40 GB de disco (áudio em Opus: ~15 MB por hora de reunião).
- Dokploy instalado, com Traefik cuidando dos domínios.

## Passo a passo

1. **Domínio**: aponte um subdomínio (ex.: `reunioes.seudominio.com`) para o IP do VPS.
2. **Dokploy → Create → Compose**, apontando para este repositório (branch de teste) e para o
   arquivo `docker-compose.vps.yml`.
3. **Environment**: copie `.env.vps.example`, troque os segredos
   (`openssl rand -hex 32` para `POSTGRES_PASSWORD` e `AGENT_TOKEN`) e cole a
   `OPENROUTER_API_KEY`. Confira `AGENT_OWNER` com o nome do usuário que você vai criar.
4. **Domains**: serviço `backend`, porta `3000`, HTTPS ligado (Let's Encrypt).
5. **Deploy**. O `agent-cli` sobe junto e fica esperando o login.
6. **Usuário**: no terminal do Dokploy (ou por SSH), dentro da pasta do compose:

   ```bash
   docker compose exec backend npm run user:create -- sergio --role=SUPER_ADMIN
   ```

7. **Login da assinatura** (uma vez; fica no volume `clihome`):

   ```bash
   docker compose exec -it agent-cli claude login
   ```

   Abra a URL mostrada no seu navegador e cole o código. Confira em **Configurações → Sistema**:
   o agente aparece online e o Claude, disponível.
8. **Dados** (opcional): veja abaixo.

## Copiar as reuniões desta máquina

`scripts/vps-copiar-dados.sh` leva o banco e os arquivos de áudio. Ele **substitui** o banco do
servidor, então pede confirmação.

```bash
# do computador do Sérgio, com o backend local ocioso
scripts/vps-copiar-dados.sh usuario@ip-do-vps /etc/dokploy/compose/meeting-bot-xxxx/code
```

O script:

1. tira um `pg_dump` do banco local (sem parar nada);
2. copia o dump e `/data/audio` por `ssh`;
3. restaura no `postgres` do servidor e devolve os arquivos ao volume `botdata`;
4. reinicia o `backend` do servidor.

As senhas dos usuários vão junto (hash scrypt): o login é o mesmo daqui.

## Limites conhecidos

- Sem transcrição ao vivo e sem itens ao vivo: eles aparecem depois do passe final.
- "Gravar agora" fica indisponível no servidor: a rota recusa com uma mensagem explicando, porque
  não há desktop para capturar áudio.
- A assinatura do Claude é pessoal: o servidor gera só as reuniões do `AGENT_OWNER`.
- Para desligar o teste: `docker compose down` no Dokploy e apague os volumes (`pgdata`, `botdata`,
  `clihome`) — é isso que remove o conteúdo das reuniões do servidor.
