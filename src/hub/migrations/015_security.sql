-- Security: a third grant level above diagnostics, and the vulnerabilities Vantage collects for an
-- environment (Dependency-Track now, Wazuh next). Known vulnerabilities of a customer's application
-- are the most sensitive data Vantage holds, so they need level 3, which is only ever granted
-- explicitly (decision 11, 2026-10-15). Levels stay cumulative: security includes diagnostics.

alter table grants drop constraint grants_level_check;
alter table grants add constraint grants_level_check check (level in ('overview', 'diagnostics', 'security'));

-- 0 = none, 1 = overview, 2 = diagnostics, 3 = security. Disabled users have 0 everywhere.
create or replace function vantage_level(p_user integer, p_env integer) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not exists (select 1 from users where id = p_user and disabled_at is null) then 0
    when exists (select 1 from users where id = p_user and is_admin) then 3
    else coalesce((
      select max(case g.level when 'security' then 3 when 'diagnostics' then 2 else 1 end)
      from grants g
      join environments e on e.project_id = g.project_id
      where e.id = p_env
        and g.user_id = p_user
        and (g.expires_at is null or g.expires_at > now())
        and (g.all_environments or exists (
          select 1 from grant_environments ge where ge.grant_id = g.id and ge.environment_id = p_env))
    ), 0)
  end
$$;

-- ── Events from the security module ──────────────────────────────────────────────────────────────

alter table events drop constraint events_source_check;
alter table events add constraint events_source_check
  check (source in ('uptime', 'tests', 'errors', 'ops', 'system', 'security'));

drop policy read on events;
create policy read on events for select using (
  vantage_is_admin()
  or (environment_id is not null and source not in ('errors', 'security') and environment_id in (select vantage_env_ids(1)))
  or (environment_id is not null and source = 'errors' and environment_id in (select vantage_env_ids(2)))
  or (environment_id is not null and source = 'security' and environment_id in (select vantage_env_ids(3)))
);

drop policy read on incidents;
create policy read on incidents for select using (
  vantage_is_admin()
  or (environment_id is not null and source not in ('errors', 'security') and environment_id in (select vantage_env_ids(1)))
  or (environment_id is not null and source = 'errors' and environment_id in (select vantage_env_ids(2)))
  or (environment_id is not null and source = 'security' and environment_id in (select vantage_env_ids(3)))
);

-- ── Dependency-Track mapping and what it reports ─────────────────────────────────────────────────

alter table environment_sources drop constraint environment_sources_kind_check;
alter table environment_sources add constraint environment_sources_kind_check
  check (kind in ('logs', 'apm', 'dependency_track'));

-- One row per mapped Dependency-Track project: what it is and how the last sync went.
create table security_projects (
  environment_id   integer not null references environments on delete cascade,
  project_uuid     uuid not null,
  name             text,
  version          text,
  last_bom_import  timestamptz,
  -- attempted_at paces the worker (also after failures); synced_at is the last successful sync.
  attempted_at     timestamptz,
  synced_at        timestamptz,
  last_error       text,
  primary key (environment_id, project_uuid)
);

-- Open and resolved vulnerabilities per environment. `finding_key` is unique per source:
-- Dependency-Track "componentUuid:vulnerabilityUuid".
create table security_findings (
  id                 bigint generated always as identity primary key,
  environment_id     integer not null references environments on delete cascade,
  source             text not null check (source in ('dependency_track', 'wazuh')),
  -- Dependency-Track project the finding belongs to (null for Wazuh), so unmapping a project drops it.
  project_uuid       uuid,
  finding_key        text not null,
  target             text not null,
  vuln_id            text not null,
  severity           text not null check (severity in ('critical', 'high', 'medium', 'low', 'unassigned')),
  cvss               numeric(3, 1),
  title              text,
  component          text,
  component_version  text,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  resolved_at        timestamptz,
  unique (environment_id, source, finding_key)
);
create index security_findings_open on security_findings (environment_id, severity) where resolved_at is null;

alter table security_projects enable row level security;
alter table security_findings enable row level security;
create policy read on security_projects for select using (environment_id in (select vantage_env_ids(3)));
create policy read on security_findings for select using (environment_id in (select vantage_env_ids(3)));

grant select on security_projects, security_findings to vantage_hub;
grant select, insert, update, delete on security_projects, security_findings to vantage_worker;
grant usage on all sequences in schema public to vantage_worker;
