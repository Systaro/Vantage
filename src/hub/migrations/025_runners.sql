-- Runners (design 6.7): a process Systaro installs inside a customer network. It only connects out,
-- asks the hub what to check and posts results back: uptime probes for monitors assigned to it and
-- reports of servers it reads over SSH. Read-only: it executes nothing it receives.
--
-- The runner talks to the hub through SECURITY DEFINER functions that check its token hash and that
-- every result belongs to one of its monitors or servers. Results land in queue tables; the worker
-- applies them with the same code as its own probes and as ops' host checks.

create table runners (
  id               integer generated always as identity primary key,
  organisation_id  integer not null references organisations on delete cascade,
  name             text not null check (length(name) between 1 and 100),
  token_hash       text not null unique,
  token_prefix     text not null,
  created_by       integer references users on delete set null,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  version          text,
  ssh_public_key   text,
  -- Set while the runner is silent and its event is open.
  silent_since     timestamptz,
  revoked_at       timestamptz,
  unique (organisation_id, name)
);

alter table runners enable row level security;
create policy admin_all on runners for all using (vantage_is_admin()) with check (vantage_is_admin());
-- The hub never reads token hashes back; only the runner_* functions compare them.
grant select (id, organisation_id, name, token_prefix, created_by, created_at, last_seen_at, version, ssh_public_key, silent_since, revoked_at)
  on runners to vantage_hub;
grant insert (organisation_id, name, token_hash, token_prefix, created_by) on runners to vantage_hub;
grant update (name, token_hash, token_prefix, revoked_at) on runners to vantage_hub;
grant delete on runners to vantage_hub;
grant select, update on runners to vantage_worker;

-- A monitor is probed by the worker (null) or by a runner of its organisation. A runner with
-- monitors cannot be deleted: they would silently move to the internet and fail there.
alter table monitors add column runner_id integer references runners on delete restrict;
create index monitors_runner on monitors (runner_id) where runner_id is not null;
grant select (runner_id), insert (runner_id), update (runner_id) on monitors to vantage_hub;

create function monitors_check_runner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.runner_id is not null and not exists (
    select 1 from runners r join projects p on p.organisation_id = r.organisation_id
    join environments e on e.project_id = p.id
    where r.id = new.runner_id and e.id = new.environment_id) then
    raise exception 'runner % does not belong to the organisation of environment %', new.runner_id, new.environment_id;
  end if;
  if new.runner_id is not null and new.kind not in ('http', 'tcp', 'dns', 'tls', 'health') then
    raise exception 'monitors of kind % cannot run on a runner', new.kind;
  end if;
  return new;
end $$;
create trigger monitors_check_runner before insert or update of runner_id, environment_id, kind on monitors
  for each row execute function monitors_check_runner();

-- Probe results from runners, applied by the worker in order.
create table runner_results (
  id             bigint generated always as identity primary key,
  runner_id      integer not null references runners on delete cascade,
  monitor_id     integer not null references monitors on delete cascade,
  at             timestamptz not null,
  ok             boolean not null,
  latency_ms     integer,
  status_code    integer,
  message        text not null,
  details        jsonb,
  tls_days_left  integer
);
alter table runner_results enable row level security;
grant select, delete on runner_results to vantage_worker;

-- ── Servers checked by runners ───────────────────────────────────────────────────────────────────

create table servers (
  id               integer generated always as identity primary key,
  environment_id   integer not null references environments on delete cascade,
  runner_id        integer not null references runners on delete cascade,
  name             text not null check (length(name) between 1 and 100),
  -- user@host or host; validated by the hub so it can never be read as an ssh option.
  ssh_target       text not null check (length(ssh_target) between 1 and 300),
  interval_seconds integer not null default 300 check (interval_seconds between 60 and 86400),
  thresholds       jsonb not null default '{}',
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  last_report_at   timestamptz,
  last_error       text,
  silent_since     timestamptz,
  unique (environment_id, name)
);

create function servers_check_runner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from runners r join projects p on p.organisation_id = r.organisation_id
    join environments e on e.project_id = p.id
    where r.id = new.runner_id and e.id = new.environment_id) then
    raise exception 'runner % does not belong to the organisation of environment %', new.runner_id, new.environment_id;
  end if;
  return new;
end $$;
create trigger servers_check_runner before insert or update of runner_id, environment_id on servers
  for each row execute function servers_check_runner();

-- Reports as the runner sent them; `results` and `processed_at` are filled by the worker.
create table server_reports (
  id              bigint generated always as identity primary key,
  server_id       integer not null references servers on delete cascade,
  environment_id  integer not null references environments on delete cascade,
  at              timestamptz not null,
  report          jsonb,
  error           text,
  results         jsonb,
  worst           text check (worst in ('ok', 'warning', 'critical')),
  processed_at    timestamptz
);
create index server_reports_server_at on server_reports (server_id, at desc);
create index server_reports_unprocessed on server_reports (id) where processed_at is null;

create table server_checks (
  server_id       integer not null references servers on delete cascade,
  environment_id  integer not null references environments on delete cascade,
  check_key       text not null,
  label           text not null,
  severity        text not null check (severity in ('ok', 'warning', 'critical')),
  value           double precision,
  detail          text not null,
  since           timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (server_id, check_key)
);

alter table servers enable row level security;
alter table server_reports enable row level security;
alter table server_checks enable row level security;
create policy read on servers for select using (environment_id in (select vantage_env_ids(2)));
create policy admin_write on servers for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy read on server_reports for select using (environment_id in (select vantage_env_ids(2)));
create policy read on server_checks for select using (environment_id in (select vantage_env_ids(2)));

grant select, insert, update, delete on servers to vantage_hub;
grant select on server_reports, server_checks to vantage_hub;
grant select, update on servers to vantage_worker;
grant select, insert, update, delete on server_reports, server_checks to vantage_worker;

-- ── Server events: diagnostics level, like errors ────────────────────────────────────────────────

alter table events drop constraint events_source_check;
alter table events add constraint events_source_check
  check (source in ('uptime', 'tests', 'errors', 'ops', 'system', 'security', 'servers'));

drop policy read on events;
create policy read on events for select using (
  vantage_is_admin()
  or (environment_id is not null and source not in ('errors', 'servers', 'security') and environment_id in (select vantage_env_ids(1)))
  or (environment_id is not null and source in ('errors', 'servers') and environment_id in (select vantage_env_ids(2)))
  or (environment_id is not null and source = 'security' and environment_id in (select vantage_env_ids(3)))
);

drop policy read on incidents;
create policy read on incidents for select using (
  vantage_is_admin()
  or (environment_id is not null and source not in ('errors', 'servers', 'security') and environment_id in (select vantage_env_ids(1)))
  or (environment_id is not null and source in ('errors', 'servers') and environment_id in (select vantage_env_ids(2)))
  or (environment_id is not null and source = 'security' and environment_id in (select vantage_env_ids(3)))
);

-- Whoever routed uptime alerts wants to hear about the servers too.
update routes set sources = array_append(sources, 'servers') where 'uptime' = any(sources) and not ('servers' = any(sources));
alter table routes alter column sources set default '{uptime,tests,errors,ops,system,servers}';

-- ── The runner's door ────────────────────────────────────────────────────────────────────────────

-- Identifies a runner by its token and records that it was seen; null for unknown or revoked tokens.
create function runner_hello(p_token_hash text, p_version text, p_ssh_public_key text)
  returns table (id integer, name text, organisation_id integer)
  language sql volatile security definer set search_path = public, pg_temp as $$
  update runners r set last_seen_at = now(),
    version = coalesce(left(p_version, 40), r.version),
    ssh_public_key = coalesce(left(p_ssh_public_key, 1000), r.ssh_public_key)
  where r.token_hash = p_token_hash and r.revoked_at is null
  returning r.id, r.name, r.organisation_id
$$;

-- What the runner checks: its enabled monitors (config still with encrypted secrets; the hub
-- decrypts them for the answer) and its enabled servers.
create function runner_targets(p_token_hash text)
  returns table (kind text, id integer, monitor_kind text, config jsonb, interval_seconds integer, timeout_ms integer,
                 retry_interval_seconds integer, name text, ssh_target text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select 'monitor', m.id, m.kind, m.config, m.interval_seconds, m.timeout_ms, m.retry_interval_seconds, m.name, null::text
  from monitors m join runners r on r.id = m.runner_id
  where r.token_hash = p_token_hash and r.revoked_at is null and m.enabled
  union all
  select 'server', s.id, null, null, s.interval_seconds, null, null, s.name, s.ssh_target
  from servers s join runners r on r.id = s.runner_id
  where r.token_hash = p_token_hash and r.revoked_at is null and s.enabled
$$;

-- Queues probe results and server reports. Entries for monitors or servers that are not this
-- runner's are dropped (and counted), so a runner can never write another one's data.
create function runner_submit(p_token_hash text, p_checks jsonb, p_reports jsonb)
  returns table (accepted integer, rejected integer)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  rid integer;
  n_in integer;
  n_ok integer := 0;
  n integer;
begin
  select r.id into rid from runners r where r.token_hash = p_token_hash and r.revoked_at is null;
  if rid is null then return; end if;
  update runners set last_seen_at = now() where runners.id = rid;
  n_in := jsonb_array_length(coalesce(p_checks, '[]')) + jsonb_array_length(coalesce(p_reports, '[]'));

  insert into runner_results (runner_id, monitor_id, at, ok, latency_ms, status_code, message, details, tls_days_left)
  select rid, m.id, least((c->>'at')::timestamptz, now()), (c->>'ok')::boolean, (c->>'latency_ms')::integer,
         (c->>'status_code')::integer, left(c->>'message', 1000), c->'details', (c->>'tls_days_left')::integer
  from jsonb_array_elements(coalesce(p_checks, '[]')) c
  join monitors m on m.id = (c->>'monitor_id')::integer and m.runner_id = rid;
  get diagnostics n = row_count;
  n_ok := n_ok + n;

  insert into server_reports (server_id, environment_id, at, report, error)
  select s.id, s.environment_id, least((x->>'at')::timestamptz, now()), x->'report', left(x->>'error', 1000)
  from jsonb_array_elements(coalesce(p_reports, '[]')) x
  join servers s on s.id = (x->>'server_id')::integer and s.runner_id = rid;
  get diagnostics n = row_count;
  n_ok := n_ok + n;

  return query select n_ok, n_in - n_ok;
end $$;

revoke execute on function runner_hello(text, text, text), runner_targets(text), runner_submit(text, jsonb, jsonb),
  monitors_check_runner(), servers_check_runner() from public;
grant execute on function runner_hello(text, text, text), runner_targets(text), runner_submit(text, jsonb, jsonb) to vantage_hub;
