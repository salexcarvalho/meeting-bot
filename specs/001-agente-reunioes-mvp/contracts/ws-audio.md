# Contrato — WebSocket de áudio (host-agent → backend)

URL: `ws://127.0.0.1:3000/api/agent/audio?meeting=<uuid>&channel=mic|remote`

Cabeçalho obrigatório: `Authorization: Bearer <AGENT_TOKEN>`. A verificação acontece no
`upgrade`, antes do handshake; em caso de falha a resposta é HTTP 401 e não há WebSocket.

Formato do áudio: PCM `s16le`, 16 000 Hz, mono (32 000 bytes/s).

## Sequência

```text
host-agent                                   backend
    │ ── upgrade (Bearer, meeting, channel) ──►  valida token, reunião em recording|stopping
    │ ◄── text {"type":"ready","offset":N,"format":"s16le","rate":16000,"channels":1}
    │ ── binary PCM a partir do byte N (≤ 64 KB por frame, tamanho par) ──►
    │ ── binary ... ──►                         grava em DATA_DIR/audio/<id>/<channel>.pcm
    │ ◄── text {"type":"ack","offset":M}  (≈ 1/s) e alimenta a LiveSession
    │ ── text {"type":"end","total":T} ──►      quando a captura parou e tudo foi enviado
    │ ◄── text {"type":"ended","offset":T}      e fecha com 1000
```

## Regras

- `offset` é o tamanho do arquivo PCM no servidor, arredondado para baixo a um número par. O
  cliente reenvia do seu spool local a partir desse byte, o que permite retomar depois de uma
  queda ou reinício de qualquer lado.
- Frames com tamanho ímpar → fecha com `4400`.
- O servidor faz `fsync` a cada ~5 s. O `ack` só confirma bytes já persistidos.
- Se `total` ≠ bytes recebidos → `{"type":"error","message":"incompleto","offset":N}`; o cliente
  reenvia a partir de `N`.
- Só uma conexão por `(meeting, channel)`. Uma conexão nova derruba a anterior (`4001`).
- Alinhamento: o host-agent garante que o byte `k` corresponde a `k/32000` s depois do início
  da captura. Lacunas (troca de dispositivo, reinício do `parec`) são preenchidas com zeros.
  Por isso os dois canais compartilham a mesma linha do tempo.

## Códigos de fechamento

| Código | Motivo |
|---|---|
| 1000 | fim normal (após `ended`) |
| 4001 | substituída por nova conexão |
| 4400 | parâmetros ou frame inválidos |
| 4404 | reunião inexistente |
| 4409 | reunião não está gravando; o cliente para de enviar para ela |
| 1011 | erro interno; o cliente reconecta com backoff (1, 2, 5, 10 s) |

## Spool no host-agent

- Arquivo: `~/.local/share/agente-reunioes/spool/<meeting>/<channel>.pcm`.
- É apagado quando o backend confirma `ended` e a reunião sai de `recording`/`stopping`.
- Spools não confirmados são reenviados no próximo início do host-agent, se a reunião ainda
  aceitar áudio.
