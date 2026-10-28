-- Ansible runs from Semaphore. The worker reads every run through the
-- "semaphore" integration and keeps, per run, what each server reported in the PLAY RECAP. No log
-- output is stored: the hub shows template, status and per-server counts, the full log stays in
-- Semaphore.
--
-- Runs belong to servers, not to environments. An environment lists the servers it runs on
-- (environment_sources kind 'ansible', {"hosts": ["web1.example.com", …]}, names as in the
-- inventory), and a user sees a server's results only through such an environment at level 3:
-- patch runs that failed, CVE mitigations and hardening audits say how to attack a server.
-- A run shows up where at least one of its servers is visible; admins see every run.

alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('logs', 'apm', 'wazuh', 'dependency_track', 'mail', 'cortex', 'semaphore'));

alter table environment_sources drop constraint environment_sources_kind_check;
alter table environment_sources add constraint environment_sources_kind_check
  check (kind in ('logs', 'apm', 'dependency_track', 'wazuh', 'ansible'));

create table ansible_runs (
  id             integer primary key,          -- Semaphore's task id
  template_id    integer not null,
  template_name  text not null,
  playbook       text,
  -- Semaphore's status: waiting, starting, running, stopping, stopped, success, error, …
  status         text not null,
  trigger        text not null check (trigger in ('schedule', 'manual')),
  created_at     timestamptz not null,
  started_at     timestamptz,
  ended_at       timestamptz,
  -- Set once the finished run's output was read (or given up on after three attempts);
  -- ansible_run_hosts is complete from then on.
  parsed_at      timestamptz,
  parse_attempts integer not null default 0,
  parse_error    text,
  synced_at      timestamptz not null default now()
);
create index ansible_runs_created on ansible_runs (created_at desc);

create table ansible_run_hosts (
  run_id       integer not null references ansible_runs on delete cascade,
  host         text not null,
  ok           integer not null default 0,
  changed      integer not null default 0,
  unreachable  integer not null default 0,
  failed       integer not null default 0,
  skipped      integer not null default 0,
  rescued      integer not null default 0,
  ignored      integer not null default 0,
  -- The task the server failed in or became unreachable at (its name only, never the message).
  failed_task  text,
  primary key (run_id, host)
);
create index ansible_run_hosts_host on ansible_run_hosts (host, run_id desc);

-- The servers mapped to environments the current user sees at p_min or above.
create function vantage_ansible_hosts(p_min integer) returns setof text
  language sql stable security definer set search_path = public, pg_temp as $$
  select distinct h from environment_sources s, jsonb_array_elements_text(coalesce(s.config->'hosts', '[]')) h
  where s.kind = 'ansible' and s.environment_id in (select vantage_env_ids(p_min))
$$;
revoke execute on function vantage_ansible_hosts(integer) from public;
grant execute on function vantage_ansible_hosts(integer) to vantage_hub, vantage_worker;

alter table ansible_runs enable row level security;
alter table ansible_run_hosts enable row level security;
create policy read on ansible_run_hosts for select using (vantage_is_admin() or host in (select vantage_ansible_hosts(3)));
create policy read on ansible_runs for select using (
  vantage_is_admin() or id in (select h.run_id from ansible_run_hosts h where h.host in (select vantage_ansible_hosts(3))));

grant select on ansible_runs, ansible_run_hosts to vantage_hub;
grant select, insert, update, delete on ansible_runs, ansible_run_hosts to vantage_worker;
