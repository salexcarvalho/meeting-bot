# Agente de Reuniones (meeting-bot)

[Português](README.md) · [English](README.en.md) · **Español**

Agente **local** de reuniones y arquitectura de software. Él:

- trae la agenda del día mediante invitaciones `.ics` o registro manual;
- avisa en el escritorio 15, 5 y 1 minuto antes de cada reunión;
- a la hora programada, envía al **asistente** a la llamada (Teams/Meet), que graba aunque tú no entres;
- transcribe en vivo y, al final, hace una transcripción final mejor, con separación de hablantes;
- extrae decisiones, pendientes, riesgos y requisitos, siempre con el fragmento de origen, en las reuniones donde activas el interruptor **Itens** ("Ítems"; viene desactivado);
- genera el acta (plantilla de 19 secciones; solo el resumen cuando los ítems están desactivados) y sugerencias de ADR;
- deja todo como **propuesto** hasta que tú lo revises.

Todo funciona en la máquina: Whisper (faster-whisper) y LLM (Ollama, `qwen3.5:4b`) en la GPU local. La
única excepción es el **ASR externo de prueba**, que está desactivado por defecto
([ver más abajo](#asr-externo-de-prueba-opcional)).

También siguen disponibles la **carga de audio/video** y el **Modo Agente**, en el que un bot
invitado entra a Meet/Teams.

- Especificación del MVP: [specs/001-agente-reunioes-mvp/spec.md](specs/001-agente-reunioes-mvp/spec.md)
- Plan, contratos y validación: [specs/001-agente-reunioes-mvp/](specs/001-agente-reunioes-mvp/)
- Arquitectura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Constitución del proyecto: [.specify/memory/constitution.md](.specify/memory/constitution.md)

## Arquitectura en una pantalla

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

| Carpeta | Contenido |
|---|---|
| `apps/backend` | API, WebSockets, planificador de grabación, agente arquitecto, acta, Modo Agente (Playwright) |
| `apps/frontend` | UI React (Hoy, Reuniones, Reunión, Proyectos) |
| `apps/worker-gpu` | FastAPI con faster-whisper y pyannote |
| `apps/host-agent` | Servicio de escritorio: alertas, captura PipeWire, envío del audio y generación con tu suscripción (Claude Code/Codex) |
| `packages/contracts` | Tipos y esquemas compartidos |

## Requisitos

- Ubuntu con sesión gráfica (GNOME), PipeWire y GPU NVIDIA (medido en una RTX 4050, 6 GB)
- **Docker Engine nativo** + NVIDIA Container Toolkit (Docker Desktop no detecta GPU ni audio)
- `uv`, `parec`/`pactl`, `notify-send`, `zenity`, `canberra-gtk-play` y `xdg-open` en el host

## Instalación

```bash
sudo bash scripts/setup-host.sh          # NVIDIA Container Toolkit + pulseaudio-utils (una vez)
cp .env.example .env                     # completa POSTGRES_PASSWORD y AGENT_TOKEN
export DOCKER_CONTEXT=default            # siempre el Engine nativo
docker compose up -d --build
docker compose exec ollama ollama pull qwen3.5:4b
docker compose exec backend npm run user:create -- sergio --role=SUPER_ADMIN
apps/host-agent/install.sh               # servicio de escritorio (systemd --user)
```

- Genera el `AGENT_TOKEN` con `openssl rand -hex 32`.
- En la primera transcripción, el worker descarga el modelo de Whisper (~1,6 GB).
- La interfaz está en http://127.0.0.1:3000.

### Usuarios y roles

Cada usuario solo ve sus propias reuniones (y las compartidas con él).

Roles:

- **SUPER_ADMIN:** todo;
- **ADMIN:** su propio contenido y gestión de usuarios comunes;
- **USER:** su propio contenido;
- **VIEWER:** solo lectura.

El backend verifica el permiso en cada ruta.

Al migrar una base de datos antigua, el usuario más antiguo se convierte en SUPER_ADMIN y los demás se convierten en USER.

Desde la interfaz, usa **Administração > Usuários** ("Administración > Usuarios") (quien tenga `users.read`). Desde la línea de comandos:

```bash
docker compose exec backend npm run user:create -- socio            # rol USER (el 1er usuario se convierte en SUPER_ADMIN)
docker compose exec backend npm run user:create -- ana --role=ADMIN
docker compose exec backend npm run user:list
docker compose exec backend npm run user:passwd -- socio   # restablece la contraseña y cierra las sesiones
docker compose exec backend npm run user:delete -- socio
```

### Separación de hablantes (opcional)

1. Acepta los términos de
   [`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1).
2. Crea un token de lectura en https://huggingface.co/settings/tokens.
3. Colócalo en `HF_TOKEN` en el `.env` y ejecuta `docker compose up -d worker-gpu`.

Sin token, el audio de la reunión aparece como "Remoto". El micrófono siempre eres tú
(`USER_DISPLAY_NAME`). Después de la primera descarga, el modelo funciona sin conexión.

## Uso

### Hoy

- **Importar convites** ("Importar invitaciones"): en Outlook, guarda la invitación como `.ics` y arrástrala a la pantalla
  **Hoje** ("Hoy"). Reimportar actualiza la reunión sin duplicarla; una cancelación la marca como cancelada.
- **Agenda desde Aurora (Outlook)**: el asistente externo envía la agenda del día a
  `POST /api/agent/calendar/import` (`AGENT_TOKEN`, a nombre de `AGENT_OWNER`). Mismo `uid` + inicio
  actualiza en vez de duplicar (un evento único es el mismo que uno de un `.ics`; una ocurrencia de serie reprogramada en el día conserva la reunión y las elecciones); una reunión futura del mismo
  día que desaparece de la lista se cancela (vuelve si reaparece), pero una lista vacía solo limpia el día con
  `confirmEmpty: true` y un evento fuera del día se ignora sin tumbar el envío. Otros días, reuniones manuales/`.ics` y las elecciones del usuario (no grabar, generar ítems)
  no cambian, y el envío no activa grabación extra: valen las reglas de siempre. Detalles en
  [`rest-api.md`](specs/001-agente-reunioes-mvp/contracts/rest-api.md) (en portugués).
  La misma agenda del día se puede leer con `GET /api/agent/meetings?date=AAAA-MM-DD` (mismo token; por defecto
  hoy; solo lectura, en el alcance de `AGENT_OWNER`; devuelve `icalUid`, horarios, enlace, plataforma, "no grabar",
  estado y `recurring`).
- **Nova reunião** ("Nueva reunión"): registro manual con título, inicio, duración, enlace y proyecto.
- **Sin agenda el fin de semana** (`WORKING_DAYS`, por defecto lunes a viernes, en la zona horaria de la agenda): las
  series (recurrencia manual, `.ics` y Aurora) no generan ocurrencias en sábado y domingo. Una reunión única en esos
  días aparece en la agenda, pero sin recordatorio y sin que el asistente entre solo; usa **Avisar e gravar neste dia**
  ("Avisar y grabar este día") en ella (o **Enviar assistente agora**).
- El proyecto se **sugiere** según las palabras clave del título. Confírmalo en **Editar**.
- **Não gravar** ("No grabar"): disponible en la pantalla o en la alerta de escritorio; el asistente no entra.
- **Enviar assistente agora** ("Enviar asistente ahora"): envía al asistente antes de la hora programada o de nuevo después de un fallo.
- **Gravar agora** ("Grabar ahora"): solo en reuniones sin enlace; graba desde el computador (micrófono y audio del PC).

### Durante la reunión

- A la hora programada, el **asistente** entra a toda reunión con enlace de Teams/Meet que no esté marcada
  "Não gravar", con el nombre configurado, que ya dice que es el acta (ej.: "Ata do Sérgio"). Admítelo en la sala de espera.
  - Entra en silencio y sin cámara; la reunión muestra las iniciales del nombre (el invitado no tiene foto).
  - Si la red se cae al abrir el enlace, reintenta (3 veces). Una reunión que falló solo por la red se reenvía sola, dentro del horario, hasta 3 veces con 1 min entre ellas.
  - La transcripción aparece en vivo en la página de la reunión, con el agente arquitecto y el resumen actual.
  - Espera la admisión hasta el fin previsto y no sale por estar solo antes de ese momento.
  - Sale cuando la llamada termina, cuando queda solo en la llamada por 5 min (contando a las personas en
    la barra de Teams/Meet) después del fin previsto, cuando pasa del fin previsto con 3 min sin sonido,
    al pulsar **Parar** ("Detener") o a las 4 h. Sin horario previsto (asistente enviado manualmente), sale con 10 min sin sonido.
  - Si el backend se reinicia a mitad de camino y todavía es la hora, vuelve a entrar.
  - El computador no graba por sí solo (`AUTO_LOCAL_RECORDING=false`); una reunión sin enlace no se graba,
    salvo con **Gravar agora**.
- La grabación por el computador se detiene cuando pasó el horario previsto y hubo 3 min sin habla, al
  hacer clic en **Parar**, o al llegar a las 4 h.
- La pestaña **Ao vivo** ("En vivo") muestra la transcripción (con algunos segundos de retraso), el estado de los canales, la GPU,
  el resumen actual y los paneles de elementos. Con **Itens** desactivado, la extracción en vivo no corre.
- Hacer clic en un horario o en la evidencia de un elemento lleva al fragmento y reproduce el audio.

### Después de la reunión

- La transcripción final reemplaza a la transcripción en vivo. Las evidencias de los elementos se remapean.
- El agente reanaliza la reunión, consolida los elementos y genera el acta y los ADR sugeridos. Con **Itens** desactivado, genera solo el resumen (sin elementos ni ADR).
- **Itens** ("Elementos"): aprobar, rechazar, reabrir, editar y ver el historial. Los elementos creados a mano ya
  nacen aprobados. El historial es una línea de tiempo: quién hizo qué y cuándo, con el texto anterior
  tachado en las ediciones.
- **Ata** ("Acta"): siempre se arma con el estado actual de los elementos. Los rechazados desaparecen y los propuestos aparecen
  marcados. Se puede copiar o descargar en `.md`.
  - En la pantalla, fecha, horario, duración, proyecto y participantes quedan en una ficha en la parte superior; hay un índice
    de las secciones y las secciones vacías aparecen en una sola línea. El `.md` copiado o descargado mantiene las 19 secciones.
- **Resumo para enviar** ("Resumen para enviar") (pestaña Ata): texto corto para pegar en Teams o en el correo, con objetivo,
  resumen, decisiones, decisiones arquitectónicas, pendientes abiertos (responsable y plazo) y riesgos.
  Solo entran elementos aprobados; el diálogo avisa cuántos elementos aún no revisados quedaron fuera.
- **ADRs**: editar y aprobar. El número definitivo (`ADR-001`…) solo se asigna en la aprobación.
  - Filtros Activos, Propuestos, Aprobados y Rechazados; los propuestos aparecen primero.
  - Las tarjetas quedan colapsadas, mostrando el comienzo de la decisión ("Expandir todos" abre todas).
  - El enlace de la decisión de origen abre la pestaña Itens ya en su tarjeta.
- **Falantes** ("Hablantes"): cambia el nombre de "Speaker 1", etc., en la pestaña Transcrição ("Transcripción").
- **Reprocessar** ("Reprocesar"): rehace la transcripción final y el análisis.
- **Itens activados/desactivados** (interruptor bajo el panel en vivo, solo el dueño): decisiones, pendientes,
  riesgos, requisitos y ADR solo se generan en las reuniones donde activas el interruptor. Viene
  **desactivado**; una reunión de prueba asistida o de entrega queda solo con transcripción y acta con el resumen.
  - Desactivado: la extracción en vivo no corre y el análisis posterior a la reunión genera solo el resumen (sin ítems, sin ADR).
  - **Gerar itens** ("Generar ítems") activa el interruptor y pregunta dónde generar (local, OpenRouter o suscripción), como Gerar ata.
    Activado a mitad de la reunión, la extracción en vivo empieza desde ahí.
  - **Desligar itens** ("Desactivar ítems") no borra nada: lo que existe se mantiene y crear ítems a mano sigue funcionando.
  - Las reuniones anteriores a este interruptor que ya tenían ítems o análisis quedan como activadas.
- **Gerar ata** ("Generar acta") (pestaña Ata): rehace solo el análisis sobre la transcripción final, sin transcribir de nuevo.
  - Generar de nuevo empieza desde cero: borra los elementos propuestos por la IA que nadie tocó (y los ADR
    sugeridos de ellos). Quedan los aprobados, los rechazados, los editados y los creados a mano.
  - Los elementos repetidos se fusionan solos. Si uno nuevo repite uno ya revisado, es absorbido por el
    revisado (la evidencia pasa al aprobado; el repetido de uno rechazado se descarta).
- **Gerar ADRs** ("Generar ADR") (pestaña ADRs) y **Gerar ADR** ("Generar ADR") (en cada decisión arquitectónica, en la pestaña Itens): generan o
  rehacen los ADR sugeridos. Los ADR aprobados, rechazados o editados a mano no se sobrescriben.
- Cada botón pregunta dónde generar: **modelo local**, **OpenRouter** o **tu suscripción**
  (Claude Code o Codex), según lo que esté habilitado. Lo que se generó fuera aparece marcado
  ("OpenRouter", "Claude" o "Codex" en el elemento, en el ADR y en el acta).

### Compartir una reunión

En la página de la reunión, el dueño hace clic en **Compartilhar** ("Compartir"), busca a la persona por nombre o usuario (mínimo 3 letras) y elige **Leitura** (lectura) o **Edição** (edición):

- **Lectura:** la persona ve la reunión (enlace, participantes, transcripción, audio, ítems y acta).
- **Edición:** también edita ítems, ADR y nombres de hablantes. Grabar, detener, reprocesar, reprogramar, cambiar el enlace, "no grabar", "día sin agenda", cancelar, generar acta/ADR, activar ítems y eliminar siguen siendo solo del dueño. Quien no gestiona reuniones (VIEWER) solo recibe lectura.
- El dueño ve **Quem tem acesso** ("Quién tiene acceso"), cambia el nivel y quita personas. Vale al instante, incluso para quien tiene la reunión abierta (la transcripción en vivo deja de llegar). Solo el dueño ve la lista; el destinatario ve su propio nivel y el nombre del dueño.
- En una reunión recurrente, el diálogo ofrece **solo esta ocurrencia** o **esta y las siguientes ya en la agenda**. Las ocurrencias pasadas quedan fuera y las creadas después no heredan el acceso.
- En **Reuniões**, los filtros **Todas**, **Minhas** (mías), **Compartilhadas comigo** (compartidas conmigo) y **Compartilhadas por mim** (compartidas por mí) (`?escopo=`); insignia con el nivel y el dueño, marca **Nova** ("Nueva") hasta abrirla y aviso en pantalla. Nada sale de la máquina (sin correo).
- **Sair desta reunião** ("Salir de esta reunión") quita tu propio acceso. El administrador no lee contenido ajeno, y desactivar al dueño no quita el acceso de quien recibió.
- Compartir, cambiar, revocar y salir quedan en `audit_log` solo con ids (nunca título ni contenido).

### Mis tareas (pendientes)

Menú **Minhas pendências** (`tasks.read`/`tasks.manage`; el rol Lector no las tiene). La tarea es **personal**: solo quien la creó la ve y la modifica. Ni el administrador ni el superadministrador leen tareas ajenas.

- **Aprobar crea una tarea:** aprobar un **pendiente** (`pendencia`) de la reunión crea tu tarea, sin duplicar (aprobar de nuevo, reabrir y aprobar o regenerar el acta mantiene una sola). Solo se crea sola si el responsable eres tú ("eu", tu usuario o tu nombre) o está vacío, y entonces aparece como **Responsable no confirmado**. Un pendiente de otra persona no se vuelve tarea solo: el aviso dice de quién es.
- **Virar tarefa:** en cualquier ítem aprobado (riesgo, requisito, decisión...) el botón crea la tarea, con título, plazo y prioridad editables. Un ítem propuesto o rechazado no se vuelve tarea. Si ya existe una tarea parecida en la reunión, el diálogo avisa y permite crearla igual.
- **Plazo:** solo entra como fecha cuando el texto es inequívoco (`30/11`, `hasta 5/12`, `hoy`, `mañana`); "viernes" o "la semana que viene" quedan como **plazo dicho** junto al campo, para que decidas.
- **Pantalla:** contadores clicables (abiertas, atrasadas, vencen hoy, sin responsable confirmado) y filtros por estado, proyecto, plazo, responsable, prioridad, reunión y búsqueda; el filtro queda en la URL (`?status=...&prazo=overdue`). El estado cambia directo en la lista. "Hoy" y "atrasada" valen en la zona horaria del usuario.
- **Tarea manual:** **Nova tarefa** (también dentro de la reunión) con proyecto, plazo, prioridad y responsable; editar, eliminar y ver el historial (antes y después, quién y cuándo).
- **Reunión compartida:** quien recibió la reunión crea sus propias tareas de los ítems que ve. Si se revoca el acceso, la tarea continúa, sin el enlace a la reunión, al ítem y al audio (queda lo copiado mientras había acceso). Eliminar la reunión no elimina las tareas.
- **Pantalla Hoy:** tarjeta con atrasadas, vencen hoy, abiertas y pendientes propuestos por revisar.
- Nada sale de la máquina y no se llama a ninguna IA. La migración es aditiva (`tasks`, `task_history`) y no crea tareas de reuniones antiguas; usa **Virar tarefa**.

### Buscar y preguntar a las reuniones

Menú **Búsqueda** (atajo `Ctrl+K`). Exige `meetings.read`; la transcripción también exige `transcripts.read`, y acta, ítems y ADR exigen `documents.read`.

- **Buscar:** modo **híbrido** por defecto (texto en portugués, sin acento ni flexión, más búsqueda **semántica** por sentido, fusionadas con RRF). Filtros por proyecto, período, tipo de contenido y modo; cada resultado muestra el fragmento resaltado y si se halló por texto o por semántica. Al hacer clic se abre la reunión en el segmento y la hora (`?seg=`, `?t=`, `?item=`, `?adr=`), con el audio posicionado sin reproducir. Un ítem rechazado nunca aparece; un ítem o ADR propuesto aparece señalado.
- **Preguntar:** pestaña **Preguntar** (RAG local). La respuesta usa solo fragmentos de reuniones que usted puede leer, cada afirmación trae una cita clicable verificada contra el fragmento y, sin evidencia, la respuesta es **"No encontré registro"**. Los ítems y ADR aún no aprobados se rotulan "propuesto por la IA". El historial de la conversación queda solo en el navegador. El chat **siempre corre en el Ollama local** (nunca OpenRouter ni suscripción), entra en la cola detrás del análisis en vivo y, con una reunión en vivo, usa un contexto menor y avisa que puede tardar.
- **Privacidad:** el permiso se aplica dentro de la propia consulta (dueño o compartición); revocar una compartición saca la reunión de los resultados al instante; el administrador no lee contenido ajeno; el texto de búsqueda, la pregunta, la respuesta y los fragmentos nunca van a logs ni a la auditoría. El consumo aparece en **Consumo de IA** (finalidades "Búsqueda (embeddings)" y "Chat sobre reuniones").
- **Índice:** pgvector en el mismo Postgres; los embeddings (`bge-m3`) corren en Ollama **en CPU** (0 MiB de VRAM) y esperan mientras haya grabación o llamada; la búsqueda de texto funciona incluso con Ollama caído. Las reuniones antiguas se indexan en segundo plano (de la más reciente a la más antigua, reanudable tras un reinicio). **Configuración > Búsqueda** muestra el estado y **Reindexar mis reuniones**; en la terminal: `docker compose exec backend npm run search:reindex`.
- **Servidor de prueba (VPS):** solo búsqueda de texto; semántica y chat quedan desactivados (`SEARCH_SEMANTIC=off`).

### Carga y Modo Agente

En **Reuniões** ("Reuniones"):

- envía un audio/video para transcribir;
- o envía al asistente invitado a un enlace de Meet/Teams. Admite al asistente en la sala de espera.

La pantalla de la reunión muestra las etapas en vivo (la interfaz está en portugués): "Preparando agente" (preparando), "Conectando" (conectando), "Abrindo reunião" (abriendo la reunión), "Entrando" (entrando), "Aguardando admissão" (esperando admisión), "Conectado" (conectado).

El mismo enlace no recibe dos asistentes al mismo tiempo.

En la pantalla de inicio de sesión, el ícono del ojo muestra la contraseña escrita y "Esqueceu sua senha?"
("¿Olvidaste tu contraseña?") explica el camino (un administrador la restablece en Configurações > Usuários
("Configuración > Usuarios"); si estás solo, usa `npm run user:passwd`). No hay recuperación por correo
electrónico: nada sale de la máquina.

El nombre en la sala sigue **Configurações > Reuniões** ("Configuración > Reuniones"): mi nombre, nombre del agente o un nombre personalizado. No hay sufijo: el nombre debe decir que es el acta (ej.: "Ata do Sérgio" ("Acta de Sérgio")), y un nombre sin "ata" ("acta"), "gravação" ("grabación") o "transcrição" ("transcripción") entra como "Ata de <nome>" ("Acta de <nombre>"). El invitado anónimo no tiene foto en Meet/Teams: aparecen las iniciales del nombre. Con `BOT_CAMERA=true` el asistente enciende una cámara virtual con el avatar del agente (imagen fija), pero en la llamada eso se convierte en un cuadro de video.

**Cuenta del agente en Teams** (Configurações > Meu agente, "Configuración > Mi agente"): sin ella, el asistente entra a Teams como invitado sin cuenta, y Teams lo marca. Con una cuenta Microsoft **solo del agente** (nunca la tuya), entra con sesión iniciada y aparece con el nombre de la cuenta, que también debe decir que es el acta (ej.: "Ata do Sérgio"; el sistema lee el nombre real de la cuenta en la sesión y rechaza la que no lo dice, incluida la cuenta de una persona).
1. En la máquina del proyecto: `npm run teams:login`. En el navegador que se abra, entra con la cuenta del agente y elige "Mantener la sesión iniciada"; vuelve a la terminal y pulsa Enter. Se genera el archivo `teams-session.json`.
2. En Mi agente, indica el nombre de la cuenta y sube el archivo. Después borra el archivo: vale como una contraseña.
3. La contraseña nunca pasa por el sistema. Solo se guarda la sesión, cifrada (AES-256-GCM, clave derivada de `AGENT_TOKEN`) y por usuario; cambiar `AGENT_TOKEN` exige conectar de nuevo. En cada reunión Teams renueva la sesión y el sistema guarda la nueva.
4. Una sesión de la cuenta de una persona (nombre sin "ata") se rechaza; si ya estaba guardada, la pantalla muestra "Não usada" ("No usada") y el asistente entra como invitado.
5. Si la sesión vence, el asistente vuelve a entrar como invitado, la pantalla muestra "Sessão vencida" ("Sesión vencida") y repites el paso 1. La cuenta vale solo para Teams; en Meet el asistente sigue como invitado.

Cuando el asistente no entre, revisa la captura de pantalla en **Áudio e debug** ("Audio y debug").

### Configuración

Cada usuario tiene su propia configuración:

- **Perfil:** nombre real, nombre de visualización, correo, idioma, zona horaria y foto. El correo (el mismo de las invitaciones de Outlook/Teams) te reconoce entre los participantes del `.ics`: tu invitación no aparece duplicada junto al canal de tu micrófono en el acta.
- **Meu agente** ("Mi agente"): persona del agente arquitecto, tecnologías, tipos de decisión, prompt base, avatar, grabación del nombre hablado y cuenta del agente en Teams.
- **Reuniões** ("Reuniones"): identidad en la sala.
- **Documentação** ("Documentación"): nivel de detalle y formatos.
- **Consumo de IA:** cada llamada de LLM (modelo local, OpenRouter, suscripción) y cada transcripción (Whisper local o
  Deepgram externo) queda registrada con finalidad, proveedor, modelo, tokens, minutos de audio, tiempo y resultado
  (también los fallos, solo con un código corto). El panel muestra el mes o un rango libre (hasta 24 meses): totales, por
  finalidad, proveedor, modelo y día, minutos de ASR local × externo, las reuniones que más consumieron y las últimas
  llamadas, con filtro de fallos. El costo es el que informó el proveedor (nunca estimado): la suscripción y el modelo
  local muestran "sem custo por chamada" (sin costo por llamada). Es de solo lectura y no bloquea la generación. Cada
  quien ve solo el consumo de las reuniones que creó: el costo es del dueño y una reunión compartida no cuenta.
- **Segurança** ("Seguridad"): los eventos que le conciernen (entradas e intentos rechazados, con IP solo en los
  rechazos, cambio de contraseña, cuenta Teams, acciones de un administrador sobre su cuenta y envíos fuera de la
  máquina en su nombre), sin contenido de reuniones.
- **Administración > Uso de IA** (`ai_usage.read`) muestra el consumo agregado por usuario, proveedor, modelo,
  finalidad y día, sin título ni id de reunión; **Administración > Auditoria** (`audit.read`) muestra los eventos del
  sistema, siempre mediante una lista permitida de campos.
- **Retención:** el uso de IA se guarda 24 meses (`USAGE_RETENTION_DAYS=730`) y la auditoría 12 meses
  (`AUDIT_RETENTION_DAYS=365`), podados a diario; `0` guarda para siempre. El audio sigue indefinido.

## Configuración principal (`.env`)

| Variable | Predeterminado | Uso |
|---|---|---|
| `AGENT_TOKEN` | — | Secreto compartido con el host-agent (≥ 32 caracteres) |
| `USER_DISPLAY_NAME` | `Sérgio` | Nombre del canal del micrófono |
| `APP_TIMEZONE` | `America/Sao_Paulo` | Zona horaria de la agenda y del acta |
| `WORKING_DAYS` | `1,2,3,4,5` | Días con agenda (ISO, 1 = lunes … 7 = domingo). Fuera de ellos no hay recordatorio ni grabación automática |
| `ASR_MODEL` / `ASR_COMPUTE_TYPE` | `large-v3-turbo` / `int8_float16` | Whisper en el worker |
| `HF_TOKEN` | vacío | Separación de hablantes |
| `OLLAMA_MODEL` | `qwen3.5:4b` | LLM local |
| `SEARCH_ENABLED` / `SEARCH_SEMANTIC` | `true` / `auto` | Activa la búsqueda; `auto`/`on` exigen pgvector (el arranque falla con mensaje claro sin él), `off` = solo texto |
| `EMBED_MODEL` / `EMBED_DIM` | `bge-m3` / `1024` | Modelo de embedding (Ollama, en CPU) y dimensión de la columna `vector` |
| `EMBED_KEEP_ALIVE` / `EMBED_BATCH` | `10m` / `16` | Permanencia del modelo en RAM y textos por solicitud |
| `SEARCH_INDEX_DEBOUNCE_SECONDS` | 20 | Agrupa ediciones cercanas antes de reindexar la reunión |
| `CHAT_MIN_SIMILARITY` | `0.45` | Relevancia mínima para que el chat responda (por debajo: "no encontré registro") |
| `CHAT_MAX_CONTEXT_TOKENS` / `CHAT_MAX_CONTEXT_TOKENS_LIVE` | 3500 / 2000 | Contexto del chat (normal / con reunión en vivo) |
| `LIVE_EXTRACT_MIN_SPEECH_SECONDS` | 90 | Extracción en vivo cada N s de habla nueva… |
| `LIVE_EXTRACT_MAX_INTERVAL_SECONDS` | 180 | …o como máximo cada M s |
| `LIVE_CONSOLIDATE_INTERVAL_SECONDS` | 900 | Resumen actual y deduplicación |
| `SILENCE_STOP_SECONDS` / `MAX_RECORDING_MINUTES` | 180 / 240 | Reglas de parada |
| `AGENT_OWNER` | vacío | Usuario cuyas reuniones graba el host-agent de esta máquina (vacío = primer usuario registrado, si sigue siendo SUPER_ADMIN activo; defínelo siempre que haya más de un usuario) |
| `DEFAULT_AGENT_NAME` | `Assistente` | Nombre inicial del agente de cada usuario |
| `BOT_JOIN_TIMEOUT_SECONDS` | 45 | Límite para que el asistente llegue a la sala o a la espera (con la cuenta del agente en Teams, mínimo 120 s) |
| `BOT_SILENCE_STOP_MINUTES` | 10 | Silencio que termina una reunión sin horario previsto |
| `BOT_CAMERA` | `false` | Cámara virtual con el avatar del agente (imagen fija; se convierte en cuadro de video en la llamada) |
| `BOT_LIVE_TRANSCRIPTION` | `true` | Transcripción en vivo del audio grabado por el asistente |
| `MAX_AVATAR_KB` / `MAX_VOICE_KB` / `MAX_VOICE_SECONDS` | 2048 / 4096 / 60 | Límites de los archivos de perfil |
| `EGRESS_ALLOWLIST` | `ollama,worker-gpu,localhost,127.0.0.1` | Hosts a los que el backend puede acceder |

### ASR externo de prueba (opcional)

Para comparar la calidad, el pase final y las cargas pueden usar **Deepgram nova-3 vía
OpenRouter**.

> **Atención:** con esta opción, el **audio sale de la máquina**. Úsala solo con audio que la política
> de la organización permita enviar a terceros. La transcripción en vivo y todo el LLM siguen
> siendo locales.

```bash
# .env
ALLOW_EXTERNAL_ASR=true
OPENROUTER_API_KEY=sk-or-...          # https://openrouter.ai/settings/keys
ASR_PROVIDER=local                    # predeterminado; "openrouter" usa Deepgram en todo pase final
OPENROUTER_STT_MODEL=deepgram/nova-3
```

Después, `docker compose up -d backend`.

- La elección por reunión aparece en la **carga** y en **Reprocessar**.
- La reunión transcrita externamente muestra un aviso.
- Cada envío queda en `audit_log` (`external_asr`), sin contenido.
- El egress solo habilita `https://openrouter.ai/api/v1/audio/transcriptions`.
- Los hablantes se numeran cada 20 min de audio, porque el proveedor no mantiene la identidad
  entre solicitudes.

### LLM externo (opcional)

El acta y los ADR pueden generarse con un modelo de **OpenRouter** (mejor calidad que el 4B
local, con costo por uso).

> **Atención:** con esta opción, la **transcripción completa de la reunión sale de la máquina**. Úsala solo
> con contenido que la política de la organización permita enviar a terceros. El análisis en vivo
> siempre sigue siendo local.

```bash
# .env
ALLOW_EXTERNAL_LLM=true
OPENROUTER_API_KEY=sk-or-...                    # la misma clave del ASR externo
OPENROUTER_LLM_MODEL=anthropic/claude-sonnet-5  # cualquier modelo con structured outputs
LLM_GENERATION_PROVIDER=local                   # "openrouter" = análisis automático posreunión también externo
OPENROUTER_LLM_TIMEOUT_SECONDS=180
OPENROUTER_LLM_MAX_TOKENS=32000             # los modelos que razonan gastan parte de esto
```

Después, `docker --context default compose up -d backend`.

- Los botones **Gerar ata**, **Gerar ADRs** y **Gerar ADR** preguntan, en cada clic, si la generación
  es local o en OpenRouter, y avisan antes de enviar.
- Con `LLM_GENERATION_PROVIDER=openrouter`, el procesamiento automático después de cada reunión
  también usa OpenRouter. Sin `ALLOW_EXTERNAL_LLM=true`, el backend no arranca con esta opción.
- La respuesta sigue un JSON Schema estricto (`response_format`) y solo va a proveedores que lo
  admiten (`provider.require_parameters`).
- Cada llamada queda en `audit_log` (`external_llm`), con tokens y costo, sin contenido. Cada solicitud
  desde la interfaz queda en `generation_requested`.
- El egress solo habilita `https://openrouter.ai/api/v1/chat/completions`.
- Solo el dueño de la reunión genera documentos (quien recibió el contenido compartido no genera).

### Tu suscripción: Claude Code o Codex (opcional)

En lugar de pagar por uso en OpenRouter, el acta y los ADR pueden salir de **tu suscripción** de Claude
(Pro/Max) o de ChatGPT (Codex). Quien ejecuta es el **host-agent**, con `claude` o `codex`
instalados en tu máquina y con tu sesión iniciada; el backend nunca ve credenciales.

> **Atención:** la transcripción sale de la máquina y va a Anthropic o a OpenAI mediante tu plan
> personal, que sigue los términos de consumidor. Verifica en tu cuenta si las conversaciones pueden usarse
> para entrenamiento. Úsala solo con contenido que la política de la organización permita enviar.

```bash
# .env (también necesita ALLOW_EXTERNAL_LLM=true)
CLAUDE_CLI_ENABLED=true
CLAUDE_CLI_MODEL=sonnet          # sonnet, opus o el nombre completo del modelo
CODEX_CLI_ENABLED=true
CODEX_CLI_MODEL=                 # vacío = predeterminado de Codex
LLM_GENERATION_PROVIDER=claude   # opcional: análisis automático mediante la suscripción
```

1. Instala el host-agent (`apps/host-agent/install.sh`); necesita estar en ejecución.
2. **Claude:** usa el inicio de sesión normal de Claude Code (`claude` → `/login`).
3. **Codex:** usa una carpeta propia, sin tus configuraciones ni skills. Inicia sesión una vez:
   `CODEX_HOME=~/.config/agente-reunioes/codex codex login --device-auth`
4. `docker --context default compose up -d backend`

Reglas:

- Aplica solo a las reuniones del dueño del host-agent (`AGENT_OWNER`). La suscripción es personal: las
  reuniones de otra persona nunca usan tu plan.
- El diálogo muestra por qué la opción no está disponible (host-agent apagado, CLI sin sesión iniciada,
  reunión de otra persona).
- En el análisis automático, si la suscripción está fuera de servicio por un tiempo (host-agent reiniciándose, CLI
  sin sesión iniciada), la reunión espera hasta `SUBSCRIPTION_WAIT_MINUTES` (30) con el aviso "Aguardando a
  assinatura" ("Esperando la suscripción"). Si no vuelve, queda con error y la transcripción guardada; el acta sale mediante **Gerar ata**.
  Nunca cae al modelo local por eso. Solo la reunión de otra persona usa el modelo local.
- El CLI corre aislado: sin herramientas, hooks, MCP ni instrucciones del usuario, en una carpeta
  temporal, con el texto por stdin. Consume el límite de tu plan (no tiene costo por uso).
- Cada llamada queda en `audit_log` (`external_llm`, con tokens), sin contenido.

## Publicar en red (HTTPS)

No expongas el puerto 3000 sin TLS. Con el Caddy incluido:

```bash
# .env: DOMAIN=ata.suaempresa.com.br, COOKIE_SECURE=true, TRUST_PROXY=1
docker compose --profile https up -d
```

### Actualizar una instalación existente para la búsqueda (pgvector)

Postgres pasa a usar una imagen propia (`docker/postgres`: `postgres:16-alpine` con pgvector compilado). Es la **misma versión major y la misma base Alpine**, así que el volumen `pgdata` abre tal cual: sin `pg_upgrade`, sin dump/restore y sin `REINDEX`. Hágalo con el backend **ocioso** (nada grabando ni procesando):

```bash
export DOCKER_CONTEXT=default
mkdir -p ~/backups && docker compose exec postgres pg_dump -U meetingbot -Fc meetingbot > ~/backups/meetingbot-$(date +%F).dump
docker compose build postgres                       # imagen con pgvector
docker compose up -d postgres ollama                # recrea ambos con los volúmenes existentes
docker compose exec ollama ollama pull bge-m3       # descarga inicial del modelo de embedding
docker compose up -d --build backend                # la migración crea la extensión y las tablas; la indexación corre en segundo plano
```

- La migración es idempotente (`CREATE EXTENSION IF NOT EXISTS vector`) y **falla con un mensaje claro** si Postgres aún no es la imagen nueva (o use `SEARCH_SEMANTIC=off` para solo texto).
- `OLLAMA_MAX_LOADED_MODELS` pasa a 2 (embedding en CPU y LLM en la GPU cargados a la vez).
- Restaurar el dump exige Postgres de la misma versión major (16). **Rollback:** `SEARCH_ENABLED=false` en el `.env` y `docker compose up -d backend`; para volver a la imagen anterior, `DROP EXTENSION vector CASCADE;` antes de cambiar a `postgres:16-alpine` (las tablas `search_*` se reconstruyen).

### Servidor de prueba (VPS con Dokploy)

`docker-compose.vps.yml` levanta la misma aplicación en un servidor, sin GPU y sin escritorio: la transcripción
final va por OpenRouter, el acta y los ADR por tu suscripción de Claude (contenedor `agent-cli`) y
quien graba es el asistente dentro de la llamada — funciona con tu computador apagado. Paso a
paso, límites y copia de los datos: [`docs/vps-dokploy.md`](docs/vps-dokploy.md).

## Desarrollo

```bash
npm install                    # workspaces: contracts, frontend, backend
npm run typecheck
npm test                       # pruebas unitarias del backend (Vitest)
npm run test:db -w @meeting-bot/backend      # Postgres desechable en contenedor
# E2E (Chromium real, backend real, Postgres desechable en 55434, app en 3310)
npm run build -w @meeting-bot/frontend && npm run test:e2e -w @meeting-bot/backend
E2E_SHOTS=/tmp/capturas npm run test:e2e -w @meeting-bot/backend   # guarda capturas de las pantallas
(cd apps/host-agent && uv run pytest -q)
# worker sin descargar torch: solo las dependencias de las pruebas
(cd apps/worker-gpu && uv run --no-project --python 3.12 --with fastapi --with numpy \
  --with httpx --with pytest --with pydantic python -m pytest -q)
npm run dev:backend            # necesita Postgres, worker-gpu y Ollama accesibles
npm run dev:frontend           # Vite con proxy hacia /api
scripts/fixture-ics.sh 20      # invitación de prueba que empieza en 20 min
```

- El guion para probar el agente en vivo está en `scripts/roteiro-arquitetura.md`.
- Los escenarios de validación están en `specs/001-agente-reunioes-mvp/quickstart.md`.

## Limitaciones conocidas

- **Los selectores de Meet/Teams se rompen** cuando las plataformas cambian la pantalla (asistente y Modo
  Agente). Están en `apps/backend/src/bot/platforms.ts`.
- **Una grabación por computador a la vez** ("Gravar agora" o `AUTO_LOCAL_RECORDING=true`). En una
  reunión que empalma con otra, la segunda espera a que la primera se detenga (3 min sin habla después del horario)
  o a **Parar**; el host-agent avisa del conflicto. El asistente dentro de la llamada no tiene ese
  límite: entra hasta en `MAX_CONCURRENT_BOTS` reuniones al mismo tiempo.
- **El análisis en vivo usa el modelo local de 4B**, que se equivoca y repite elementos. Por eso todo elemento nace
  propuesto, con evidencia validada, y los elementos repetidos se fusionan en el análisis final. El acta y los ADR
  salen mejor con el LLM externo o la suscripción (`LLM_GENERATION_PROVIDER`).
- **Una decisión arquitectónica creada a mano** no tiene un fragmento de la transcripción asociado: su ADR se
  genera solo con la descripción y el resumen de la reunión.
- **Un host-agent por máquina**, vinculado a un solo usuario (`AGENT_OWNER`). Otros usuarios usan la
  carga o el asistente invitado.
- **El asistente invitado aparece solo con las iniciales** en la reunión: el invitado anónimo no tiene foto en Meet
  ni en Teams. La cámara virtual (`BOT_CAMERA`) muestra el ícono, pero como cuadro de video. En Teams, la
  cuenta del agente reemplaza al invitado por el nombre de la cuenta.
- **Una invitación `.ics` de una sola ocurrencia** no trae la repetición de la serie. La importación avisa; exporta
  la serie completa en Outlook.
- **Docker Desktop en Linux** no sirve: su VM no detecta la GPU ni muestra los contenedores del
  Docker nativo. Usa el Docker Engine nativo.
- **El servidor de prueba (VPS)** no tiene transcripción en vivo ni grabación por computador: solo el
  asistente en la llamada y el pase final por OpenRouter.

**Avisa a los participantes** de que la reunión está siendo grabada y transcrita (LGPD). El nombre del
asistente ya dice que es el acta, pero eso no reemplaza el aviso.

## Contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md): flujo de branches (`develop` → `homolog` → `main`),
pruebas requeridas y reglas que ningún cambio puede romper. Fallas de seguridad:
[SECURITY.md](SECURITY.md). Convivencia: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licencia

[GNU Affero General Public License v3.0 o posterior](LICENSE). Quien modifique y ofrezca el sistema
como servicio, incluso por la web, debe poner a disposición el código fuente de los cambios.
