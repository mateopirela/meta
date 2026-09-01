# Recuperación de DMs — reel de Cinthya

Recupera los DMs que ManyChat no mandó durante el apagón: encuentra a quién comentó
el keyword y nunca recibió el mensaje, y le manda la tarjeta de recuperación por
`private_reply` de Meta Graph API.

**Estado: listo para correr, bloqueado por dos datos que faltan.** Ver *Antes de empezar*.

---

## Antes de empezar (bloqueantes)

Nada de esto corre sin:

1. **Un System User token** con los scopes `instagram_basic`, `instagram_manage_comments`,
   `pages_messaging`, `instagram_manage_messages`. No existe en este entorno: hay que
   generarlo en el Business Manager.
2. **Que la página de FB de Cinthya esté en nuestro Business Manager.** El `private_reply`
   exige un Page Access Token de la página dueña del post. Si no está, esto no puede
   enviar y no hay forma de esquivarlo desde el código. **El paso 1 te lo responde en
   30 segundos** — corrélo apenas tengas el token, antes de invertir en lo demás.
3. **El shortcode del reel** y **el keyword** del trigger.
4. **El copy de la tarjeta** (título, texto del botón, URL con UTMs) tal como estaba en
   el flow de ManyChat, para que el DM sea el que debieron recibir.

---

## Setup

```bash
cd manychat-recovery-cinthya
cp .env.example .env    # completar; cada variable dice de dónde sale
npm test                # 102 tests, sin red — deben pasar antes de tocar nada
```

Sin dependencias: Node 24 nativo. No hay `npm install`.

## Correrlo

```bash
npm run verify      # 1. ¿podemos enviar? read-only. SI DA ROJO, PARÁ ACÁ.
npm run fetch       # 2. baja todos los comentarios -> data/comments.json
npm run classify    # 3. decide a quién -> data/final-sendable.csv
npm run send        # 4. DRY-RUN: muestra qué haría, no envía
npm run send:commit # 4b. envía de verdad
npm run reverify    # 5. confirma una muestra de los envíos
npm run report      # 6. resumen
npm run queue       # 7. (multi-reel) arma data/cola-global.csv con tarjeta por reel
npm run queue:send  # 8. DRY-RUN de la cola global · queue:commit envía
npm run reply       # 9. DRY-RUN: respuesta pública "comprueba tus DMs" a quien YA recibió el DM
npm run reply:commit
```

Probar con una tanda chica antes de soltar las 500:

```bash
node --env-file=.env src/04-send.mjs --commit --limit=10
npm run reverify -- --sample=10     # ¿los 10 quedaron registrados?
```

Si esos 10 dan verde, seguí con el resto. Si aparecen envíos caídos en silencio, hay
algo sistémico y conviene frenar antes de quemar ventana.

---

## Interfaz web (la misma recuperación, sin terminal)

```bash
npm run web        # http://127.0.0.1:8787
```

Cinco pasos, pensados para que lo use alguien que no conoce la herramienta:

| Paso | Qué hace la persona | Qué hace el sistema |
|---|---|---|
| 1. Conectar | Pega la clave de acceso (token) | La verifica al instante y muestra qué cuentas de IG administra |
| 2. El reel | Pega el enlace y la palabra clave | Encuentra la cuenta dueña sola, baja y clasifica los comentarios |
| 3. Quién falta | Mira el embudo y la lista | Explica en una frase cuántos quedaron sin respuesta y por qué |
| 4. Mensajes | Escribe la tarjeta del DM y la respuesta | Vista previa en vivo de cómo lo ve la persona en Instagram |
| 5. Enviar | Confirma y sigue el avance | Fase 1 DMs (200/h), fase 2 respuestas (60/h); pausar/reanudar; CSV |

El orden importa: **primero se busca a la gente, después se pide el copy** — nadie escribe una
tarjeta para un reel donde no quedó nadie por recuperar. El borrador del formulario se guarda
en el navegador (nunca la clave). El job se persiste en `data/jobs/` tras cada fila: podés
cerrar la pestaña, pausar y reanudar.

**El token vive solo en memoria del servidor** mientras el job corre; no va a disco ni vuelve
en ninguna respuesta. Si el servidor se reinicia, la UI lo vuelve a pedir para reanudar.
Escucha en `127.0.0.1` y **no tiene autenticación**: exponerlo en red requiere un proxy con
auth delante (`HOST=0.0.0.0` lo permite, y te lo avisa al arrancar).

Código: `web/server.mjs` (http nativo, API JSON: `/api/verify`, `/api/jobs`, `…/messages`,
`…/start`, `…/pause`, `…/export.csv`) · `web/public/` (HTML/JS/CSS sin frameworks) ·
`src/recovery.mjs` (el pipeline como funciones, sin `process.exit`) · `src/jobs.mjs`
(persistencia atómica de los jobs).

## Producción (Cloud Run + Firebase + GCS)

La misma app, desplegada como servicio para tenerla a mano cuando ManyChat se caiga:

| Pieza | Qué es | Por qué |
|---|---|---|
| **Login con Firebase** (el mismo proyecto que PreWave: `prewave-prod`, el proyecto de GCP; el viejo `prewave-prod-f1303` ya no existe) | Google sign-in; el servidor verifica el ID token contra los certificados de Google (sin `firebase-admin`) y solo deja pasar correos **verificados** de `AUTH_ALLOWED_DOMAINS` (default `30x.com`) o `AUTH_ALLOWED_EMAILS` | Cualquiera con la URL podría mandar DMs en nombre de la marca. Sin lista de permitidos el servidor **no arranca**. |
| **Jobs en GCS** (`JOBS_BUCKET=prewave-recovery-jobs`) | Un JSON por job, por la API REST con la identidad del servicio | El disco de Cloud Run es efímero: un redeploy borraría el registro de a quién ya se le mandó, y ese registro es la idempotencia. Bucket privado, con versionado. |
| **Cloud Run** `prewave-recovery` con `min=max=1` y CPU siempre asignada | Una instancia siempre viva (~US$15/mes) | El envío corre en background durante horas; con CPU acotada a requests se congela, y con N>1 dos procesos podrían tomar el mismo job. |

```bash
bash deploy/setup.sh                       # una vez: service account + bucket
bash deploy/deploy.sh                      # build en Cloud Build (sin Docker local) + deploy
```

Después del **primer** deploy, agregar el dominio del servicio en Firebase → Authentication →
Settings → *Authorized domains*; si no, el popup de Google devuelve `auth/unauthorized-domain`.

Variables (`web/server.mjs`): `AUTH_REQUIRED` (default `true` si hay `FIREBASE_PROJECT_ID`),
`FIREBASE_PROJECT_ID` / `FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN`, `AUTH_ALLOWED_DOMAINS`,
`AUTH_ALLOWED_EMAILS`, `JOBS_BUCKET`, `JOBS_PREFIX` (default `jobs/`). Para probar el bucket desde
una laptop: `GCS_ACCESS_TOKEN=$(gcloud auth print-access-token) JOBS_BUCKET=… npm run web`.

Lo que sigue igual que en local: el **token de Meta vive solo en memoria** mientras corre el
job. Un redeploy a mitad de un envío lo deja en *Interrumpida*; se reanuda pegando la clave de
nuevo, sin duplicar nada (la fila ya enviada está en el bucket).

## Modo en vivo (reemplazo de ManyChat)

La recuperación de arriba es para cuando ManyChat ya falló. **El modo en vivo es
para no depender más de ManyChat**: se configura una *automatización* una vez
(reel + palabra(s) clave + tarjeta del DM + respuesta pública opcional) y, desde
ahí, **cada comentario nuevo con la palabra recibe el DM solo**, 24/7, sin nadie
mirando. El envío es el mismo `private_reply` de siempre — es literalmente lo que
ManyChat hace por debajo.

```
                  ┌── webhook de Meta (campo `comments`) → instantáneo ┐
comentario nuevo ─┤                                                     ├─→ ledger → cola → DM
                  └── sondeo (cada ~20 s por reel activo) → ≤ 20 s     ┘        └─→ respuesta pública
```

**Los dos caminos corren a la vez y no se pisan**: los dos dedupean por
`comment_id` contra el mismo ledger, así que un comentario que llega por los dos
lados entra una sola vez (y si algo se escapara, el `2534023` de Meta lo rebota).
El sondeo es el camino primario hasta que se cargue el App Secret; después queda
como red de seguridad, porque los webhooks se pierden.

### Usarlo

Interfaz: **`/live.html`** (mismo login, mismo servidor). Una automatización pasa por:

| Estado | Qué significa |
|---|---|
| `Preparando` | Busca el reel entre las cuentas del token, lee los comentarios que ya existen (para no tratarlos como nuevos) y suscribe la página |
| `Activa` | Sondea y envía |
| `Pausada` | No detecta ni envía. Lo que ya estaba en cola espera ahí; se puede editar el copy |
| `Error` | El mensaje dice qué pasó. `Activar` reintenta |

Editar los mensajes o borrar exige **pausar** primero. Borrar elimina la
automatización y su ledger.

**Arranque con backfill** (`Responder también a los comentarios de los últimos 7
días`): al activarse, encola también los comentarios viejos que tengan la palabra,
no estén respondidos por el owner y sigan dentro de la ventana. Sin eso, arranca
solo con lo que llegue de acá en adelante.

### Los límites que respeta

Los mismos de la recuperación, por las mismas razones (ver *Las tres cosas que
cambian el resultado*): **200 DMs/hora** (1 cada 18 s) y **60 respuestas
públicas/hora** (1 por minuto), **por cuenta de Instagram** — dos automatizaciones
del mismo `@usuario` comparten la cola, no tienen una cada una. La ventana de 7
días se revalida fila por fila justo antes de enviar. Los intervalos por debajo
del piso **no arrancan el servidor**.

Lo que **no** entra al ledger: los comentarios sin la palabra, los del propio
owner (incluida nuestra respuesta pública, que vuelve por el webhook) y los
vencidos. Se cuentan como *ignorados* y se olvidan: un reel viral con 20 000
comentarios no puede inflar el archivo.

### Variables

| Variable | Default | Para qué |
|---|---|---|
| `META_SYSTEM_USER_TOKEN` | — | El System User token. **Sin esto el modo en vivo queda apagado.** En local cae a `META_TOKEN_MARKETING_INTEGRATION` |
| `META_APP_SECRET` | — | Verifica la firma del webhook. Vacío o `unset` = webhook apagado (`POST /webhooks/meta` → 503) |
| `META_WEBHOOK_VERIFY_TOKEN` | — | El string del handshake `GET /webhooks/meta` |
| `LIVE_ENABLED` | `true` si hay token | Interruptor general |
| `LIVE_POLL_INTERVAL_MS` | `20000` | Sondeo por automatización activa. Piso 10 000 |
| `LIVE_SEND_INTERVAL_MS` | `18000` | Piso 18 000 (200/hora) |
| `LIVE_REPLY_INTERVAL_MS` | `60000` | Piso 18 000 |
| `LIVE_WINDOW_SAFETY_HOURS` | `2` | Igual que `WINDOW_SAFETY_HOURS` |

En producción los tres primeros vienen de **Secret Manager** (`meta-system-user-token`,
`meta-app-secret`, `meta-webhook-verify-token`), que crea `deploy/setup.sh`. En
`--set-env-vars` no va ningún secreto: quedaría a la vista en la consola de GCP.

### API

| Método y ruta | Qué hace |
|---|---|
| `GET /api/live/status` | Estado global: si está activo, si hay token, si el webhook está configurado, cuentas y su cola |
| `GET /api/live/triggers` | Lista de automatizaciones (resumen) |
| `POST /api/live/triggers` | Crea una y arranca la preparación. `503` sin token; `409` si ya hay una para ese reel |
| `GET /api/live/triggers/:id` | La automatización + sus filas (máx. 500, la más nueva primero) + contadores |
| `POST /api/live/triggers/:id/pause` | Pausa |
| `POST /api/live/triggers/:id/activate` | Activa (o reintenta la preparación si quedó en error) |
| `POST /api/live/triggers/:id/messages` | Cambia tarjeta / respuestas / palabras. `409` si está activa |
| `DELETE /api/live/triggers/:id` | Borra automatización + ledger. `409` si está activa |
| `GET /api/live/triggers/:id/export.csv` | Las filas en CSV (mismas columnas que la recuperación + `source`, `received_at`, `attempts`, `from_id`) |
| `GET`/`POST /webhooks/meta` | Handshake y eventos de Meta. **Sin login** (Meta no puede iniciar sesión): la autenticación es la firma HMAC |

Todo `/api/live/*` pasa por el mismo login de Firebase que el resto.

### Checklist de la mañana (lo que solo puede hacer el dueño de la cuenta)

Hasta que se hagan estos pasos, el modo en vivo funciona igual **por sondeo**
(detección ≤ 20 s). Esto lo vuelve instantáneo:

1. developers.facebook.com → app **PreWave Comentarios** (`1336335331994289`) →
   *App settings → Basic* → **App Secret** → `Show`, y cargarlo:
   ```bash
   printf '%s' '<secret>' | gcloud secrets versions add meta-app-secret --project prewave-prod --data-file=-
   gcloud run services update prewave-recovery --region us-central1 --update-secrets META_APP_SECRET=meta-app-secret:latest
   ```
2. Misma app → *Products → Webhooks* → objeto **Instagram** → *Edit subscription*:
   - Callback URL: `https://prewave-recovery-ohyjsinh2a-uc.a.run.app/webhooks/meta`
   - Verify token: `gcloud secrets versions access latest --secret meta-webhook-verify-token --project prewave-prod`
   - Guardar (tiene que decir *verified*) y suscribirse al campo **`comments`**.
3. Si la app está en modo *Development*, los eventos de IG solo llegan de cuentas
   con rol en la app o en el Business. La página ya está en el BM (por eso el
   envío funciona); si igual no llegan eventos después de comentar de prueba,
   pasar la app a **Live** (no hace falta App Review para lo que usamos).
4. Probar: comentar la palabra desde una cuenta personal en el reel. En `Estado`
   tiene que aparecer `Detección: instantánea · último evento hace 0 s`.

### Qué NO hace (a propósito)

- Automatizaciones por cuenta ("cualquier reel"): hoy es un reel por automatización.
- Triggers por DM ("escribime HUMANO"): es otro webhook y otras reglas de ventana.
- Flujos de varios pasos (follow gate, captura de email): necesitan Advanced Access.

## Las tres cosas que cambian el resultado

### 1. La ventana de 7 días es el reloj que corre

`private_reply` solo funciona dentro de los **7 días de cada comentario** (no del reel).
Los comentarios viejos ya no son recuperables y no hay nada que hacer al respecto.

Por eso la cola va ordenada **del comentario más viejo al más nuevo**: los que menos
ventana les queda salen primero. Y el paso 4 **revalida la ventana fila por fila justo
antes de enviar**, porque en un run de 2,5 h hay gente que expira a mitad de camino.

El paso 3 te dice cuántos de los 500 siguen vivos. Puede ser bastante menos de 500.

### 2. El ritmo: 200/hora, no 1 cada 2 segundos

La Skill original dice *"1 send / 2s (well below Meta's 200/hr cap)"*. **Eso está mal**:
1 cada 2s son 1800/hora, nueve veces el tope. Con 3 destinatarios no se nota; con 500
chocás con el error #613 cerca del envío 200.

Acá el default es `SEND_INTERVAL_MS=18000` = 200/hora exactos, y `config.mjs` **rechaza
arrancar** si lo bajás por debajo de eso. 500 envíos ≈ **2,5 horas**. El script es
reanudable justamente porque el run es largo.

### 3. Idempotencia por partida doble

- **Nuestra**: el CSV guarda `sent_at` por fila y se escribe **después de cada envío**,
  de forma **atómica** (temporal + `rename`). Volver a correr saltea lo ya hecho. Si se
  corta la luz en el envío 300, perdés como mucho ese uno: los 299 anteriores están en
  disco. La atomicidad no es cosmética — un `writeFile` común trunca y después escribe,
  así que morirse en el medio dejaba el CSV vacío y perdías el rastro de los 299.
- **La de Meta**: un `comment_id` admite un solo `private_reply`. Un duplicado devuelve
  `400 / error_subcode 2534023`. Esto es una **red de seguridad real**: si ManyChat sí
  llegó a mandarle a alguien, nuestro envío rebota solo. Por eso el clasificador puede
  permitirse ser generoso (ver abajo).

### Qué pasa si se cae la red

En 500 llamadas a lo largo de 2,5 h, un timeout o un blip de DNS es esperable. El
enviador reintenta con backoff (30s, 60s, 90s) tanto los errores de Meta (#613 rate
limit, 429/5xx) como los fallos de red. Solo si agota los 3 intentos marca la fila como
error y sigue con la siguiente: **un hipo de red no corta el run**.

---

## Cómo decide a quién mandarle

`src/classify.mjs`, funciones puras, 23 tests.

Un comentario es **enviable** si cumple las tres:

| Corte | Criterio |
|---|---|
| Comentó el keyword | `contains`, sin acentos, case-insensitive — igual que ManyChat |
| No lo procesó ManyChat | no hay respuesta del owner que matchee `PUBLIC_REPLY_PHRASES` |
| Está dentro de los 7 días | menos el margen de `WINDOW_SAFETY_HOURS` |

**El criterio de "ya procesado" es a propósito estricto** (owner **Y** frase de la
automatización). Si Cinthya le respondió "gracias!" a mano, ese comentario cuenta como
**perdido** y se le manda el DM — porque un "gracias" no es la automatización. El riesgo
de mandar de más lo cubre el 2534023 de Meta: si ya tenía DM, rebota. Preferimos
recuperar de más y que Meta filtre, antes que dejar gente afuera.

**Si no cargás `PUBLIC_REPLY_PHRASES`**, el criterio cae al conservador: *cualquier*
respuesta del owner cuenta como procesado. Eso deja gente afuera. Vale la pena conseguir
las frases reales del flow.

---

## Por qué estas cuatro cosas no se tocan

En `meta.mjs`, `sendPrivateReply`. Salieron a golpes y cada desvío tiene su error:

| Regla | Si te desviás |
|---|---|
| Endpoint `/me/messages`, no `/{ig_user_id}/messages` | error #3 (capability missing) |
| **Page** token, no System User token | error #190 |
| `recipient.comment_id`, no `recipient.id` | #200/2534048 (pide Advanced Access) |
| `messaging_type: "RESPONSE"` | el envío no sale |

## Por qué no hay CDP acá

La Skill original maneja un puente CDP contra el Chrome real del usuario. Eso existe
para clasificar cuentas que **no** están en el Business Manager, donde la Graph API no
puede leer los comentarios.

Nuestro caso no lo necesita: **enviar el DM ya exige estar en el BM**, y esa misma
condición habilita la lectura por Graph. Si el paso 1 da verde, `/{media}/comments` lee
todo. Si da rojo, no hay envío posible y el CDP solo serviría para entregar un CSV
clasificado sin poder actuar sobre él.

## Verificación (paso 5)

Confirma reintentando **la misma tarjeta**:

- `2534023` → el original quedó registrado. **Confirmado.**
- `200 + message_id nuevo` → el original se cayó en silencio (filtro de privacidad del
  destinatario). El reintento pasó a ser la entrega real — por eso se reintenta con la
  tarjeta y no con un texto cualquiera.

**Cada verificación es un `private_reply` más y come del tope de 200/hora.** Verificar
las 500 duplica el run a ~5 h. Por eso el default es una muestra de 20, suficiente para
detectar una caída sistémica. `--all` si querés todo.

## Atribución

`REWRITE_UTM_MEDIUM=true` reescribe `utm_medium` a `ig_dm_recovery` para separar la
cohorte de recuperación de la orgánica en HubSpot. El resto de los UTMs queda intacto.
Ponelo en `false` si preferís que caigan en la misma cohorte que el reel.

## Límites conocidos

- **Cuentas privadas**: la Graph API filtra sus comentarios, así que no tenemos su
  `comment_id` y no hay forma de alcanzarlos. El paso 2 te avisa del desfasaje entre lo
  que Meta reporta y lo que devuelve.
- **Un solo card por envío**: `recipient.comment_id` admite un generic template. Los
  flows multi-paso de ManyChat (follow gate, etc.) necesitan Advanced Access.
- **No hay confirmación de lectura**: 200 + `message_id` = Meta lo aceptó. Si el usuario
  no sigue a la cuenta, le cae en Solicitudes.

## Archivos

| Path | Qué hace |
|---|---|
| `src/config.mjs` | Config + validación. Acá vive el guard del rate limit. |
| `src/meta.mjs` | Todo lo que toca la red (Graph API). El token va por header, no por query param: no loguees la URL. |
| `src/classify.mjs` | Lógica pura de "a quién le mandamos". Testeada. |
| `src/csv.mjs` | CSV RFC4180 + escritura atómica. El texto de IG trae comas, comillas y saltos de línea. |
| `src/01..08-*.mjs` | Los pasos del pipeline (DMs). |
| `src/09-public-reply.mjs` | Respuesta pública en el hilo, solo a quien ya recibió el DM. Ritmo propio, copy rotativo, pre-check de idempotencia. |
| `src/blobstore.mjs` | El store de blobs (disco o GCS) que comparten los jobs y el modo en vivo. |
| `src/live/rules.mjs` | Lógica pura del modo en vivo: a quién se le manda, firma del webhook, cursor. Testeada. |
| `src/live/engine.mjs` | El ciclo de vida de las automatizaciones. Lo único que muta su estado. |
| `src/live/poller.mjs` · `webhook.mjs` | Los dos caminos de entrada de un comentario. |
| `src/live/sender.mjs` | La cola de salida por cuenta (200 DMs/h + 60 respuestas/h). |
| `src/live/triggers.mjs` · `ledger.mjs` | Persistencia de las automatizaciones y sus filas. |
| `test/*.test.mjs` | 102 tests, sin red. |
| `test/make-fixture.mjs` | Genera 500 comentarios falsos para probar sin token. |
| `data/` | Salidas. Gitignoreado: son datos de ~500 usuarios reales. |

Probar el pipeline sin token:

```bash
node test/make-fixture.mjs 500
REEL_SHORTCODE=FIXTURE001 IG_USERNAME=cinthya TRIGGER_KEYWORD=30x \
  PUBLIC_REPLY_PHRASES='te acabo de enviar' node src/03-classify.mjs
```

## Respuesta pública (paso 9)

Lo otro que hace ManyChat: el comentario del owner debajo del de cada persona
("te envié un mensaje, comprueba tus DMs"). Se construyó **después** de ver cómo salieron
los DMs, como paso aparte, y con tres frenos que el envío no necesita:

| Freno | Por qué |
|---|---|
| Solo filas cuyo DM salió (`status` = `sent` o `likely_undeliverable_privacy`) | Nunca prometer un DM que no existe |
| Ritmo propio, default **1/min** (`PUBLIC_REPLY_INTERVAL_MS`) | N respuestas del owner en un solo hilo desde la API es el patrón que castiga el filtro de spam, y el costo es un límite sobre la cuenta, no un 400 |
| Copy rotativo (`PUBLIC_REPLY_TEXTS`, separado por barra vertical) | N veces el mismo string exacto es spam de libro |

**La idempotencia acá es nuestra, no de Meta.** A diferencia del `private_reply`,
`/{comment_id}/replies` NO rebota duplicados: dos llamadas son dos respuestas visibles. Por eso
el paso hace dos cosas: guarda `public_reply_id` por fila (atómico, tras cada una) y, antes de
responder, **lee las replies del comentario** y saltea si el owner ya respondió con alguna de
nuestras frases o de las de ManyChat (`PUBLIC_REPLY_PHRASES`). Un corte a mitad de run no
duplica ni una.

Los textos van escritos para que matcheen `PUBLIC_REPLY_PHRASES`: si alguien vuelve a correr el
paso 3, nuestras respuestas cuentan como "ya procesado", igual que las de ManyChat.

```bash
npm run reply                                                  # dry-run: a quién y con qué texto
node --env-file=.env src/09-public-reply.mjs --commit --limit=10   # tanda de prueba
npm run reply:commit                                           # el resto
```

Recorre `data/cola-global.csv` y `data/final-sendable.csv`. Usa el Page token (el que sí
"actúa" sobre la página, misma lección de las cuatro cosas de arriba); si Meta devuelve #10/#200,
probá `--system-token`. Volver a correr es seguro.
