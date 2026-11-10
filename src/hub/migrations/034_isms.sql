-- ISMS controls of a project (#69764): what the project's information security management system
-- promises, and whether it currently holds. A control is checked either from data Vantage already
-- has about one of the project's environments (uptime, certificates, servers, logs) or by dated
-- records a person enters (restore test, access review). A record counts until the control's
-- interval runs out; a control without an interval is a one-time measure that stays done once it is.

create table isms_controls (
  id              integer generated always as identity primary key,
  project_id      integer not null references projects on delete cascade,
  environment_id  integer references environments on delete cascade,
  ref             text not null check (length(ref) between 1 and 40),
  title           text not null check (length(title) between 1 and 200),
  -- Where the control is promised: a section of the ISMS, a contract, an offer position.
  basis           text check (length(basis) <= 200),
  kind            text not null check (kind in ('uptime', 'tls', 'servers', 'logs', 'record')),
  -- uptime: min_percent, monitor_id; tls: min_days; logs: retention_days, max_silence_hours; record: interval_days
  params          jsonb not null default '{}',
  note            text check (length(note) <= 1000),
  created_by      integer references users on delete set null,
  created_at      timestamptz not null default now(),
  check (kind = 'record' or environment_id is not null)
);
create index isms_controls_project on isms_controls (project_id);

create function isms_controls_check_environment() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.environment_id is not null and not exists (
    select 1 from environments where id = new.environment_id and project_id = new.project_id) then
    raise exception 'environment % does not belong to project %', new.environment_id, new.project_id;
  end if;
  return new;
end $$;
create trigger isms_controls_check_environment before insert or update of environment_id, project_id on isms_controls
  for each row execute function isms_controls_check_environment();

create table isms_records (
  id          integer generated always as identity primary key,
  control_id  integer not null references isms_controls on delete cascade,
  done_on     date not null,
  -- A test that found a problem is still a valid record; it makes the control a deviation.
  result      text not null check (result in ('passed', 'deviation')),
  note        text check (length(note) <= 1000),
  link        text check (length(link) <= 500),
  created_by  integer references users on delete set null,
  created_at  timestamptz not null default now()
);
create index isms_records_control on isms_records (control_id, done_on desc);

alter table isms_controls enable row level security;
alter table isms_records enable row level security;
-- Everyone who sees the project sees its controls; whether a check's data is visible stays a matter
-- of the environment's own policies.
create policy read on isms_controls for select using (project_id in (select vantage_project_ids()));
create policy admin_write on isms_controls for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy read on isms_records for select using (
  control_id in (select id from isms_controls where project_id in (select vantage_project_ids())));
create policy admin_write on isms_records for all using (vantage_is_admin()) with check (vantage_is_admin());

grant select, insert, delete on isms_controls to vantage_hub;
grant select, insert, delete on isms_records to vantage_hub;
grant select on isms_controls, isms_records to vantage_worker;
