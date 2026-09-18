# Contribuir · Contributing · Contribuir

[Português](#português) · [English](#english) · [Español](#español)

---

## Português

Obrigado pelo interesse. Este é um agente de reuniões que grava e transcreve conversas de outras
pessoas: privacidade e transparência vêm antes de qualquer funcionalidade.

### Antes de começar

- Leia a [constituição do projeto](.specify/memory/constitution.md). Mudança que quebra um princípio
  não entra, por melhor que seja o código.
- Para funcionalidade nova, abra uma issue antes do código. Mudanças grandes seguem o Spec Kit
  (`specs/`: spec → plano → tarefas → implementação).
- Issues e PRs podem ser escritos em português, inglês ou espanhol.

### Regras que nenhuma mudança pode quebrar

- **Nada sai da máquina por padrão** (`LOCAL_ONLY=true`). Envio para serviço externo só pelas
  exceções já previstas (ASR e LLM externos), desligadas por padrão e registradas no `audit_log`.
- **Nunca contornar políticas de organizações**: sem scraping de Outlook/Teams, sem burlar bloqueio
  de apps, sem pedir ou guardar senha corporativa.
- **O assistente sempre se identifica como gravação**: o nome dele diz que é a ata. Não aceitamos
  opção de gravar escondido.
- **Humano no controle**: todo item gerado pela IA nasce como proposto e só vira definitivo com
  aprovação.
- **Isolamento entre usuários**: permissão sempre validada no backend; o usuário A não vê dados do B
  sem compartilhamento. Administrador não lê conteúdo alheio.
- **Sem segredo em texto puro** e sem conteúdo de reunião em log ou no `audit_log` (só metadados).

### Fluxo de branches

| Branch | Para quê | Recebe de |
|---|---|---|
| `main` | versão publicada; cada versão ganha uma tag `vX.Y.Z` | `homolog` (e `hotfix/*`) |
| `homolog` | homologação em ambiente real (ex.: servidor de teste) | `develop` |
| `develop` | integração do que está pronto | `feat/*`, `fix/*`, `docs/*` |
| `feat/*`, `fix/*`, `docs/*` | seu trabalho | criada a partir de `develop` |
| `hotfix/*` | correção urgente em produção | criada a partir de `main`, volta para `main` e `develop` |

Abra o PR para `develop`. Não faça PR direto para `main` nem para `homolog`.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`. Por convenção do projeto, a mensagem é em português; se não conseguir,
escreva em inglês e ajustamos no merge.

### Antes de abrir o PR

```bash
npm run typecheck
npm test
npm run test:db -w @meeting-bot/backend        # Postgres descartável (Docker); porta: TEST_DB_PORT
npm run test:e2e -w @meeting-bot/backend       # obrigatório se mexeu em tela
(cd apps/host-agent && uv run pytest)
(cd apps/worker-gpu && uv run pytest)          # se mexeu no worker
```

- Compilar não basta: descreva no PR como você verificou o comportamento.
- Mudou comportamento visível? Atualize o README nos três idiomas (`README.md`, `README.en.md`,
  `README.es.md`); se não souber traduzir, avise no PR.
- Nunca inclua `.env`, chaves, áudios, transcrições ou dados de reuniões reais, nem em testes.

### Licença das contribuições

O projeto é [AGPL-3.0-or-later](LICENSE). Ao abrir um PR, você concorda que a sua contribuição é
licenciada nos mesmos termos.

### Segurança

Falha de segurança não vai em issue pública: veja [SECURITY.md](SECURITY.md).

---

## English

Thanks for your interest. This is a meeting agent that records and transcribes other people's
conversations: privacy and transparency come before any feature.

### Before you start

- Read the [project constitution](.specify/memory/constitution.md) (Portuguese). A change that
  breaks a principle is not merged, however good the code is.
- For a new feature, open an issue before writing code. Large changes follow Spec Kit (`specs/`:
  spec → plan → tasks → implementation).
- Issues and PRs can be written in Portuguese, English or Spanish.

### Rules no change may break

- **Nothing leaves the machine by default** (`LOCAL_ONLY=true`). Sending data to an external service
  is only allowed through the existing exceptions (external ASR and LLM), off by default and logged
  in `audit_log`.
- **Never bypass an organization's policies**: no scraping Outlook/Teams, no working around blocked
  apps, no asking for or storing corporate passwords.
- **The assistant always identifies itself as a recording**: its name says it is taking the minutes.
  We do not accept options for hidden recording.
- **Human in control**: every AI-generated item starts as proposed and only becomes final after
  approval.
- **Isolation between users**: permissions are always checked in the backend; user A cannot see
  user B's data without sharing. Admins do not read other people's content.
- **No plain-text secrets**, and no meeting content in logs or in `audit_log` (metadata only).

### Branch flow

| Branch | Purpose | Receives from |
|---|---|---|
| `main` | released version; each release gets a `vX.Y.Z` tag | `homolog` (and `hotfix/*`) |
| `homolog` | staging in a real environment (e.g. the test server) | `develop` |
| `develop` | integration of finished work | `feat/*`, `fix/*`, `docs/*` |
| `feat/*`, `fix/*`, `docs/*` | your work | branched from `develop` |
| `hotfix/*` | urgent production fix | branched from `main`, merged into `main` and `develop` |

Open your PR against `develop`. Do not open PRs directly against `main` or `homolog`.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`. By project convention the message is in Portuguese; if you can't, write it in
English and we will adjust it on merge.

### Before opening a PR

```bash
npm run typecheck
npm test
npm run test:db -w @meeting-bot/backend        # throwaway Postgres (Docker); port: TEST_DB_PORT
npm run test:e2e -w @meeting-bot/backend       # required if you changed the UI
(cd apps/host-agent && uv run pytest)
(cd apps/worker-gpu && uv run pytest)          # if you changed the worker
```

- Compiling is not enough: describe in the PR how you verified the behavior.
- Changed visible behavior? Update the README in all three languages (`README.md`, `README.en.md`,
  `README.es.md`); if you can't translate, say so in the PR.
- Never include `.env` files, keys, audio, transcripts or real meeting data, not even in tests.

### Contribution license

The project is [AGPL-3.0-or-later](LICENSE). By opening a PR you agree that your contribution is
licensed under the same terms.

### Security

Security issues do not go in public issues: see [SECURITY.md](SECURITY.md).

---

## Español

Gracias por tu interés. Este es un agente de reuniones que graba y transcribe conversaciones de
otras personas: la privacidad y la transparencia están antes que cualquier funcionalidad.

### Antes de empezar

- Lee la [constitución del proyecto](.specify/memory/constitution.md) (en portugués). Un cambio que
  rompe un principio no se acepta, por bueno que sea el código.
- Para una funcionalidad nueva, abre un issue antes de escribir código. Los cambios grandes siguen
  Spec Kit (`specs/`: spec → plan → tareas → implementación).
- Issues y PRs pueden escribirse en portugués, inglés o español.

### Reglas que ningún cambio puede romper

- **Nada sale de la máquina por defecto** (`LOCAL_ONLY=true`). Enviar datos a un servicio externo
  solo se permite por las excepciones ya previstas (ASR y LLM externos), apagadas por defecto y
  registradas en `audit_log`.
- **Nunca eludir las políticas de una organización**: nada de scraping de Outlook/Teams, nada de
  saltarse bloqueos de apps, nada de pedir o guardar contraseñas corporativas.
- **El asistente siempre se identifica como grabación**: su nombre dice que está tomando el acta. No
  aceptamos opciones para grabar a escondidas.
- **Humano en control**: todo ítem generado por la IA nace como propuesto y solo pasa a definitivo
  con aprobación.
- **Aislamiento entre usuarios**: los permisos siempre se validan en el backend; el usuario A no ve
  datos del B sin compartir. El administrador no lee contenido ajeno.
- **Sin secretos en texto plano**, y sin contenido de reuniones en logs ni en `audit_log` (solo
  metadatos).

### Flujo de ramas

| Rama | Para qué | Recibe de |
|---|---|---|
| `main` | versión publicada; cada versión recibe una tag `vX.Y.Z` | `homolog` (y `hotfix/*`) |
| `homolog` | homologación en un entorno real (ej.: el servidor de pruebas) | `develop` |
| `develop` | integración de lo terminado | `feat/*`, `fix/*`, `docs/*` |
| `feat/*`, `fix/*`, `docs/*` | tu trabajo | creada desde `develop` |
| `hotfix/*` | corrección urgente en producción | creada desde `main`, vuelve a `main` y `develop` |

Abre tu PR hacia `develop`. No abras PRs directos hacia `main` ni `homolog`.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`. Por convención del proyecto el mensaje va en portugués; si no puedes,
escríbelo en inglés y lo ajustamos en el merge.

### Antes de abrir el PR

```bash
npm run typecheck
npm test
npm run test:db -w @meeting-bot/backend        # Postgres desechable (Docker); puerto: TEST_DB_PORT
npm run test:e2e -w @meeting-bot/backend       # obligatorio si cambiaste pantallas
(cd apps/host-agent && uv run pytest)
(cd apps/worker-gpu && uv run pytest)          # si cambiaste el worker
```

- Compilar no basta: describe en el PR cómo verificaste el comportamiento.
- ¿Cambiaste un comportamiento visible? Actualiza el README en los tres idiomas (`README.md`,
  `README.en.md`, `README.es.md`); si no sabes traducir, avísalo en el PR.
- Nunca incluyas `.env`, claves, audios, transcripciones ni datos de reuniones reales, ni en tests.

### Licencia de las contribuciones

El proyecto es [AGPL-3.0-or-later](LICENSE). Al abrir un PR aceptas que tu contribución se licencia
en los mismos términos.

### Seguridad

Las fallas de seguridad no van en issues públicos: consulta [SECURITY.md](SECURITY.md).
