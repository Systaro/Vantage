-- Wazuh as a security source: an environment maps the Wazuh agents (servers) it runs on. The
-- worker copies their critical and high vulnerabilities into security_findings (source 'wazuh')
-- and keeps per-agent counts of all severities here; alerts are read live from the indexer.

alter table environment_sources drop constraint environment_sources_kind_check;
alter table environment_sources add constraint environment_sources_kind_check
  check (kind in ('logs', 'apm', 'dependency_track', 'wazuh'));

create table security_agents (
  environment_id  integer not null references environments on delete cascade,
  agent_name      text not null,
  agent_id        text,
  os              text,
  -- {"critical": 484, "high": 2738, "medium": 1096, "low": 98, "unassigned": 3206}
  counts          jsonb not null default '{}',
  attempted_at    timestamptz,
  synced_at       timestamptz,
  last_error      text,
  primary key (environment_id, agent_name)
);

alter table security_agents enable row level security;
create policy read on security_agents for select using (environment_id in (select vantage_env_ids(3)));
grant select on security_agents to vantage_hub;
grant select, insert, update, delete on security_agents to vantage_worker;
