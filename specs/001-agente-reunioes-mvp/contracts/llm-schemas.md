# Contrato — Chamadas ao LLM local

Todas as chamadas passam por `LLMProvider`, e o único adaptador ativo é `ollama`.

- Os schemas são definidos em zod (`packages/contracts/src/llm.ts`) e convertidos com
  `z.toJSONSchema()` para o campo `format` do Ollama.
- A saída é validada de novo com zod; se falhar, há 1 nova tentativa e depois a janela é
  descartada, com log.
- Parâmetros comuns: `model=OLLAMA_MODEL` (padrão `qwen3.5:4b`), `think=false`,
  `options.temperature=0`, `stream=false`, `keep_alive=OLLAMA_KEEP_ALIVE`.
- As chamadas são serializadas por uma fila única de LLM. O ao vivo tem prioridade sobre o
  pós-reunião.

## Formato da transcrição enviada

```text
<transcricao>
[S12 03:25] Sérgio: texto...
[S13 03:41] Remoto: texto...
</transcricao>
```

- `S<n>` é um identificador curto, local à chamada, que o backend mapeia para `segment_id`.
- O prompt de sistema trata o conteúdo como **dado**: instruções dentro da transcrição são
  ignoradas.

## 1. Extração (ao vivo e map do pós-reunião)

- `num_ctx`: 4096 ao vivo, 8192 no pós-reunião.
- Janela ao vivo: segmentos novos desde o cursor (até ~2 500 tokens estimados), mais os 2
  últimos segmentos anteriores como contexto (marcados como contexto e não citáveis), mais o
  resumo corrente (≤ 600 caracteres).
- Não são enviados itens já existentes; a deduplicação é feita depois, em código.

```ts
Extracao = {
  resumo_trecho: string,          // ≤ 2 frases, pt-BR
  itens: Array<{
    tipo: "decisao"|"decisao_arquitetural"|"pendencia"|"risco"|"requisito_funcional"
        |"requisito_nao_funcional"|"regra_negocio"|"restricao"|"premissa"
        |"pergunta_aberta"|"debito_tecnico",
    descricao: string,            // frase autocontida
    segmentos: string[],          // ["S12"], ≥ 1
    citacao: string,              // trecho literal curto (≤ 25 palavras) de um dos segmentos
    responsavel: string|null,
    prazo: string|null,
    dependencia: string|null,
    motivacao: string|null,
    impacto: string|null,
    sistema: string|null,
    categoria: "arquitetura"|"seguranca"|"infraestrutura"|"prazo"|"integracao"|"dados"
             |"performance"|"escalabilidade"|"governanca"|null
  }>
}
```

### Validação em código (`agent/evidence.ts`)

1. Todos os `segmentos` existem na janela e não são de contexto. Ids inválidos são removidos;
   se nenhum sobrar, o item é descartado.
2. `citacao` normalizada (minúsculas, sem acento nem pontuação): ao menos 60% dos tokens com 3
   ou mais letras aparecem no texto concatenado dos segmentos citados. Se não, o item é
   descartado.
3. `descricao` tem ≥ 8 caracteres. `categoria` só vale para `risco`.
4. Deduplicação (`agent/dedup.ts`): mesmo `tipo` e Jaccard ≥ 0,55 entre os conjuntos de tokens
   normalizados sem stopwords → não cria item novo. A evidência é anexada ao existente, com
   histórico `merged`. Se o existente estiver `rejeitado`, o descarte é silencioso.

## 2. Consolidação (a cada 15 min de gravação e no fim)

- `num_ctx`: 4096.
- Entrada:
  - resumo corrente;
  - resumos de janela desde a última consolidação;
  - lista dos itens `proposto` da reunião como `I<n> [tipo] descricao`, até 60 itens.

```ts
Consolidacao = {
  resumo: string,                                   // ≤ 1200 caracteres, resumo corrente
  duplicados: Array<{ manter: string, remover: string[] }>   // ids I<n>, mesmo tipo
}
```

Regras em código:
- Só mescla itens `proposto`.
- `manter` e `remover` precisam ser do mesmo tipo.
- Evidências dos removidos vão para o mantido.
- Os removidos são apagados, com histórico `merged` no mantido e evento `items_removed`.

## 3. Narrativa da ata (pós-reunião)

- `num_ctx`: 8192.
- Entrada:
  - título, projeto e participantes;
  - resumos de chunk em ordem;
  - itens não rejeitados, em `tipo: descricao` (até 80).

```ts
Narrativa = {
  objetivo: string,                               // 1–2 frases
  resumo_executivo: string,                       // 1 parágrafo, ≤ 900 caracteres
  assuntos: Array<{ titulo: string, resumo: string }>,     // 1–10
  observacoes_arquiteto: string[]                 // 0–8 observações técnicas acionáveis
}
```

## 4. ADR sugerido (um por decisão arquitetural não rejeitada)

- `num_ctx`: 8192.
- Entrada:
  - descrição do item;
  - segmentos de evidência com ±60 s de contexto;
  - resumo executivo.

```ts
AdrSugerido = {
  titulo: string,
  contexto: string,
  problema: string,
  alternativas: Array<{ opcao: string, pros: string, contras: string }>,  // 0–5; só as citadas
  decisao: string,
  consequencias: string,
  riscos: string[]
}
```

O prompt exige que alternativas não mencionadas na reunião **não** sejam inventadas. Nesse caso,
a lista vem vazia e a ata informa "não discutidas".

## Pós-reunião (map-reduce)

1. Os segmentos finais são divididos em chunks de ~2 000 tokens estimados (chars/3,5), com
   sobreposição de 2 segmentos.
2. Extração por chunk → itens `final`, validados e deduplicados contra os itens ao vivo
   (remapeados), que **prevalecem** porque podem já ter sido revisados.
3. Consolidação final dos `proposto`.
4. Narrativa.
5. ADRs.

## Parâmetros por ambiente (`.env`)

| Variável | Padrão |
|---|---|
| `OLLAMA_URL` | `http://ollama:11434` |
| `OLLAMA_MODEL` | `qwen3.5:4b` |
| `OLLAMA_KEEP_ALIVE` | `30m` |
| `LIVE_EXTRACT_MIN_SPEECH_SECONDS` | 90 |
| `LIVE_EXTRACT_MAX_INTERVAL_SECONDS` | 180 |
| `LIVE_CONSOLIDATE_INTERVAL_SECONDS` | 900 |
| `LLM_PROVIDER` | `ollama` (outros valores são recusados com `LOCAL_ONLY=true`) |
