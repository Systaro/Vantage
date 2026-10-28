-- Ignore rules for errors (#69811): a regular expression on an error's title or place. Error groups it
-- matches are dropped by the pollers before they are stored, so they make no group and no event; the
-- rule counts what it dropped. A rule holds for one environment, or (environment_id null) for every
-- environment of its project, like R2's STOMP noise on Production and Stage.

create table error_ignore_rules (
  id              integer generated always as identity primary key,
  project_id      integer not null references projects on delete cascade,
  environment_id  integer references environments on delete cascade,
  pattern         text not null check (length(pattern) between 1 and 300),
  note            text check (length(note) <= 500),
  created_by      integer references users on delete set null,
  created_at      timestamptz not null default now(),
  matched         bigint not null default 0,
  last_matched_at timestamptz
);
create index error_ignore_rules_project on error_ignore_rules (project_id);

alter table error_ignore_rules enable row level security;
-- Everyone who sees an environment's errors sees the rules that decide what is missing from them.
create policy read on error_ignore_rules for select using (
  environment_id in (select vantage_env_ids(2))
  or (environment_id is null and project_id in (select e.project_id from environments e where e.id in (select vantage_env_ids(2)))));
create policy admin_write on error_ignore_rules for all using (vantage_is_admin()) with check (vantage_is_admin());

grant select, insert, delete on error_ignore_rules to vantage_hub;
grant select, update on error_ignore_rules to vantage_worker;
