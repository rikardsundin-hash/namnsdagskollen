select cron.schedule(
  'ld-push-dispatch',
  '* * * * *',
  $job$
    select ld_push_internal.invoke_dispatch();
    delete from ld_push_internal.dispatch_ticks
    where tick < floor(extract(epoch from now()))::bigint - 300;
  $job$
);
