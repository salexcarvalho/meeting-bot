# Contrato — WebSocket ao vivo (UI ← backend)

URL: `ws(s)://<host>/api/live`

A autenticação usa o cookie de sessão no `upgrade`. O `Origin` precisa ser igual ao host. Sem
sessão válida, a resposta é HTTP 401 e não há WebSocket.

## Cliente → servidor (texto JSON)

```json
{"type":"subscribe","topic":"agenda"}
{"type":"subscribe","topic":"meeting","meetingId":"<uuid>"}
{"type":"unsubscribe","topic":"meeting","meetingId":"<uuid>"}
{"type":"ping"}
```

## Servidor → cliente

| type | Tópico | Payload |
|---|---|---|
| `meeting` | agenda + meeting | `{meeting: MeetingSummary}` quando o status ou os dados mudam |
| `segments` | meeting | `{meetingId, pass, segments: Segment[]}` com os segmentos novos (ao vivo) |
| `transcript_replaced` | meeting | `{meetingId}`: o passe final substituiu tudo e a UI recarrega a reunião |
| `items` | meeting | `{meetingId, items: Item[]}` com itens criados ou alterados |
| `items_removed` | meeting | `{meetingId, ids: string[]}` (mesclados pela consolidação) |
| `adrs` | meeting | `{meetingId, adrs: Adr[]}` |
| `summary` | meeting | `{meetingId, text, at}` |
| `recording` | meeting + agenda | `{meetingId, elapsedSeconds, lastSpeechAt, lagSeconds, channels: {mic, remote: {state, lastAudioAt}}, stopReason?}` (a cada 2 s) |
| `processing` | meeting | `{meetingId, step: "convertendo"\|"transcrevendo"\|"diarizando"\|"analisando"\|"ata"\|"adrs", progress?: 0..1}` |
| `gpu` | meeting + agenda | `{utilization, memoryUsedMb, memoryTotalMb}` (a cada 5 s, se houver atividade) |
| `host_agent` | agenda + meeting | `{online, lastSeenAt}` quando o estado muda |
| `pong` | — | `{}` |

## Regras

- Na conexão, o servidor não reenvia histórico. A UI carrega o estado por REST e aplica os
  eventos por cima.
- `lagSeconds`: diferença entre o áudio recebido e o áudio já transcrito do canal mais atrasado.
  Acima de 45 s, a UI mostra "transcrição atrasada".
- O cliente reconecta com backoff (1–10 s) e, ao reconectar, recarrega por REST.
- Se a sessão expirar, o servidor fecha com `4401` e a UI vai para o login.
