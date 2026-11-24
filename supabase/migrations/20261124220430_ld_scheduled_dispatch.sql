create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema ld_push_internal;
revoke all on schema ld_push_internal from public, anon, authenticated;
revoke all on net.http_request_queue from public, anon, authenticated;

alter table public.reminder_plans
  add column enabled_at timestamptz,
  add column valid_until date,
  add constraint ld_reminder_enabled_plan_has_expiry
    check (enabled_at is null or (valid_until is not null and reminder_time < time '24:00'));

create function ld_push_internal.stamp_reminder_plan()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  if new.enabled_at is not null then
    if tg_op = 'INSERT' or old.enabled_at is null then
      new.enabled_at := new.updated_at;
    else
      new.enabled_at := old.enabled_at;
    end if;
  end if;
  return new;
end;
$$;

create trigger ld_stamp_reminder_plan
before insert or update on public.reminder_plans
for each row execute function ld_push_internal.stamp_reminder_plan();

-- Keep the daily claim if the same endpoint is disabled and registered again.
-- The ledger stores only an opaque device ID and a SHA-256 fingerprint.
alter table public.ld_push_deliveries
  drop constraint ld_push_deliveries_device_id_fkey,
  add column endpoint_hash bytea,
  add column provider_status integer,
  add column failure text;

create unique index ld_push_deliveries_endpoint_day
  on public.ld_push_deliveries (endpoint_hash, day);
create index ld_push_deliveries_day on public.ld_push_deliveries (day);

create function ld_push_internal.stockholm_due_at(day date, reminder_time time)
returns timestamptz
language sql stable security invoker set search_path = '' as $$
  select (day + reminder_time) at time zone 'Europe/Stockholm';
$$;

create function ld_push_internal.claim_scheduled_pushes(tick timestamptz)
returns table (device_id uuid, day date, endpoint text, p256dh text, auth_secret text)
language sql volatile security invoker set search_path = '' as $$
  with local_day as (
    select (tick at time zone 'Europe/Stockholm')::date as day
  ), due as (
    select d.id, l.day, d.endpoint, d.p256dh, d.auth_secret,
      extensions.digest(d.endpoint, 'sha256') as endpoint_hash
    from public.ld_push_devices d
    join public.reminder_plans p on p.user_id = d.user_id
    cross join local_day l
    cross join lateral (
      select ld_push_internal.stockholm_due_at(l.day, p.reminder_time) as at
    ) schedule
    where p.enabled_at is not null
      and p.valid_until >= l.day
      and p.timezone = 'Europe/Stockholm'
      and p.dates @> array[l.day]
      and schedule.at between tick - interval '15 minutes' and tick
      and p.enabled_at <= schedule.at
      and not exists (
        select 1 from public.ld_push_deliveries h
        where h.day = l.day and h.endpoint_hash = extensions.digest(d.endpoint, 'sha256')
      )
      and not exists (
        select 1 from public.ld_push_deliveries h where h.device_id = d.id and h.day = l.day
      )
    order by schedule.at, d.id
    limit 50
    for update of d, p skip locked
  ), claims as (
    insert into public.ld_push_deliveries (device_id, day, endpoint_hash)
    select due.id, due.day, due.endpoint_hash from due
    on conflict do nothing
    returning ld_push_deliveries.device_id, ld_push_deliveries.day
  )
  select c.device_id, c.day, d.endpoint, d.p256dh, d.auth_secret
  from claims c join due d on d.id = c.device_id and d.day = c.day;
$$;

-- Only the dispatcher may claim, and its RPC always uses database time.
create function public.ld_claim_scheduled_pushes()
returns table (device_id uuid, day date, endpoint text, p256dh text, auth_secret text)
language sql volatile security invoker set search_path = '' as $$
  select * from ld_push_internal.claim_scheduled_pushes(pg_catalog.statement_timestamp());
$$;

revoke all on function public.ld_claim_scheduled_pushes() from public, anon, authenticated;
grant execute on function public.ld_claim_scheduled_pushes() to service_role;
revoke all on function ld_push_internal.claim_scheduled_pushes(timestamptz) from public, anon, authenticated;
grant usage on schema ld_push_internal to service_role;
grant execute on function ld_push_internal.claim_scheduled_pushes(timestamptz) to service_role;

create function ld_push_internal.invoke_dispatch()
returns bigint language sql volatile security invoker set search_path = '' as $$
  with tick as (
    select floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint::text as timestamp
  )
  select net.http_post(
    url := 'https://vwzblmjkshlctgnwgxct.supabase.co/functions/v1/ld-push-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ld-timestamp', tick.timestamp,
      'x-ld-signature', encode(extensions.hmac('ld-push-dispatch:v1:' || tick.timestamp, cfg.cron_token, 'sha256'), 'hex')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 45000
  )
  from public.ld_push_config cfg cross join tick
  where cfg.id;
$$;

revoke all on function ld_push_internal.invoke_dispatch() from public, anon, authenticated, service_role;
