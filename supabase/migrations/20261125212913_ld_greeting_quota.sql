create schema ld_greeting_internal;
revoke all on schema ld_greeting_internal from public, anon, authenticated;
grant usage on schema ld_greeting_internal to service_role;

create table ld_greeting_internal.daily_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  day date not null,
  used integer not null check (used between 1 and 20)
);
alter table ld_greeting_internal.daily_usage enable row level security;
grant select, insert, update on ld_greeting_internal.daily_usage to service_role;

create function public.ld_take_greeting_slot(account_id uuid)
returns boolean language sql volatile security invoker set search_path = '' as $$
  with reservation as (
    insert into ld_greeting_internal.daily_usage as usage (user_id, day, used)
    values (account_id, (statement_timestamp() at time zone 'Europe/Stockholm')::date, 1)
    on conflict (user_id) do update
    set day = excluded.day,
        used = case when usage.day <> excluded.day then 1 else usage.used + 1 end
    where usage.day <> excluded.day or usage.used < 20
    returning 1
  )
  select exists (select 1 from reservation);
$$;

revoke all on function public.ld_take_greeting_slot(uuid) from public, anon, authenticated;
grant execute on function public.ld_take_greeting_slot(uuid) to service_role;
