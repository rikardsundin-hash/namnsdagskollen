-- Run as postgres against the project schema. All fixture changes are rolled back.
begin;

insert into auth.users (id) values
  ('01967400-0000-7000-8000-000000000001'),
  ('01967400-0000-7000-8000-000000000002'),
  ('01967400-0000-7000-8000-000000000003'),
  ('01967400-0000-7000-8000-000000000004');

insert into public.ld_push_devices (id, user_id, endpoint, p256dh, auth_secret) values
  ('01967400-0000-7000-8000-000000000011', '01967400-0000-7000-8000-000000000001', 'https://example.invalid/spring', 'fixture', 'fixture'),
  ('01967400-0000-7000-8000-000000000012', '01967400-0000-7000-8000-000000000002', 'https://example.invalid/no-consent', 'fixture', 'fixture'),
  ('01967400-0000-7000-8000-000000000013', '01967400-0000-7000-8000-000000000003', 'https://example.invalid/expired', 'fixture', 'fixture'),
  ('01967400-0000-7000-8000-000000000014', '01967400-0000-7000-8000-000000000004', 'https://example.invalid/off-date', 'fixture', 'fixture');

insert into public.reminder_plans (user_id, reminder_time, dates, enabled_at, valid_until)
values
  ('01967400-0000-7000-8000-000000000001', '02:30', array[date '2027-03-28', date '2027-10-31'], now(), '2027-10-31'),
  ('01967400-0000-7000-8000-000000000002', '02:30', array[date '2027-03-28'], null, '2027-03-28'),
  ('01967400-0000-7000-8000-000000000003', '02:30', array[date '2027-03-28'], now(), '2027-03-27'),
  ('01967400-0000-7000-8000-000000000004', '02:30', array[date '2027-03-29'], now(), '2027-03-29');

set local role service_role;

do $tests$
declare
  tick bigint := floor(extract(epoch from statement_timestamp()))::bigint;
begin
  assert ld_push_internal.stockholm_due_at('2027-01-17', '07:00') = timestamptz '2027-01-17 06:00+00', 'winter 07:00';
  assert ld_push_internal.stockholm_due_at('2027-07-18', '07:00') = timestamptz '2027-07-18 05:00+00', 'summer 07:00';
  assert ld_push_internal.stockholm_due_at('2027-03-28', '02:30') = timestamptz '2027-03-28 01:30+00', 'spring gap';
  assert ld_push_internal.stockholm_due_at('2027-10-31', '02:30') = timestamptz '2027-10-31 01:30+00', 'autumn overlap';
  assert not exists (select 1 from ld_push_internal.claim_scheduled_pushes('2027-03-28 01:29+00') where endpoint like 'https://example.invalid/%'), 'no early send';
  assert not exists (select 1 from ld_push_internal.claim_scheduled_pushes('2027-03-28 01:46+00') where endpoint like 'https://example.invalid/%'), 'no late send';
  assert (select array_agg(endpoint) from ld_push_internal.claim_scheduled_pushes('2027-03-28 01:30+00')
    where endpoint like 'https://example.invalid/%') = array['https://example.invalid/spring'], 'Sunday and eligible plans only';
  assert not exists (select 1 from ld_push_internal.claim_scheduled_pushes('2027-03-28 01:31+00') where endpoint like 'https://example.invalid/%'), 'no duplicate';
  update public.ld_push_devices set endpoint = 'https://example.invalid/previous-registration'
  where id = '01967400-0000-7000-8000-000000000011';
  update public.ld_push_devices set user_id = '01967400-0000-7000-8000-000000000004'
  where id = '01967400-0000-7000-8000-000000000011';
  insert into public.ld_push_devices (id, user_id, endpoint, p256dh, auth_secret)
    values ('01967400-0000-7000-8000-000000000015', '01967400-0000-7000-8000-000000000001', 'https://example.invalid/spring', 'fixture', 'fixture');
  assert not exists (select 1 from ld_push_internal.claim_scheduled_pushes('2027-03-28 01:32+00') where endpoint like 'https://example.invalid/%'), 'same endpoint after re-registration';
  assert not exists (select 1 from ld_push_internal.claim_scheduled_pushes('2027-10-31 00:30+00') where endpoint like 'https://example.invalid/%'), 'no first occurrence in autumn';
  assert (select count(*) from ld_push_internal.claim_scheduled_pushes('2027-10-31 01:30+00') where endpoint like 'https://example.invalid/%') = 1, 'second occurrence, new day, expiry inclusive';
  update public.reminder_plans set enabled_at = null where user_id = '01967400-0000-7000-8000-000000000004';
  assert not exists (select 1 from ld_push_internal.claim_scheduled_pushes('2027-03-29 00:30+00') where endpoint like 'https://example.invalid/%'), 'account opt-out';
  assert not has_function_privilege('authenticated','public.ld_claim_scheduled_pushes(bigint)','execute'), 'user JWT cannot claim';
  assert not has_function_privilege('anon','public.ld_claim_scheduled_pushes(bigint)','execute'), 'anonymous caller cannot claim';
  assert (public.ld_claim_scheduled_pushes(tick)->>'accepted')::boolean, 'accept a first dispatch tick';
  assert not (public.ld_claim_scheduled_pushes(tick)->>'accepted')::boolean, 'reject replay of signed tick';
  assert not (public.ld_claim_scheduled_pushes(tick - 200)->>'accepted')::boolean, 'reject expired dispatch tick';
  assert not has_table_privilege('authenticated','public.ld_push_config','select'), 'private credentials';
end;
$tests$;

set local role authenticated;

do $rls$
declare
  own_user constant uuid := '01967400-0000-7000-8000-000000000002';
  other_user constant uuid := '01967400-0000-7000-8000-000000000001';
  enabled timestamptz;
  revision timestamptz;
begin
  perform set_config('request.jwt.claim.sub', own_user::text, true);
  assert not exists (select 1 from public.reminder_plans where user_id = other_user), 'own plan reads only';
  update public.reminder_plans set enabled_at = '2025-01-01 00:00+00', valid_until = '2027-03-28'
  where user_id = own_user returning enabled_at, updated_at into enabled, revision;
  assert enabled = revision and enabled > timestamptz '2025-01-01 00:00+00', 'server timestamps explicit opt-in';
  update public.reminder_plans set reminder_time = '07:15'
  where user_id = own_user and updated_at = revision returning updated_at into revision;
  assert found and revision >= enabled, 'own plan accepts a conditional time update';
  update public.reminder_plans set reminder_time = '16:00' where user_id = other_user;
  assert not found, 'cannot modify another account plan';
  update public.reminder_plans set enabled_at = null where user_id = own_user;
  assert found, 'own plan can be disabled';
end;
$rls$;

rollback;
