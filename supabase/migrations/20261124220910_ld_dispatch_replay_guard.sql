-- Hosted pg_net exposes queued headers to database roles.
-- Queue a short-lived HMAC only, and use it at most once.
create table ld_push_internal.dispatch_ticks (
  tick bigint primary key
);
alter table ld_push_internal.dispatch_ticks enable row level security;
grant insert, select on ld_push_internal.dispatch_ticks to service_role;

drop function public.ld_claim_scheduled_pushes();

create function public.ld_claim_scheduled_pushes(signed_tick bigint)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  tick_now timestamptz := pg_catalog.statement_timestamp();
begin
  if signed_tick is null or abs(extract(epoch from tick_now) - signed_tick) > 121 then
    return jsonb_build_object('accepted', false);
  end if;

  insert into ld_push_internal.dispatch_ticks (tick) values (signed_tick)
  on conflict do nothing;
  if not found then
    return jsonb_build_object('accepted', false);
  end if;

  return jsonb_build_object('accepted', true, 'devices', (
    select coalesce(jsonb_agg(d), '[]'::jsonb)
    from ld_push_internal.claim_scheduled_pushes(tick_now) d
  ));
end;
$$;

revoke all on function public.ld_claim_scheduled_pushes(bigint) from public, anon, authenticated;
grant execute on function public.ld_claim_scheduled_pushes(bigint) to service_role;
