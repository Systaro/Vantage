-- Where an environment's logs and APM data live, and the error groups derived from APM.
-- Both are diagnostics-level (2): they expose stack traces and personal data from the application.

create table environment_sources (
  id              integer generated always as identity primary key,
  environment_id  integer not null references environments on delete cascade,
  kind            text not null check (kind in ('logs', 'apm')),
  -- logs: {"index": "logstash-shop-prod-*", "filterField": "appname.keyword", "filterValue": "shop"}
  -- apm:  {"service": "shop-backend", "environment": "production"}
  config          jsonb not null,
  created_at      timestamptz not null default now(),
  unique (environment_id, kind)
);

create table error_groups (
  id               integer generated always as identity primary key,
  environment_id   integer not null references environments on delete cascade,
  grouping_key     text not null,
  exception_type   text,
  message          text,
  culprit          text,
  handled          boolean,
  first_seen_at    timestamptz not null,
  last_seen_at     timestamptz not null,
  occurrences      bigint not null default 0,
  status           text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  status_changed_at timestamptz,
  status_changed_by integer references users on delete set null,
  unique (environment_id, grouping_key)
);
create index error_groups_env_last on error_groups (environment_id, last_seen_at desc);

create table error_poll_state (
  environment_id  integer primary key references environments on delete cascade,
  polled_until    timestamptz not null,
  last_error      text,
  updated_at      timestamptz not null default now()
);

alter table environment_sources enable row level security;
alter table error_groups enable row level security;
alter table error_poll_state enable row level security;

create policy read on environment_sources for select using (environment_id in (select vantage_env_ids(2)));
create policy admin_write on environment_sources for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy read on error_groups for select using (environment_id in (select vantage_env_ids(2)));
-- Triage (resolve / ignore / reopen) is open to everyone with diagnostics on the environment.
create policy triage on error_groups for update
  using (environment_id in (select vantage_env_ids(2)))
  with check (environment_id in (select vantage_env_ids(2)));
create policy admin_read on error_poll_state for select using (vantage_is_admin());

grant select, insert, update, delete on environment_sources to vantage_hub;
grant select on error_groups, error_poll_state to vantage_hub;
grant update (status, status_changed_at, status_changed_by) on error_groups to vantage_hub;
grant select, insert, update, delete on environment_sources, error_groups, error_poll_state to vantage_worker;

-- Who triaged is taken from the session, never from the request.
create function error_groups_stamp_triage() returns trigger language plpgsql as $$
begin
  if current_user = 'vantage_hub' then
    new.status_changed_by := vantage_uid();
    new.status_changed_at := now();
  end if;
  return new;
end $$;
create trigger error_groups_stamp_triage before update on error_groups
  for each row execute function error_groups_stamp_triage();
