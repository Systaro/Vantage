-- Uptime monitors. Written by admins (config) and the worker (checks, state); read under RLS.

create table monitors (
  id                   integer generated always as identity primary key,
  environment_id       integer not null references environments on delete cascade,
  name                 text not null check (length(name) between 1 and 200),
  kind                 text not null check (kind in ('http', 'tcp', 'dns', 'tls', 'heartbeat', 'kuma')),
  config               jsonb not null default '{}',
  interval_seconds     integer not null default 60 check (interval_seconds between 30 and 86400),
  timeout_ms           integer not null default 10000 check (timeout_ms between 500 and 60000),
  retries              integer not null default 1 check (retries between 0 and 10),
  enabled              boolean not null default true,
  heartbeat_token_hash text unique,
  created_at           timestamptz not null default now()
);
create index monitors_env on monitors (environment_id);

create table monitor_state (
  monitor_id            integer primary key references monitors on delete cascade,
  environment_id        integer not null references environments on delete cascade,
  status                text not null default 'pending' check (status in ('up', 'down', 'pending', 'paused')),
  since                 timestamptz not null default now(),
  last_check_at         timestamptz,
  next_check_at         timestamptz not null default now(),
  consecutive_failures  integer not null default 0,
  last_message          text,
  last_latency_ms       integer,
  tls_days_left         integer,
  last_heartbeat_at     timestamptz
);
create index monitor_state_due on monitor_state (next_check_at);

create table monitor_checks (
  id              bigint generated always as identity primary key,
  monitor_id      integer not null references monitors on delete cascade,
  environment_id  integer not null references environments on delete cascade,
  at              timestamptz not null default now(),
  ok              boolean not null,
  latency_ms      integer,
  status_code     integer,
  message         text
);
create index monitor_checks_monitor_at on monitor_checks (monitor_id, at desc);

alter table monitors enable row level security;
alter table monitor_state enable row level security;
alter table monitor_checks enable row level security;

create policy read on monitors for select using (environment_id in (select vantage_env_ids(1)));
create policy admin_write on monitors for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy read on monitor_state for select using (environment_id in (select vantage_env_ids(1)));
create policy read on monitor_checks for select using (environment_id in (select vantage_env_ids(1)));

grant select (id, environment_id, name, kind, config, interval_seconds, timeout_ms, retries, enabled, created_at)
  on monitors to vantage_hub;
grant insert (environment_id, name, kind, config, interval_seconds, timeout_ms, retries, enabled, heartbeat_token_hash)
  on monitors to vantage_hub;
grant update (name, config, interval_seconds, timeout_ms, retries, enabled, heartbeat_token_hash) on monitors to vantage_hub;
grant delete on monitors to vantage_hub;
grant select on monitor_state, monitor_checks to vantage_hub;

-- New monitors get a state row right away, so the worker picks them up without a separate step.
create function monitors_init_state() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into monitor_state (monitor_id, environment_id, status) values (new.id, new.environment_id,
    case when new.enabled then 'pending' else 'paused' end);
  return new;
end $$;
create trigger monitors_init_state after insert on monitors for each row execute function monitors_init_state();

create function monitors_sync_paused() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.enabled is distinct from old.enabled then
    update monitor_state set status = case when new.enabled then 'pending' else 'paused' end,
      since = now(), next_check_at = now(), consecutive_failures = 0
    where monitor_id = new.id;
  elsif new.config is distinct from old.config or new.interval_seconds is distinct from old.interval_seconds then
    update monitor_state set next_check_at = now() where monitor_id = new.id;
  end if;
  return new;
end $$;
create trigger monitors_sync_paused after update on monitors for each row execute function monitors_sync_paused();

-- Heartbeat push from cron jobs and backups: the token is checked here, not in application code.
create function ingest_heartbeat(p_token_hash text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare m record;
begin
  select id, environment_id into m from monitors
  where heartbeat_token_hash = p_token_hash and kind = 'heartbeat' and enabled;
  if not found then return false; end if;
  update monitor_state set last_heartbeat_at = now(), next_check_at = now() where monitor_id = m.id;
  return true;
end $$;

grant select, insert, update, delete on monitors, monitor_state, monitor_checks to vantage_worker;
revoke execute on function ingest_heartbeat(text), monitors_init_state(), monitors_sync_paused() from public;
grant execute on function ingest_heartbeat(text) to vantage_hub, vantage_worker;
