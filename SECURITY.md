# Segurança · Security · Seguridad

[Português](#português) · [English](#english) · [Español](#español)

---

## Português

### Como relatar

**Não abra issue pública.** Use o relato privado do GitHub: aba **Security** do repositório →
**Report a vulnerability**. Descreva o problema, como reproduzir, a versão (tag ou commit) e o
impacto. Não inclua gravações, transcrições nem dados reais de reuniões.

Respondemos em até 7 dias. A correção sai numa versão nova e o relato é publicado depois dela, com
crédito para você se quiser.

### Versões com correção

| Versão | Recebe correção |
|---|---|
| 1.x | sim |
| < 1.0 | não |

### O que mais nos interessa

- um usuário ver ou alterar reunião, transcrição, ata ou áudio de outro sem compartilhamento;
- permissão validada só no frontend;
- áudio, transcrição ou documento saindo da máquina sem as opções externas ligadas
  (`LOCAL_ONLY`, `ALLOW_EXTERNAL_ASR`, `ALLOW_EXTERNAL_LLM`);
- vazamento de segredos (`.env`, `AGENT_TOKEN`, chaves de API, sessões) em logs, respostas ou
  `audit_log`;
- o assistente entrar numa reunião sem se identificar como gravação;
- execução de comando pelo host-agent ou pelo CLI da assinatura a partir de conteúdo de reunião.

---

## English

### How to report

**Do not open a public issue.** Use GitHub private reporting: the repository's **Security** tab →
**Report a vulnerability**. Describe the problem, how to reproduce it, the version (tag or commit)
and the impact. Do not include recordings, transcripts or real meeting data.

We reply within 7 days. The fix ships in a new release, and the report is published after it, with
credit to you if you want.

### Supported versions

| Version | Gets fixes |
|---|---|
| 1.x | yes |
| < 1.0 | no |

### What matters most to us

- one user seeing or changing another user's meeting, transcript, minutes or audio without sharing;
- permissions checked only in the frontend;
- audio, transcripts or documents leaving the machine without the external options turned on
  (`LOCAL_ONLY`, `ALLOW_EXTERNAL_ASR`, `ALLOW_EXTERNAL_LLM`);
- secrets (`.env`, `AGENT_TOKEN`, API keys, sessions) leaking into logs, responses or `audit_log`;
- the assistant joining a meeting without identifying itself as a recording;
- command execution through the host-agent or the subscription CLI driven by meeting content.

---

## Español

### Cómo reportar

**No abras un issue público.** Usa el reporte privado de GitHub: pestaña **Security** del
repositorio → **Report a vulnerability**. Describe el problema, cómo reproducirlo, la versión (tag o
commit) y el impacto. No incluyas grabaciones, transcripciones ni datos reales de reuniones.

Respondemos en hasta 7 días. La corrección sale en una versión nueva y el reporte se publica después,
con crédito para ti si lo deseas.

### Versiones con soporte

| Versión | Recibe correcciones |
|---|---|
| 1.x | sí |
| < 1.0 | no |

### Lo que más nos interesa

- un usuario ver o modificar reunión, transcripción, acta o audio de otro sin compartir;
- permisos validados solo en el frontend;
- audio, transcripción o documento saliendo de la máquina sin las opciones externas activadas
  (`LOCAL_ONLY`, `ALLOW_EXTERNAL_ASR`, `ALLOW_EXTERNAL_LLM`);
- filtración de secretos (`.env`, `AGENT_TOKEN`, claves de API, sesiones) en logs, respuestas o
  `audit_log`;
- el asistente entrar a una reunión sin identificarse como grabación;
- ejecución de comandos por el host-agent o el CLI de la suscripción a partir de contenido de
  reuniones.
