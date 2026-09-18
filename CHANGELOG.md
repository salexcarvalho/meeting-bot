# Changelog

[Português](#português) · [English](#english) · [Español](#español)

Formato: [Keep a Changelog](https://keepachangelog.com/). Versões: [SemVer](https://semver.org/).

---

## Português

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
