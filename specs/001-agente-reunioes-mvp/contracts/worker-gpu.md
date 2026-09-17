# Contrato — worker-gpu (HTTP interno)

Base: `http://worker-gpu:8000`, disponível só na rede do compose, sem porta publicada e sem
autenticação.

O worker monta o volume `botdata` em `/data` somente para leitura e só aceita caminhos dentro de
`/data/audio/`.

## GET /health

```json
{"ok": true, "model": "large-v3-turbo", "compute_type": "int8_float16", "device": "cuda",
 "diarization": "enabled|disabled|unavailable", "diarization_reason": "sem HF_TOKEN"}
```

## GET /gpu

```json
{"name": "NVIDIA GeForce RTX 4050 Laptop GPU", "utilization": 37,
 "memory_used_mb": 4980, "memory_total_mb": 6141}
```

Sem NVML → `503 {"error": "gpu indisponível"}`.

## POST /transcribe/chunk

Transcrição ao vivo de um trecho curto (≤ 35 s).

- **Corpo:** PCM `s16le` 16 kHz mono (`Content-Type: application/octet-stream`).
- **Query:**
  - `language` (padrão `pt`);
  - `prompt` (glossário opcional, ≤ 400 caracteres);
  - `channel` (usado só em logs).

Parâmetros fixos:
- `vad_filter=True`;
- `condition_on_previous_text=False`;
- `beam_size=5`;
- `no_speech_threshold=0.6`;
- filtro de alucinações conhecidas (legendas, "amara.org" etc.).

Resposta:

```json
{"duration": 21.4, "speech_seconds": 17.9, "elapsed": 0.62,
 "segments": [{"start": 0.48, "end": 6.1, "text": "..."}]}
```

- Os tempos são relativos ao início do trecho.
- `speech_seconds = 0` significa que não houve fala.
- Chamadas são serializadas por um lock (uma inferência por vez) e têm prioridade sobre jobs.
  Um job em andamento libera o lock entre lotes.

Erros: `400` (corpo vazio, ímpar ou > 35 s); `503` (modelo carregando).

## POST /jobs/transcribe

Passe final e transcrição de uploads e do Modo Agente.

```json
{"language": "pt",
 "prompt": "glossário opcional",
 "files": [
   {"path": "/data/audio/<id>/mic.ogg", "channel": "mic", "diarize": false},
   {"path": "/data/audio/<id>/remote.ogg", "channel": "remote", "diarize": true}
 ]}
```

Resposta `202 {"job_id": "…"}`.

- O worker mantém até 20 jobs na memória, e só 1 roda por vez.
- Com `diarize: true` e diarização disponível, os rótulos saem como `Speaker 1..N`, em ordem de
  primeira fala.
- Sem diarização, o rótulo é `null` e o backend usa `Remoto`/`Participante`.

## GET /jobs/{job_id}

```json
{"status": "queued|running|done|error", "step": "transcrevendo|diarizando", "progress": 0.42,
 "error": null,
 "result": {"channels": [
   {"channel": "remote", "duration": 3605.2, "diarized": true,
    "segments": [{"start": 1.2, "end": 5.3, "text": "...", "speaker": "Speaker 1"}]}
 ]}}
```

- `404` se o job não existir (por exemplo, depois de um reinício); o backend reenvia.
- A atribuição de falante a cada segmento é pela maior sobreposição com os turnos da diarização.

Parâmetros do passe final:
- `beam_size=5`;
- `vad_filter=True`;
- `condition_on_previous_text=True`;
- `BatchedInferencePipeline` (`batch_size=8`) quando disponível.

## Gestão de VRAM

- O Whisper fica carregado o tempo todo (~1,4 GB).
- A pipeline de diarização é carregada no início do job com `diarize` e liberada no fim
  (`del` + `torch.cuda.empty_cache()`).
- Antes de um job com diarização, o backend descarrega o Ollama (`keep_alive: 0`).
