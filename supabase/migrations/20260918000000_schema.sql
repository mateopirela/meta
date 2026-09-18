-- ─────────────────────────────────────────────────────────────────────────────
-- DMs por comentario: el esquema completo.
--
-- Multi-tenant: cada tabla de datos tiene `owner_uid` = auth.users.id. El
-- browser LEE sus propias filas con RLS (supabase-js) y ESCRIBE solo a traves
-- de las Edge Functions (service role): ahi vive la validacion y la Graph API.
-- El motor (sondeo, envio) son Edge Functions disparadas por pg_cron; todo el
-- estado que antes vivia en memoria esta aca.
-- ─────────────────────────────────────────────────────────────────────────────

drop table if exists public.blobs;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── Perfiles: uno por usuario, con SU token de Meta cifrado ──────────────────
create table public.profiles (
  uid               uuid primary key references auth.users (id) on delete cascade,
  email             text,
  meta_token_enc    text,                      -- v1.<iv>.<tag>.<ct>, AES-256-GCM (TOKEN_ENCRYPTION_KEY en las funciones)
  meta_token_set_at timestamptz,
  meta_accounts     jsonb not null default '[]'::jsonb,  -- [{igUserId, username, pageId, pageName}]
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
alter table public.profiles enable row level security;
-- Nadie del browser toca `profiles` directo: el token cifrado no sale de acá.
revoke all on public.profiles from anon, authenticated;

-- Lo que el browser ve de si mismo. security definer a proposito: filtra por
-- auth.uid() y NO expone meta_token_enc, solo si hay uno.
create or replace view public.me with (security_invoker = false) as
  select uid, email, meta_token_set_at, meta_accounts, (meta_token_enc is not null) as token_configured, created_at
  from public.profiles
  where uid = auth.uid();
revoke all on public.me from anon;
grant select on public.me to authenticated;

-- El perfil nace con el usuario (y sigue su correo).
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (uid, email) values (new.id, lower(new.email))
  on conflict (uid) do update set email = excluded.email;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

-- ── Recuperaciones (jobs) ────────────────────────────────────────────────────
create table public.jobs (
  id          text primary key,                -- YYYYMMDD-xxxxxx
  owner_uid   uuid not null references public.profiles (uid) on delete cascade,
  status      text not null check (status in ('analyzing','ready','running','paused','interrupted','done','error')),
  input       jsonb not null,                  -- reelUrl, shortcode, keyword, phrases, card, replyTexts, sendIntervalMs, replyIntervalMs, windowSafetyHours
  resolved    jsonb,                           -- pageId, pageName, igUserId, igUsername, mediaId, permalink, publishedAt, commentsCount
  counts      jsonb,                           -- embudo del analisis: total, sendable, skip_*
  tally       jsonb not null default '{"dm":{},"reply":{}}'::jsonb,  -- histograma de estados (lo mantiene dm_rows_recount)
  error       text,
  log         jsonb not null default '[]'::jsonb,
  created_by  text,
  started_by  text,
  claimed_at  timestamptz,                    -- el worker que esta analizando (evita dos ticks sobre el mismo job)
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  updated_at  timestamptz not null default now()
);
create index jobs_owner_idx on public.jobs (owner_uid, created_at desc);
create index jobs_status_idx on public.jobs (status);
create trigger jobs_updated_at before update on public.jobs for each row execute function public.set_updated_at();
alter table public.jobs enable row level security;
revoke all on public.jobs from anon;
grant select on public.jobs to authenticated;
create policy "jobs: own rows" on public.jobs for select to authenticated using (owner_uid = auth.uid());

-- ── Automatizaciones (triggers) ──────────────────────────────────────────────
create table public.triggers (
  id            text primary key,
  owner_uid     uuid not null references public.profiles (uid) on delete cascade,
  status        text not null check (status in ('preparing','active','paused','error')),
  error         text,
  input         jsonb not null,                -- reel, shortcode, keywords, includeReplies, backfill, processedPhrases, card, replyTexts, sendIntervalMs, replyIntervalMs, windowSafetyHours
  resolved      jsonb,
  cursor        jsonb not null default '{}'::jsonb,   -- watermark, seenIds, commentsCount, lastPollAt, lastFullSyncAt, polls, pollErrors
  counts        jsonb not null default '{"pending":0,"sent":0,"replied":0,"errors":0,"skipped":0,"ignored":0}'::jsonb,
  last_event_at timestamptz,
  claimed_at    timestamptz,                  -- el worker que la esta preparando
  log           jsonb not null default '[]'::jsonb,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index triggers_owner_idx on public.triggers (owner_uid, created_at desc);
create index triggers_status_idx on public.triggers (status);
create index triggers_media_idx on public.triggers ((resolved->>'mediaId')) where status = 'active';
create trigger triggers_updated_at before update on public.triggers for each row execute function public.set_updated_at();
alter table public.triggers enable row level security;
revoke all on public.triggers from anon;
grant select on public.triggers to authenticated;
create policy "triggers: own rows" on public.triggers for select to authenticated using (owner_uid = auth.uid());

-- ── Las filas: a quien se le manda, de una recuperacion o de una automatizacion ──
-- ES la idempotencia: la clave primaria hace imposible encolar dos veces el
-- mismo comentario (venga del webhook o del sondeo) y cada envio se persiste
-- fila por fila. `ig_user_id` esta desnormalizado porque el tope de Meta (200
-- DMs/hora) es por cuenta de Instagram, y el ritmo se lleva por cuenta.
create table public.dm_rows (
  kind              text not null check (kind in ('job','trigger')),
  parent_id         text not null,
  comment_id        text not null,
  owner_uid         uuid not null,
  ig_user_id        text not null,
  position          int not null default 0,
  username          text not null default '',
  from_id           text not null default '',
  text              text not null default '',
  comment_ts        timestamptz not null,
  expires_at        timestamptz not null,
  source            text not null default '',   -- webhook | poll | backfill | recovery
  received_at       timestamptz not null default now(),
  dm_status         text not null default 'pending',   -- pending | sending | sent | already_replied | comment_deleted | outside_window | expired_mid_run | needs_advanced_access | error
  attempts          int not null default 0,
  claimed_at        timestamptz,
  sent_at           timestamptz,
  message_id        text not null default '',
  recipient_id      text not null default '',
  dm_error          text not null default '',
  reply_status      text not null default 'pending',   -- pending | sending | replied | already_replied | comment_deleted | skipped | error
  public_reply_id   text not null default '',
  public_reply_at   timestamptz,
  public_reply_text text not null default '',
  reply_error       text not null default '',
  updated_at        timestamptz not null default now(),
  primary key (kind, parent_id, comment_id)
);
create index dm_rows_owner_idx on public.dm_rows (owner_uid);
create index dm_rows_parent_idx on public.dm_rows (kind, parent_id, comment_ts desc);
create index dm_rows_dm_pending_idx on public.dm_rows (ig_user_id, comment_ts) where dm_status in ('pending','error');
create index dm_rows_reply_pending_idx on public.dm_rows (ig_user_id, comment_ts) where dm_status = 'sent' and reply_status = 'pending';
create trigger dm_rows_updated_at before update on public.dm_rows for each row execute function public.set_updated_at();
alter table public.dm_rows enable row level security;
revoke all on public.dm_rows from anon;
grant select on public.dm_rows to authenticated;
create policy "dm_rows: own rows" on public.dm_rows for select to authenticated using (owner_uid = auth.uid());

-- ── Ritmo por cuenta de Instagram + cache del Page token ─────────────────────
create table public.send_state (
  ig_user_id     text primary key,
  next_dm_at     timestamptz not null default now(),
  next_reply_at  timestamptz not null default now(),
  page_token_enc text,
  page_token_uid uuid,
  page_token_at  timestamptz
);
alter table public.send_state enable row level security;
revoke all on public.send_state from anon, authenticated;

-- ── Contadores del webhook (una sola fila) ───────────────────────────────────
create table public.webhook_stats (
  id            int primary key default 1 check (id = 1),
  events        bigint not null default 0,
  accepted      bigint not null default 0,
  ignored       bigint not null default 0,
  last_event_at timestamptz
);
insert into public.webhook_stats (id) values (1) on conflict do nothing;
alter table public.webhook_stats enable row level security;
revoke all on public.webhook_stats from anon;
grant select on public.webhook_stats to authenticated;
create policy "webhook_stats: read" on public.webhook_stats for select to authenticated using (true);

-- ── Contadores del padre, siempre al dia ─────────────────────────────────────
-- Cada cambio en una fila recalcula el resumen del job o la automatizacion. Y
-- un job en marcha se da por terminado solo cuando no le queda nada por hacer.
create or replace function public.dm_rows_recount() returns trigger language plpgsql security definer set search_path = public as $$
declare
  k  text := coalesce(new.kind, old.kind);
  p  text := coalesce(new.parent_id, old.parent_id);
  dm jsonb;
  rp jsonb;
begin
  select coalesce(jsonb_object_agg(dm_status, n), '{}'::jsonb) into dm
    from (select dm_status, count(*) n from dm_rows where kind = k and parent_id = p group by 1) s;
  select coalesce(jsonb_object_agg(reply_status, n), '{}'::jsonb) into rp
    from (select reply_status, count(*) n from dm_rows where kind = k and parent_id = p group by 1) s;

  if k = 'trigger' then
    update triggers set counts = jsonb_build_object(
      'pending', coalesce((dm->>'pending')::int, 0) + coalesce((dm->>'sending')::int, 0),
      'sent',    coalesce((dm->>'sent')::int, 0),
      'replied', coalesce((rp->>'replied')::int, 0),
      'errors',  coalesce((dm->>'error')::int, 0) + coalesce((rp->>'error')::int, 0),
      'skipped', (select count(*) from dm_rows where kind = k and parent_id = p and dm_status not in ('pending','sending','sent','error')),
      'ignored', coalesce((counts->>'ignored')::int, 0)
    ) where id = p;
  else
    update jobs set tally = jsonb_build_object('dm', dm, 'reply', rp) where id = p;
    update jobs set status = 'done', finished_at = now()
      where id = p and status = 'running'
        and not exists (
          select 1 from dm_rows
          where kind = 'job' and parent_id = p
            and (dm_status in ('pending','sending')
              or (dm_status = 'error' and attempts < 3)
              or (dm_status = 'sent' and reply_status in ('pending','sending')))
        );
  end if;
  return null;
end $$;
create trigger dm_rows_recount after insert or update or delete on public.dm_rows
  for each row execute function public.dm_rows_recount();

-- ── RPCs del motor (solo service role: no se conceden a anon/authenticated) ──

-- Log en anillo (200 entradas) del job o la automatizacion.
create or replace function public.append_log(p_kind text, p_id text, p_msg text) returns void language plpgsql security definer set search_path = public as $$
declare entry jsonb := jsonb_build_array(jsonb_build_object('at', now(), 'm', p_msg));
begin
  if p_kind = 'job' then
    update jobs set log = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(log || entry) e offset greatest(jsonb_array_length(log || entry) - 200, 0)) s) where id = p_id;
  else
    update triggers set log = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(log || entry) e offset greatest(jsonb_array_length(log || entry) - 200, 0)) s) where id = p_id;
  end if;
end $$;

-- Cuentas de Instagram que tienen algo por enviar en un padre vivo.
create or replace function public.accounts_with_work() returns setof text language sql security definer set search_path = public as $$
  select distinct d.ig_user_id
  from dm_rows d
  left join jobs j on d.kind = 'job' and j.id = d.parent_id
  left join triggers t on d.kind = 'trigger' and t.id = d.parent_id
  where ((d.kind = 'job' and j.status = 'running') or (d.kind = 'trigger' and t.status = 'active'))
    and (d.dm_status = 'pending' or (d.dm_status = 'error' and d.attempts < 3)
      or (d.dm_status = 'sent' and d.reply_status = 'pending'))
$$;

-- Reclama el proximo DM de una cuenta: elige la fila (la mas vieja primero; los
-- errores reintentables despues), comprueba el ritmo, marca `sending` y corre
-- el reloj. Atomico: dos ticks solapados no pueden llevarse la misma fila ni
-- el mismo turno. null si no hay nada o no toca todavia.
create or replace function public.claim_next_dm(p_ig text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r      dm_rows%rowtype;
  parent jsonb;
  iv     int;
begin
  insert into send_state (ig_user_id) values (p_ig) on conflict do nothing;
  if not exists (select 1 from send_state where ig_user_id = p_ig and next_dm_at <= now()) then return null; end if;

  select d.* into r
  from dm_rows d
  left join jobs j on d.kind = 'job' and j.id = d.parent_id
  left join triggers t on d.kind = 'trigger' and t.id = d.parent_id
  where d.ig_user_id = p_ig
    and ((d.kind = 'job' and j.status = 'running') or (d.kind = 'trigger' and t.status = 'active'))
    and (d.dm_status = 'pending' or (d.dm_status = 'error' and d.attempts < 3))
  order by (d.dm_status <> 'pending'), d.comment_ts asc
  limit 1
  for update of d skip locked;
  if not found then return null; end if;

  if r.kind = 'job' then
    select jsonb_build_object('input', input, 'resolved', resolved, 'owner_uid', owner_uid) into parent from jobs where id = r.parent_id;
  else
    select jsonb_build_object('input', input, 'resolved', resolved, 'owner_uid', owner_uid) into parent from triggers where id = r.parent_id;
  end if;
  iv := greatest(coalesce((parent->'input'->>'sendIntervalMs')::int, 18000), 18000);

  update send_state set next_dm_at = now() + make_interval(secs => iv / 1000.0)
    where ig_user_id = p_ig and next_dm_at <= now();
  if not found then return null; end if;

  update dm_rows set dm_status = 'sending', claimed_at = now(), attempts = attempts + 1
    where kind = r.kind and parent_id = r.parent_id and comment_id = r.comment_id;
  r.attempts := r.attempts + 1;
  return jsonb_build_object('row', to_jsonb(r), 'parent', parent);
end $$;

-- Lo mismo para la respuesta publica: solo a quien YA recibio el DM, y solo si
-- el padre tiene textos de respuesta.
create or replace function public.claim_next_reply(p_ig text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r      dm_rows%rowtype;
  parent jsonb;
  iv     int;
begin
  insert into send_state (ig_user_id) values (p_ig) on conflict do nothing;
  if not exists (select 1 from send_state where ig_user_id = p_ig and next_reply_at <= now()) then return null; end if;

  select d.* into r
  from dm_rows d
  left join jobs j on d.kind = 'job' and j.id = d.parent_id
  left join triggers t on d.kind = 'trigger' and t.id = d.parent_id
  where d.ig_user_id = p_ig
    and d.dm_status = 'sent' and d.reply_status = 'pending'
    and ((d.kind = 'job' and j.status = 'running' and jsonb_array_length(coalesce(j.input->'replyTexts', '[]'::jsonb)) > 0)
      or (d.kind = 'trigger' and t.status = 'active' and jsonb_array_length(coalesce(t.input->'replyTexts', '[]'::jsonb)) > 0))
  order by d.comment_ts asc
  limit 1
  for update of d skip locked;
  if not found then return null; end if;

  if r.kind = 'job' then
    select jsonb_build_object('input', input, 'resolved', resolved, 'owner_uid', owner_uid, 'replied', coalesce((tally->'reply'->>'replied')::int, 0)) into parent from jobs where id = r.parent_id;
  else
    select jsonb_build_object('input', input, 'resolved', resolved, 'owner_uid', owner_uid, 'replied', coalesce((counts->>'replied')::int, 0)) into parent from triggers where id = r.parent_id;
  end if;
  iv := greatest(coalesce((parent->'input'->>'replyIntervalMs')::int, 60000), 18000);

  update send_state set next_reply_at = now() + make_interval(secs => iv / 1000.0)
    where ig_user_id = p_ig and next_reply_at <= now();
  if not found then return null; end if;

  update dm_rows set reply_status = 'sending', claimed_at = now()
    where kind = r.kind and parent_id = r.parent_id and comment_id = r.comment_id;
  return jsonb_build_object('row', to_jsonb(r), 'parent', parent);
end $$;

-- Una fila que se resolvio SIN llamar a Meta (vencio la ventana, ya estaba
-- respondida) no gasto ritmo: se devuelve el turno.
create or replace function public.refund_slot(p_ig text, p_kind text) returns void language sql security definer set search_path = public as $$
  update send_state set
    next_dm_at    = case when p_kind = 'dm' then now() else next_dm_at end,
    next_reply_at = case when p_kind = 'reply' then now() else next_reply_at end
  where ig_user_id = p_ig;
$$;

-- Filas que quedaron en `sending` porque el tick murio a mitad de camino.
create or replace function public.unstick_rows() returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with u as (
    update dm_rows set dm_status = 'pending' where dm_status = 'sending' and claimed_at < now() - interval '5 minutes' returning 1
  ), v as (
    update dm_rows set reply_status = 'pending' where reply_status = 'sending' and claimed_at < now() - interval '5 minutes' returning 1
  )
  select (select count(*) from u) + (select count(*) from v) into n;
  return n;
end $$;

create or replace function public.bump_ignored(p_trigger_id text, p_n int) returns void language sql security definer set search_path = public as $$
  update triggers set counts = jsonb_set(coalesce(counts, '{}'::jsonb), '{ignored}', to_jsonb(coalesce((counts->>'ignored')::int, 0) + p_n)) where id = p_trigger_id;
$$;

create or replace function public.touch_webhook(p_accepted int, p_ignored int) returns void language sql security definer set search_path = public as $$
  update webhook_stats set events = events + 1, accepted = accepted + p_accepted, ignored = ignored + p_ignored, last_event_at = now() where id = 1;
$$;

revoke all on function public.append_log(text, text, text) from public, anon, authenticated;
revoke all on function public.accounts_with_work() from public, anon, authenticated;
revoke all on function public.claim_next_dm(text) from public, anon, authenticated;
revoke all on function public.claim_next_reply(text) from public, anon, authenticated;
revoke all on function public.refund_slot(text, text) from public, anon, authenticated;
revoke all on function public.unstick_rows() from public, anon, authenticated;
revoke all on function public.bump_ignored(text, int) from public, anon, authenticated;
revoke all on function public.touch_webhook(int, int) from public, anon, authenticated;

-- ── El reloj: pg_cron dispara las Edge Functions ─────────────────────────────
-- Los secretos NO van en este archivo: `functions_url` y `worker_secret` se
-- cargan en Vault al desplegar (README). Los jobs los leen en cada tick.
create or replace function public.call_worker(p_name text) returns void language plpgsql security definer set search_path = public as $$
declare base text; secret text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'worker_secret';
  if base is null or secret is null then return; end if;
  perform net.http_post(
    url := base || '/' || p_name,
    headers := jsonb_build_object('content-type', 'application/json', 'x-worker-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
end $$;
revoke all on function public.call_worker(text) from public, anon, authenticated;

select cron.schedule('meta-worker-poll', '20 seconds', $$ select public.call_worker('worker-poll') $$);
select cron.schedule('meta-worker-send', '18 seconds', $$ select public.call_worker('worker-send') $$);
