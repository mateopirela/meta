# meta

Instagram comment-to-DM automation on the Meta Graph API. Someone comments a keyword on your reel, they get a DM with a card (title + button), and optionally a public reply under their comment. It does what ManyChat does, with your own System User token, and it also recovers the DMs ManyChat failed to send.

**Multi-tenant.** Anyone signs up (Supabase Auth: Google or email+password), pastes their own Meta System User token once, and from then on every reel they watch and every DM they send runs on their token and their Instagram accounts. Tokens are encrypted at rest. One user never sees another's reels, queues or tokens.

**Runs entirely on Supabase + Vercel.** Postgres holds every row, pg_cron ticks the engine, Edge Functions do the work, and the static frontend lives on Vercel. There is no server to keep alive.

---

## What it does

| Mode | When | How |
|---|---|---|
| **Live** (`/live.html`) | You want DMs to go out 24/7 without watching | Create an automation: reel + keyword(s) + card + optional public reply. Every new comment with the keyword gets the DM. Detection by polling (≤20 s) plus Meta's webhook when configured. |
| **Recovery** (`/`) | ManyChat (or anything) went down and people commented with no DM | Point it at the reel and keyword. It reads every comment, finds who never got a reply, and sends the card to those still inside Meta's 7-day window. |
| **Account** (`/settings.html`) | First thing after signing up | Paste your System User token. It's verified against Meta and stored encrypted. |

Both modes send with `private_reply` on `recipient.comment_id`. That's literally what ManyChat does under the hood.

## Architecture

```
browser (Vercel, static)
  ├─ reads own rows ──────▶ Postgres (RLS: owner_uid = auth.uid())
  └─ writes ──────────────▶ Edge Function `api` ──▶ Postgres · Meta Graph API
                                                       ▲
pg_cron ── every 20 s ──▶ `worker-poll`  (prepare, analyze, poll Meta for new comments)
        ── every 18 s ──▶ `worker-send`  (one DM + one public reply per IG account, paced by Postgres)
Meta ─────── webhook ──▶ `meta-webhook` (HMAC-verified, instant ingest)
```

- **Tables** (`supabase/migrations/…_schema.sql`): `profiles` (encrypted token + reachable IG accounts), `jobs`, `triggers`, `dm_rows` (every person to DM, from either mode; primary key = idempotency), `send_state` (per-IG-account pacing + cached page token), `webhook_stats`.
- **Pacing lives in SQL.** `claim_next_dm(ig)` / `claim_next_reply(ig)` pick the oldest eligible row, check the account's clock, mark the row `sending` and advance the clock, all in one transaction. Two overlapping ticks can't double-send or exceed 200/hour.
- **Tokens**: `profiles.meta_token_enc` is AES-256-GCM (`TOKEN_ENCRYPTION_KEY`, a function secret). Decrypted only inside a function for the duration of a call. Never returned, never logged. The `me` view exposes only *whether* a token exists.
- **Auth**: functions call `auth.getUser(jwt)`; RLS uses `auth.uid()`. Verified email required; optional allowlists.
- **Ownership**: every job and automation carries `owner_uid`. The API returns 404 for anything not yours, so existence doesn't leak.

## Deploy

### 1. Supabase

```bash
supabase link --project-ref <ref>
supabase db query --linked -f supabase/migrations/20260918000000_schema.sql   # or: supabase db push
```

Secrets for the functions (`.env` has them all; see `.env.example`):

```bash
supabase secrets set --env-file .env
supabase functions deploy --no-verify-jwt
```

Then tell pg_cron where the functions live and how to authenticate (Vault, never in a migration):

```sql
select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'functions_url');
select vault.create_secret('<the same WORKER_SECRET as in .env>', 'worker_secret');
```

**Authentication → URL configuration**: Site URL = your Vercel URL, and add it to Redirect URLs (confirmation and OAuth links land there). **Providers**: Email is on by default; enable Google if you want that button.

### 2. Vercel

`web/public/` is the whole site; `vercel.json` points there with no build. `web/public/config.js` holds the project URL and the publishable key (public by design). Connect the GitHub repo and every push to `main` deploys.

### 3. Meta webhook (optional, makes detection instant)

Polling works for every tenant regardless of which Meta app their token came from. The webhook only fires for tokens generated under **your** Meta app.

1. developers.facebook.com → your app → **App settings → Basic** → App Secret → `META_APP_SECRET` secret.
2. **Products → Webhooks** → object **Instagram** → callback `https://<ref>.supabase.co/functions/v1/meta-webhook`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribe to `comments`.
3. Each automation also calls `POST /{page-id}/subscribed_apps` with the tenant's page token when it activates.

## Local development

```bash
cp .env.example .env     # fill TOKEN_ENCRYPTION_KEY and WORKER_SECRET
npm test                 # pure tests, no network
supabase start && supabase functions serve --no-verify-jwt --env-file .env   # needs Docker
npm run web              # static frontend on :8787 (edit config.js to point at local)
```

## API (`/functions/v1/api`)

All routes need `Authorization: Bearer <Supabase access token>`. Reads happen from the browser via RLS; these are the writes.

| Route | What |
|---|---|
| `GET /me` | Profile, whether a Meta token is configured, reachable IG accounts, live-mode flags. |
| `PUT /me/token` `{token}` | Verify with Meta (`/me/accounts`) and store encrypted. `400 bad_token` / `no_pages`. `409` if a recovery is running. |
| `DELETE /me/token` | Remove it. Active automations stop. |
| `POST /jobs` | Create a recovery (analysis runs on the next poll tick). `409 token_required`. |
| `POST /jobs/:id/messages` · `/start` · `/pause` · `DELETE /jobs/:id` | Card + reply + pacing; run; pause; delete. One running job per tenant. |
| `POST /triggers` | Create an automation (prepared on the next poll tick). `409 duplicate` for the same reel. |
| `POST /triggers/:id/pause` · `/activate` · `/messages` · `DELETE /triggers/:id` | Lifecycle. Edit and delete only while paused. |

## The three things that change the outcome

**The 7-day window is the clock.** `private_reply` only works within 7 days of each comment. Queues are ordered oldest-first because those expire first, and the window is re-checked per row right before sending.

**200 per hour, not 1 every 2 seconds.** Meta caps private replies at ~200/hour per account. Default pacing is 18 s per DM (exactly 200/h), enforced in SQL. Public replies go at 1/min on purpose: many owner comments in one thread in a burst is the pattern Meta's spam filter punishes.

**Idempotency, twice.** Ours: `dm_rows` has a primary key on the comment and every send is persisted per row, so a restart never resends. Meta's: a `comment_id` accepts one `private_reply`; a second returns `400 / 2534023`. That's a real safety net, which is why the classifier can afford to be generous.

## The four things in `sendPrivateReply` that don't change

| Rule | If you deviate |
|---|---|
| Endpoint `/me/messages`, not `/{ig_user_id}/messages` | error #3 |
| **Page** token (derived from the System User token), not the System User token itself | error #190 |
| `recipient.comment_id`, not `recipient.id` | #200 / 2534048 (asks for Advanced Access) |
| `messaging_type: "RESPONSE"` | the send silently doesn't go out |

## Getting a System User token (what users do)

Business Manager → Business settings → **System users** → create one (Admin) → **Generate new token** → pick the app and these permissions: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_messaging`, `pages_show_list`, `pages_read_engagement`. The Facebook page linked to the Instagram account must be in that Business Manager and assigned to the system user.

## Known limits

- Private accounts: the Graph API doesn't return their comments, so there is no `comment_id` to reply to.
- One card per DM. Multi-step flows (follow gate, email capture) need Advanced Access.
- No read receipts. `200 + message_id` means Meta accepted it; if the person doesn't follow you it lands in Requests.
- Analysis and backfill read the newest 4 000 comments of a reel (80 pages) per tick.

## CLI pipeline

`src/01-verify-access.mjs` … `src/09-public-reply.mjs` are the original single-token scripts (`npm run verify`, `fetch`, `classify`, `send`, `reverify`, `report`, `queue`, `queue:send`, `reply`). They read `META_TOKEN_MARKETING_INTEGRATION` and the reel/keyword/card from `.env`, write CSVs to `data/`, and are useful for a one-off recovery from a terminal. They share the pure modules with the functions and are not multi-tenant.

## Files

| Path | What |
|---|---|
| `supabase/migrations/` | Schema, RLS, the pacing RPCs, the cron jobs. |
| `supabase/functions/api` | The writes. |
| `supabase/functions/worker-poll` · `worker-send` · `meta-webhook` | The engine. |
| `supabase/functions/_shared/` | `classify` (who gets a DM), `rules` (live-mode decisions, webhook signature), `recovery` (reel lookup, plan), `meta` (every Graph call; token in the header, never the URL), `engine` (prepare/analyze/poll against Postgres), `tokens`/`crypto` (encrypted tokens), `auth`, `db`, `http`. |
| `web/public/` | `index.html`+`app.js` (recovery), `live.html`+`live.js` (automations), `settings.html`+`settings.js` (account), `session.js` (login), `config.js`, `csv.js`. No frameworks. |
| `src/` | CLI scripts + re-exports of the shared modules. |
| `test/` | Pure tests: classify, rules, recovery, crypto, csv. |
