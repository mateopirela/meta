# PLAN — Live keyword triggers (replace ManyChat)

> Implementation plan for an agent. Read the whole file before touching code.
> Prose is English; **product copy is Spanish** (UI strings, log lines, error messages — match the
> voice of `web/public/index.html` / `web/server.mjs`: tú/vos-neutral, short, concrete).
> Author: Fable 5 · 2026-08-28. Verified facts below were checked live against Meta and GCP that night.

---

## 0. Goal in one paragraph

Today `manychat-recovery-cinthya` is a **one-off recovery tool**: a human pastes a token, picks a
reel + keyword, and it backfills the DMs ManyChat failed to send. We are adding a **live mode**:
a person configures a *trigger* (reel + keyword(s) + DM card + optional public reply) once, and from
then on **every new comment containing the keyword gets the DM automatically**, 24/7, without a
human in the loop. Delivery is via Meta Graph API `private_reply` — exactly what ManyChat does
under the hood — using the sender code that already works in `src/meta.mjs`.

Two ingestion paths feed one pipeline:

```
                     ┌── Meta webhook  (field: comments)  → instant      ┐
new IG comment ──────┤                                                     ├──▶ ingest() ──▶ ledger (GCS) ──▶ drainer (200/h) ──▶ sendPrivateReply()
                     └── poller       (every ~20 s per active reel) → ≤20 s ┘                                                  └─▶ replyToComment() (60/h, optional)
```

**The poller is the primary path tonight** — the webhook needs the Meta *App Secret*, which only the
account owner can copy from the Meta developer dashboard in the morning. The webhook is wired and
ready; it activates the moment the secret is set. The poller keeps running afterwards as a safety
net that catches anything the webhook misses. Both paths dedupe on `comment_id`, so double delivery
is impossible by construction (and Meta's own `2534023` dedupe backs us up).

---

## 1. Verified facts (do not re-verify, do not contradict)

| Fact | Value / evidence |
|---|---|
| Meta app | **"PreWave Comentarios"**, app id `1336335331994289` (from `debug_token`) |
| Token | System User token in `.env` `META_TOKEN_MARKETING_INTEGRATION`; type `SYSTEM_USER`, `expires_at: 0` (never), `is_valid: true` |
| Token scopes (relevant) | `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `business_management` |
| Page | `1177706018757070` "Cinthya Page" — the **only** page the token manages today |
| IG account | `17841480692373523` `@cinthyasanchezai` (both `instagram_business_account` and `connected_instagram_account` point to it) |
| Page token | Derivable with `getPageToken(pageId, config)` (existing) — works |
| `/{page}/subscribed_apps` | Currently **empty** `{"data":[]}` — the app is NOT subscribed to the page → no webhooks can arrive yet |
| Comment ordering | `GET /{media}/comments` returns **newest first** (verified on two reels, 2026-08-28) |
| Comment fields | `id,text,timestamp,username,from{id},parent_id,replies{...}` all available on `/{media}/comments` |
| Cheap change check | `GET /{media}?fields=comments_count` works |
| Cloud Run service | `prewave-recovery`, project `prewave-prod`, region `us-central1`, `min=max=1`, `--no-cpu-throttling`, SA `prewave-recovery@prewave-prod.iam.gserviceaccount.com`, URL `https://prewave-recovery-ohyjsinh2a-uc.a.run.app` (alias `…-398822308116.us-central1.run.app`) |
| Storage | GCS bucket `gs://prewave-recovery-jobs/` (private, versioned); SA has `objectAdmin` on it. **Firestore is NOT enabled** in the project and we will not enable it — the store is GCS. |
| Secret Manager | API enabled; no Meta secrets exist yet |
| Runtime | Node 24, **zero npm dependencies**, ESM `.mjs`, `node --test`. Keep it that way. |
| Rate limits (Meta) | `private_reply` ≈ **200/h per account** (#613 beyond). `private_reply` only within **7 days of the comment**. Public replies: keep to **60/h** (spam filter, see `.env.example`) |
| Meta dedupe | second `private_reply` to the same `comment_id` → `400 / error_subcode 2534023` |

---

## 2. Non-negotiables (carry over from the recovery tool)

1. `sendPrivateReply` stays exactly as it is: `/me/messages`, **page** token, `recipient.comment_id`,
   `messaging_type: "RESPONSE"`. Every deviation has a known error code (README "Por qué estas
   cuatro cosas no se tocan").
2. Tokens never hit disk, logs, or URLs. Meta token goes in the `Authorization` header (`meta.mjs`
   already does this). Never `console.log` a URL that could contain a token. The system-user token
   now comes from an **env var populated by Secret Manager**, not from a paste.
3. Rate floors are enforced in code: DM interval ≥ 18 000 ms, public-reply interval ≥ 18 000 ms
   (default 60 000). Refuse to start below those, like `config.mjs` does.
4. Persist **after every row** (send or reply), atomically — the ledger is the idempotency.
5. No new npm dependencies. No SDKs. GCS via REST (`jobs.mjs` shows the pattern).
6. Don't break the existing recovery wizard: `npm test` (39 tests) must stay green; `/api/jobs/*`
   and `web/public/index.html` behavior unchanged except for one header link to the new page.
7. Everything user-facing in Spanish. Everything in comments/plan prose in English is fine.

---

## 3. Architecture

### 3.1 Files to add / change

```
src/
  blobstore.mjs          NEW  generic key→text store: local dir | GCS (extracted from jobs.mjs)
  jobs.mjs               CHG  use blobstore (behavior identical, same object names `jobs/<id>.json`)
  recovery.mjs           CHG  export withRetry, DM_TERMINAL, REPLY_TERMINAL, COMMENT_FIELDS (no logic change)
  live/
    rules.mjs            NEW  pure: evaluateComment, parseWebhookPayload, verifySignature,
                              shouldStopPaging, rowFromComment, tallyRows, validateTriggerInput
    triggers.mjs         NEW  trigger CRUD + persistence (`live/triggers/<id>.json`)
    ledger.mjs           NEW  per-trigger rows (`live/ledger/<id>.json`), write queue, pending selectors
    poller.mjs           NEW  incremental comment fetch per trigger (newest-first stop rule)
    sender.mjs           NEW  per-IG-account drainer (DM 200/h + public reply 60/h)
    webhook.mjs          NEW  GET verify / POST signature + ack + async ingest
    engine.mjs           NEW  boot, wiring, ingest(), status(), start/stop per trigger
web/
  server.mjs             CHG  mount /api/live/* and /webhooks/meta; boot engine
  public/
    index.html           CHG  header link → /live.html ("Automatizaciones")
    live.html            NEW  the live-triggers UI (same look as index.html, reuses styles.css)
    live.js              NEW  vanilla ESM, same auth bootstrap as app.js
    styles.css           CHG  append only what live.html needs (pills, status strip)
test/
  live-rules.test.mjs    NEW  pure rules (no network)
  live-ledger.test.mjs   NEW  ledger + triggers on a temp local dir (no network)
deploy/
  setup.sh               CHG  create secrets + grant accessor to SA
  deploy.sh              CHG  --set-secrets + new env vars
.env.example             CHG  document new vars
README.md                CHG  new section "Modo en vivo (reemplazo de ManyChat)" + morning checklist
```

### 3.2 Environment (all read in one place — `src/live/config.mjs` or top of `engine.mjs`)

| Var | Default | Meaning |
|---|---|---|
| `META_SYSTEM_USER_TOKEN` | — | System User token. **Live mode is disabled without it** (`/api/live/status` says `tokenConfigured:false`; UI explains). Local dev: same value as `META_TOKEN_MARKETING_INTEGRATION` — read that as fallback. |
| `META_APP_SECRET` | — | App secret for webhook HMAC. Values `""` or `"unset"` mean *not configured* → `POST /webhooks/meta` returns 503 and status shows `webhook.configured:false`. |
| `META_WEBHOOK_VERIFY_TOKEN` | — | Shared string for the GET handshake. Required for the GET route to answer 200. |
| `LIVE_ENABLED` | `true` if token present | Global kill switch. `false` → nothing polls, nothing sends; UI shows a banner. |
| `LIVE_POLL_INTERVAL_MS` | `20000` | Per active trigger. Floor 10 000. |
| `LIVE_SEND_INTERVAL_MS` | `18000` | Floor 18 000 (200/h). |
| `LIVE_REPLY_INTERVAL_MS` | `60000` | Floor 18 000. |
| `LIVE_WINDOW_SAFETY_HOURS` | `2` | Same semantics as `WINDOW_SAFETY_HOURS`. |
| `JOBS_BUCKET` / `JOBS_PREFIX` | existing | Blob store selection (empty bucket → local `data/`). Live keys live under `live/…` in the same bucket. |
| `GRAPH_VERSION` | `v23.0` | existing |

### 3.3 Data model (JSON in blob store)

**Trigger** — `live/triggers/<triggerId>.json` (`triggerId` = same shape as `newJobId()`: `YYYYMMDD-xxxxxx`)

```jsonc
{
  "id": "20260828-a1b2c3",
  "createdAt": "…", "createdBy": "mateo@30x.com",
  "status": "preparing" | "active" | "paused" | "error",
  "error": null,
  "input": {
    "reel": "https://www.instagram.com/reel/DcjNz6SlAkr/",   // as typed
    "shortcode": "DcjNz6SlAkr",
    "keywords": ["humano"],                                    // ≥1, matched with matchesKeyword (contains, accent/case-insensitive)
    "includeReplies": false,                                   // also trigger on replies-to-comments (parent_id present)
    "backfill": "none" | "window",                             // on activation: also queue existing keyword comments from the last 7 days
    "processedPhrases": ["te envie un mensaje", "comprueba tus dms"], // owner-reply phrases that mean "already handled" (used by backfill + reply pre-check)
    "card": { "title": "…", "buttonTitle": "…", "buttonUrl": "https://…" },   // limits: 80 / 20 / http(s)
    "replyTexts": ["¡Listo! Te envié un mensaje 📩", "…"],     // rotating; [] = no public reply
    "sendIntervalMs": 18000, "replyIntervalMs": 60000, "windowSafetyHours": 2
  },
  "resolved": { "pageId": "…", "pageName": "…", "igUserId": "…", "igUsername": "…",
                "mediaId": "…", "permalink": "…", "publishedAt": "…" },
  "cursor": { "watermark": "2026-08-28T03:14:09+0000", "seenIds": ["…", "…"], "commentsCount": 6,
              "lastPollAt": "…", "lastFullSyncAt": "…", "polls": 123, "pollErrors": 0 },
  "counts": { "pending": 0, "sent": 0, "replied": 0, "errors": 0, "skipped": 0, "ignored": 0 },
  "lastEventAt": "…",                 // last accepted comment (any source)
  "log": [ { "at": "…", "m": "…" } ]  // ring buffer, last 200
}
```

**Ledger** — `live/ledger/<triggerId>.json`

```jsonc
{ "rows": { "<comment_id>": {
    "comment_id": "…", "username": "…", "from_id": "…", "text": "…", "comment_ts": "…", "expires_at": "…",
    "source": "webhook" | "poll" | "backfill", "received_at": "…",
    "dm_status": "pending" | "sent" | "already_replied" | "comment_deleted" | "outside_window" | "expired_mid_run" | "needs_advanced_access" | "error",
    "attempts": 0, "sent_at": "", "message_id": "", "recipient_id": "", "dm_error": "",
    "reply_status": "pending" | "replied" | "already_replied" | "comment_deleted" | "error" | "skipped",
    "public_reply_id": "", "public_reply_at": "", "public_reply_text": "", "reply_error": ""
} } }
```

Only **accepted** comments (keyword matched, not owner, in window) are stored. Everything else is
counted (`counts.ignored`) and forgotten — a viral reel with 20k non-keyword comments must not bloat
the ledger. `cursor.seenIds` is capped at the newest **3000** ids (trim oldest).

`dm_status` / `reply_status` vocab and CSV columns are the same as the recovery tool
(`CSV_COLUMNS` in `web/server.mjs`), plus `source`, `received_at`, `attempts`, `from_id` — so a live
CSV opens in the same spreadsheet template.

### 3.4 Blob store (`src/blobstore.mjs`)

Extract from `jobs.mjs`:

```js
export function createStore({ bucket, prefix = "", localDir }) → {
  description,                       // "gs://bucket/prefix" | "data/…"
  async write(name, text),           // atomic locally (tmp + rename); PUT upload on GCS
  async read(name) → text | null,    // 404 → null
  async list(prefix) → [name],       // names only
  async remove(name),
}
```

- GCS: keep the metadata-server token cache + `GCS_ACCESS_TOKEN` override + 3-attempt retry exactly
  as in `jobs.mjs` today. Object name = `prefix + name`.
- Local: `localDir/<name>` with subdirectories created on demand (`live/triggers/x.json`).
- `jobs.mjs` becomes a thin wrapper: `createStore({bucket, prefix: JOBS_PREFIX, localDir: data/})`
  writing `jobs/<id>.json`… **careful**: today the GCS object name is `${JOBS_PREFIX}${id}.json`
  with `JOBS_PREFIX` default `jobs/`, and local files are `data/jobs/<id>.json`. Preserve both
  paths byte-for-byte so existing prod jobs still load. Simplest: store root prefix `""`/`data/`,
  and `jobs.mjs` passes names `jobs/<id>.json`; live passes `live/triggers/<id>.json`. Default
  `JOBS_PREFIX` stays `jobs/` — treat it as the *jobs* sub-prefix, not a store-wide prefix.
- Per-key **write queue** (serialize writes to the same key) — generalize the `queues` Map from
  `jobs.mjs` into the store or a helper both modules use.

### 3.5 Pure rules (`src/live/rules.mjs`) — this is where the tests go

```js
export function evaluateComment(comment, trigger, now = new Date())
// comment: { id, text, username, from?: {id, username}, timestamp?, parent_id? }
// returns { accept: true, row } | { accept: false, reason }
// order of cuts (first match wins):
//   "skip_owner"       from.id === resolved.igUserId || normalize(username) === normalize(resolved.igUsername)
//   "skip_reply"       parent_id present && !input.includeReplies
//   "skip_no_keyword"  !input.keywords.some(k => matchesKeyword(text, k))
//   "skip_expired"     windowStatus(timestamp ?? now, now, windowSafetyHours).expired
//   accept → row = rowFromComment(comment, source, now)   (dm_status "pending", reply_status "pending" if replyTexts.length else "skipped")

export function parseWebhookPayload(body)
// body: parsed JSON of a Meta webhook POST. Returns [] unless body.object === "instagram".
// For each entry, for each change with field === "comments":
//   { igUserId: entry.id, eventTime: new Date(entry.time*1000).toISOString(),
//     comment: { id: v.id, text: v.text, username: v.from?.username, from: v.from,
//                timestamp: v.timestamp ?? eventTime, parent_id: v.parent_id, mediaId: v.media?.id } }
// Tolerate missing fields; never throw on garbage — return [].

export function verifySignature(rawBodyBuffer, headerValue, appSecret)
// headerValue like "sha256=<hex>". HMAC-SHA256(appSecret, rawBody). timingSafeEqual on buffers of
// equal length; false on any mismatch/missing/malformed. Never throws.

export function shouldStopPaging(pageComments, cursor, { slackMs = 120_000 } = {})
// pageComments newest-first. Stop when NO comment in the page is "new":
//   new := !cursor.seenIds.includes(id) && (!cursor.watermark || ts > watermark - slackMs)
// Also stop when pageComments.length === 0.

export function advanceCursor(cursor, comments, { keep = 3000 } = {})
// returns new cursor: watermark = max(ts), seenIds = [newIds..., ...old].slice(0, keep)

export function validateTriggerInput(body) → input | throws { field, message } (Spanish messages)
// mirror validateAnalysis/validateMessages in server.mjs: reel/shortcode via parseShortcode,
// keywords: split on "," and "|", trim, dedupe, ≥1, each ≤ 60 chars; card limits CARD_TITLE_MAX /
// CARD_BUTTON_TITLE_MAX / http(s) URL; replyTexts: split on newline, trim, ≤ 10, each ≤ 300;
// processedPhrases same; intervals via floors; backfill ∈ {none, window}; includeReplies boolean.

export function tallyRows(rowsObj) → counts { pending, sent, replied, errors, skipped }
```

### 3.6 Ledger (`src/live/ledger.mjs`)

```js
export async function loadLedger(triggerId) → { rows: {} }           // missing → empty
export function saveLedger(triggerId, ledger)                         // queued, atomic
export function upsertIfAbsent(ledger, row) → boolean (true if inserted)
export function nextDm(ledgersByTrigger)     // oldest comment_ts across triggers where
                                             // dm_status === "pending" || (dm_status === "error" && attempts < 3)
export function nextReply(ledgersByTrigger)  // oldest where dm_status === "sent" && reply_status === "pending"
```

The engine keeps ledgers **in memory** (one per active trigger, loaded at boot / activation) and
persists after every mutation. That's the same trade the jobs make; a single always-on instance makes
it safe (deploy keeps `min=max=1`).

### 3.7 Poller (`src/live/poller.mjs`)

Per active trigger, every `LIVE_POLL_INTERVAL_MS` (jittered ±10 %):

1. `GET /{mediaId}?fields=comments_count` (cheap). If unchanged since `cursor.commentsCount` **and**
   `lastFullSyncAt` < 5 min ago → skip. (Deleted comments make the count drop — that's fine, treat
   any change as "look".)
2. Page `GET /{mediaId}/comments?fields=id,text,timestamp,username,from{id,username},parent_id&limit=50`
   newest-first; stop with `shouldStopPaging`; hard cap **20 pages** per poll (the next poll picks up
   where this one left because the watermark advanced).
   - If `includeReplies` is true, add `replies.limit(50){id,text,timestamp,username,from{id},parent_id}`
     and flatten replies into the candidate list.
3. Each candidate → `engine.ingest(trigger, comment, "poll")`.
4. `cursor = advanceCursor(...)`, update `commentsCount`, `lastPollAt`, `lastFullSyncAt` (when
   a fetch happened), `polls++`. Persist the trigger **only if something changed** (don't rewrite
   the trigger file 3×/min for nothing — but do persist at least every 5 min so `lastPollAt` is
   honest in the UI).
5. Errors: `GraphError` #190 → set trigger `status:"error"`, log `Meta rechazó el token (#190)…`, stop
   polling this trigger; `#4/#17/#32/#613` (rate) → back off 5× interval once; network → log once
   per 10 consecutive failures, keep going. `pollErrors++`.

Use `graphGet` from `meta.mjs` with the system-user token (reads work with it; sends need the page
token).

### 3.8 Webhook (`src/live/webhook.mjs`)

- `GET /webhooks/meta`: if `hub.mode === "subscribe" && hub.verify_token === META_WEBHOOK_VERIFY_TOKEN`
  → `200 text/plain hub.challenge`; else `403`. Respond even if `LIVE_ENABLED=false` (Meta only
  verifies once).
- `POST /webhooks/meta`: read **raw** body (Buffer, cap 1 MB). If app secret not configured → `503`
  `{error:"webhook no configurado"}`. If `verifySignature` fails → `401`. Otherwise **respond `200`
  immediately**, then `setImmediate` → `parseWebhookPayload` → for each item: find active trigger by
  `mediaId` (index in engine) → `engine.ingest(trigger, comment, "webhook")`. No trigger for that
  media → `status.webhook.ignored++`. Track `status.webhook.lastEventAt`, `events`, `accepted`.
- **Echo guard**: our own `replyToComment` fires this webhook too; `evaluateComment` drops it as
  `skip_owner`. Do not "optimize" that away.
- On trigger activation, call `ensurePageSubscribed(pageId, pageToken)`:
  `POST /{pageId}/subscribed_apps` body `{ subscribed_fields: "feed" }`. Idempotent; log result;
  failure is a warning, not a stop (polling still works). This is the API half of enabling webhooks;
  the dashboard half (callback URL + `comments` field) is manual — see §7.

### 3.9 Sender / drainer (`src/live/sender.mjs`)

One loop **per IG account** (`resolved.igUserId`), because Meta's cap is per account. Started when
the first trigger of that account becomes active; stopped when none remain.

```
state: { pageToken, nextDmAt: 0, nextReplyAt: 0, wake: () => {} }
loop:
  triggers = active triggers of this account (skip paused/error)
  now = Date.now()
  if now >= nextDmAt:
    { trigger, row } = nextDm(...)   // oldest first, like the recovery tool
    if row:
      win = windowStatus(row.comment_ts, new Date(), trigger.input.windowSafetyHours)
      if win.expired → row.dm_status="expired_mid_run", dm_error="expiró la ventana de 7 días", persist; continue (no wait)
      r = await withRetry(() => sendPrivateReply({ commentId, card: trigger.input.card, pageToken, config }), { sleep: abortableSleep, signal, log })
      ok  → sent_at, message_id, recipient_id, dm_status="sent", counts.sent++
      err → d = describeDmError(err); dm_status = d.outcome; dm_error = d.note; attempts++;
            if d.outcome === "already_replied" → sent_at = now (someone else — ManyChat? — got there first)
            if err is #190 → re-derive pageToken once; if still #190 → mark all this account's triggers "error", stop loop
      persist ledger + trigger counts; nextDmAt = now + sendIntervalMs   // only when a request was actually posted
  if now >= nextReplyAt:
    { trigger, row } = nextReply(...)
    if row and trigger.input.replyTexts.length:
      pre-check: getCommentReplies(row.comment_id, config, pageToken) → isProcessed({replies}, igUsername, [...replyTexts, ...processedPhrases])
        already → reply_status="already_replied" (no wait)   |  #100/33 → "comment_deleted"
      else text = replyTexts[counts.replied % replyTexts.length]; withRetry(replyToComment(...))
        ok → public_reply_id/at/text, reply_status="replied", counts.replied++ ; err → describeReplyError
      persist; nextReplyAt = now + replyIntervalMs   // only if posted
  sleep until min(nextDmAt, nextReplyAt, now + 5000) — abortable, and `wake()` resolves it early
  (ingest() calls wake() so a webhook comment goes out immediately when the budget allows)
```

Reuse `withRetry`, `describeDmError`, `describeReplyError`, `abortableSleep` from `recovery.mjs`
(export what's not exported yet). Don't copy them.

**Budget sharing with the recovery wizard:** both use the same 200/h. If a recovery job is running
for the same account, the drainer keeps its 18 s pace; the wizard's `withRetry` absorbs any #613.
Log a warning in both when they overlap. Do not build a shared scheduler — outages are rare.

### 3.10 Engine (`src/live/engine.mjs`)

```js
export async function bootEngine({ store, config, log })   // called once from server.mjs after jobs load
  - load all triggers; those "preparing" → "error" ("El servidor se reinició durante la preparación. Creá la automatización de nuevo.")
  - for each "active": load ledger, start poller, ensure account drainer
  - if !LIVE_ENABLED or !token: load triggers for display only, start nothing
export const engine = {
  status(),                      // { enabled, tokenConfigured, webhook:{configured, lastEventAt, events, accepted, ignored}, pollIntervalMs, accounts:[{igUserId, igUsername, pending, nextDmAt, nextReplyAt}] }
  listTriggers(), getTrigger(id), getLedger(id),
  createTrigger(input, user)     // → trigger in "preparing"; async prepare(): resolveReel (with system token) → resolved
                                 //   → full fetch with COMMENT_FIELDS (seed cursor; if backfill==="window": classifyAll → SENDABLE → rows source "backfill")
                                 //   → ensurePageSubscribed → status "active" → start poller + drainer. Errors → status "error" + Spanish message (reuse RecoveryError codes)
  activate(id), pause(id),       // pause: stop poller; drainer skips paused triggers (rows stay pending)
  updateMessages(id, partial),   // only when paused/error; card/replyTexts/processedPhrases/keywords
  remove(id),                    // only when paused/error; deletes trigger + ledger
  ingest(trigger, comment, source) // evaluateComment → upsertIfAbsent → counts/log → wake drainer; returns reason
}
```

Log lines (Spanish, terse, like `pushLog`): `@user comentó «humano» → en cola (webhook)`,
`@user: DM enviado`, `@user: ya tenía DM (Meta lo rechazó como duplicado)`, `@user: comentario
respondido`, `Sondeo: 3 comentarios nuevos, 1 con la palabra`, `Webhook activo: primer evento recibido`.

### 3.11 HTTP API (`web/server.mjs`)

All `/api/live/*` go through the existing `authenticate(req)`. Same JSON helpers, same `HttpError`.

| Method & path | Body → Response |
|---|---|
| `GET /api/live/status` | → `{ status }` (engine.status()) |
| `GET /api/live/triggers` | → `{ triggers: [summary] }` summary = id, status, shortcode, permalink, igUsername, keywords, counts, lastEventAt, createdAt, createdBy |
| `POST /api/live/triggers` | `validateTriggerInput(body)` → `201 { trigger }` (status `preparing`). `503 token_not_configured` if no system token. `409 duplicate` if an active/paused trigger already exists for the same `shortcode` |
| `GET /api/live/triggers/:id` | → `{ trigger, rows: [...sorted newest first, max 500], counts }` |
| `POST /api/live/triggers/:id/pause` | → `{ trigger }` |
| `POST /api/live/triggers/:id/activate` | → `{ trigger }` (re-runs prepare if `error` and no `resolved`) |
| `POST /api/live/triggers/:id/messages` | partial input → `{ trigger }`; `409` if active |
| `DELETE /api/live/triggers/:id` | `409` if active; → `{ ok: true }` |
| `GET /api/live/triggers/:id/export.csv` | CSV, columns = recovery `CSV_COLUMNS` + `source,received_at,attempts,from_id`, filename `automatizacion-<shortcode>.csv`, with BOM like the existing export |
| `GET /webhooks/meta` · `POST /webhooks/meta` | see §3.8 — **no Firebase auth** |

`GET /api/config` (existing, public) gains `live: { enabled, tokenConfigured, webhookConfigured }`
so the UI can render the right banner before login.

### 3.12 UI (`web/public/live.html` + `live.js`)

Same visual language as `index.html` (header, `.view-head`, cards, buttons, `styles.css`). Same
auth bootstrap as `app.js` `bootstrap()` (fetch `/api/config`, Firebase popup, `auth.getToken()`
→ `Authorization: Bearer`). Read `app.js` end-to-end first and copy its patterns (`api()`, `toast()`,
`esc()`, `fmtDate`, `updatePreview`); don't import from it (it boots the wizard on load).

Screens (single page, sections toggled):

1. **Estado** strip at the top: `Envío automático: activo` / `desactivado (LIVE_ENABLED=false)` /
   `falta la clave del sistema`; `Detección: instantánea (webhook) · último evento hace 2 min` or
   `Detección: cada 20 s (sondeo) — el webhook se activa cuando se cargue el App Secret`.
2. **Automatizaciones** list: one card per trigger — `@cuenta · reel (link) · palabra(s)` · status
   pill (`Preparando` / `Activa` / `Pausada` / `Error`) · counts `en cola · enviados · respondidos ·
   errores` · `último comentario hace …` · buttons `Pausar`/`Activar`, `Ver`, `Borrar` (confirm).
   Poll every 5 s while any trigger is `preparing`/`active`, else 30 s (mirror `schedulePoll`).
3. **Nueva automatización** form: reel URL · palabras clave (coma-separadas; hint: "se detecta si el
   comentario *contiene* la palabra, sin importar mayúsculas ni tildes — igual que ManyChat") ·
   tarjeta (título ≤80, botón ≤20, URL) with the same live preview as step 4 of the wizard ·
   respuestas públicas (una por línea, opcional; hint about the 60/h pace) · checkbox `Responder
   también a los comentarios de los últimos 7 días` (`backfill:"window"`) · checkbox `Incluir
   respuestas a otros comentarios` · frases de "ya atendido" (prefilled from replyTexts). Submit →
   list, card shows `Preparando…` with log.
4. **Detalle**: header (reel link, keywords, status), counts, actions, **activity log** (same block
   as the wizard), **table** of rows (usuario, comentario, hora, DM, respuesta, origen), `Exportar CSV`.
   Edit messages allowed only when paused (explain in a hint).

Header of both pages gets a small nav: `Recuperación · Automatizaciones`.

### 3.13 Deploy (`deploy/setup.sh`, `deploy/deploy.sh`)

`setup.sh` (idempotent) adds:

```bash
# secrets (create if missing; placeholder version so --set-secrets resolves)
for S in meta-system-user-token meta-app-secret meta-webhook-verify-token; do
  gcloud secrets describe "$S" --project "$PROJECT" >/dev/null 2>&1 || \
    gcloud secrets create "$S" --project "$PROJECT" --replication-policy automatic
  gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT" \
    --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null
done
# meta-app-secret starts as the literal "unset" (webhook disabled until the real value is added)
```

`deploy.sh` adds to `gcloud run deploy`:

```bash
--set-secrets "META_SYSTEM_USER_TOKEN=meta-system-user-token:latest,META_APP_SECRET=meta-app-secret:latest,META_WEBHOOK_VERIFY_TOKEN=meta-webhook-verify-token:latest"
# and to --set-env-vars: LIVE_ENABLED=true,LIVE_POLL_INTERVAL_MS=20000
```

Keep `--min-instances 1 --max-instances 1 --no-cpu-throttling` — the drainer and pollers are
in-process loops. Bump `--memory` to `1Gi` (ledgers in memory + JSON serialization headroom).

---

## 4. Implementation order (each step ends green on `npm test`)

1. `src/blobstore.mjs` + refactor `jobs.mjs` onto it. Run the suite. Boot `npm run web` locally and
   confirm `data/jobs/*.json` still load.
2. `src/live/rules.mjs` + `test/live-rules.test.mjs` (≈15 tests: each `evaluateComment` cut,
   webhook parse (valid / wrong object / missing fields), signature (good / bad / missing / wrong
   length), `shouldStopPaging` (all new / mixed / none / empty), `advanceCursor` cap, `validateTriggerInput`
   happy + 3 rejections).
3. `src/live/triggers.mjs`, `src/live/ledger.mjs` + `test/live-ledger.test.mjs` (≈6 tests on a temp
   dir: roundtrip, `upsertIfAbsent` dedupe, `nextDm` ordering across two ledgers, `nextReply` filter,
   error rows with attempts<3 are picked after pendings).
4. Export `withRetry`, `DM_TERMINAL`, `REPLY_TERMINAL`, `COMMENT_FIELDS` from `recovery.mjs`.
5. `poller.mjs`, `sender.mjs`, `webhook.mjs`, `engine.mjs`.
6. Routes in `server.mjs`; `/api/config` extension; boot engine after jobs load.
7. UI: `live.html`, `live.js`, `styles.css` additions, header nav in `index.html`.
8. `.env.example`, `README.md` section, `deploy/*.sh`.
9. Local smoke test with the real token (reads only — see §5).

---

## 5. Local smoke test (reads only, no DMs)

```bash
cp .env .env   # already has META_TOKEN_MARKETING_INTEGRATION → used as META_SYSTEM_USER_TOKEN fallback
LIVE_ENABLED=true npm run web
# in the UI (http://127.0.0.1:8787/live.html, auth off locally):
#  - create a trigger for a reel of @cinthyasanchezai with a keyword NOBODY has commented
#    (e.g. "zzqx-prueba"), card pointing to https://example.com, no reply texts, backfill none
#  - watch it go preparing → active; log shows "Sondeo…" every 20 s; counts stay 0
#  - pause, edit messages, activate, delete
# Also: curl -i "http://127.0.0.1:8787/webhooks/meta?hub.mode=subscribe&hub.verify_token=$META_WEBHOOK_VERIFY_TOKEN&hub.challenge=123" → 200 "123"
#       curl -i -X POST http://127.0.0.1:8787/webhooks/meta -d '{}' → 503 (no app secret) ; with META_APP_SECRET=x and bad signature → 401
```

**Do not create a trigger with a real keyword tonight.** The account owner decides when the first
live trigger goes on.

---

## 6. Acceptance checklist

- [ ] `npm test` green (39 existing + ~21 new), no network in tests.
- [ ] Recovery wizard unchanged (`/`, `/api/jobs/*`); existing GCS jobs load after the blobstore refactor.
- [ ] Trigger lifecycle: create → preparing → active → pause → edit → activate → delete, all persisted in GCS.
- [ ] Poller: a new keyword comment on the reel becomes a `pending` row within one poll interval; a
      non-keyword comment is counted as ignored, not stored; the owner's own comments are dropped.
- [ ] Drainer: sends at ≥18 s spacing, persists after each row, survives a restart (row already
      `sent` is not resent; `pending` resumes), maps errors with `describeDmError`.
- [ ] Webhook: GET handshake works; POST without secret → 503; bad signature → 401; good event →
      row within ~1 s.
- [ ] No token in any log line or URL (grep the code for `console.log` with `url`).
- [ ] `deploy/deploy.sh` deploys; `/api/live/status` on prod shows `tokenConfigured:true`,
      `webhook.configured:false` until the app secret is set.

---

## 7. Morning checklist for the account owner (Meta side — manual)

1. developers.facebook.com → app **PreWave Comentarios** (`1336335331994289`) → *App settings →
   Basic* → **App Secret** → `Show`. Then:
   `printf '%s' '<secret>' | gcloud secrets versions add meta-app-secret --project prewave-prod --data-file=-`
   and redeploy (`bash deploy/deploy.sh`) or `gcloud run services update prewave-recovery --region us-central1 --update-secrets META_APP_SECRET=meta-app-secret:latest`.
2. Same app → *Products → Webhooks* → object **Instagram** → *Edit subscription*:
   Callback URL `https://prewave-recovery-ohyjsinh2a-uc.a.run.app/webhooks/meta`, Verify token = the
   value in secret `meta-webhook-verify-token` (`gcloud secrets versions access latest --secret meta-webhook-verify-token`).
   Save → must show "verified". Subscribe to field **`comments`**.
3. If the app is in *Development* mode, IG webhooks only arrive for accounts with a role on the app /
   in the app's Business. The page is already in the BM (that's why sending works); if events still
   don't arrive after a test comment, switch the app to **Live** (App Review is not needed for the
   scopes we use with `comment_id`).
4. Test: comment the keyword from a personal account on the reel → `Estado` shows `Detección:
   instantánea · último evento hace 0 s`. Until then, polling covers it at ≤20 s.

---

## 8. Out of scope (v2 — do not build now)

- Account-wide triggers ("any reel") — needs polling `/{ig}/media` deltas or webhook-only mode.
- DM keyword triggers (someone DMs "humano") — different webhook (`messages`) + 24 h window rules.
- Multi-step flows (follow gate, email capture) — needs `recipient.id` → Advanced Access.
- Cloud Tasks queue instead of the in-process drainer — only if we ever need N>1 instances.
- Story mentions/replies.
