-- What the Uptime Kuma monitors need to move into Vantage (design 6.1):
--  * a retry interval per monitor (Kuma retries some monitors only every few minutes; the default
--    stays 20 s),
--  * the message a job sends with its heartbeat (Kuma push `msg`, e.g. "pending=68"),
--  * heartbeats on Kuma's push path with Kuma's tokens, so the jobs keep their URLs,
--  * routes for a single monitor (Kuma mails some people about one job only).

alter table monitors add column retry_interval_seconds integer check (retry_interval_seconds between 10 and 3600);
grant select (retry_interval_seconds), insert (retry_interval_seconds), update (retry_interval_seconds) on monitors to vantage_hub;

alter table monitor_state add column last_heartbeat_message text;

drop function ingest_heartbeat(text);
create function ingest_heartbeat(p_token_hash text, p_message text default null) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare m record;
begin
  select id, environment_id into m from monitors
  where heartbeat_token_hash = p_token_hash and kind = 'heartbeat' and enabled;
  if not found then return false; end if;
  update monitor_state set last_heartbeat_at = now(), next_check_at = now(), last_heartbeat_message = left(p_message, 300)
  where monitor_id = m.id;
  return true;
end $$;
revoke execute on function ingest_heartbeat(text, text) from public;
grant execute on function ingest_heartbeat(text, text) to vantage_hub, vantage_worker;

alter table routes drop constraint routes_scope_kind_check;
alter table routes add constraint routes_scope_kind_check check (scope_kind in ('all', 'organisation', 'project', 'environment', 'monitor'));

-- A route for a monitor goes with it.
create function routes_drop_monitor() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from routes where scope_kind = 'monitor' and scope_id = old.id;
  return old;
end $$;
revoke execute on function routes_drop_monitor() from public;
create trigger routes_drop_monitor after delete on monitors for each row execute function routes_drop_monitor();
