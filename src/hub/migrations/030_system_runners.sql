-- System runners: a runner without organisation is Systaro's own and runs in our network (the first
-- one runs next to the hub and reads the servers Systaro operates). It may be given
-- monitors and servers of every organisation, because the organisation is a label, not a wall
-- (design section 1, item 2). A customer's runner still serves that customer only: it runs in the
-- customer's network and must never receive another customer's monitor secrets. Like every runner,
-- a system runner is managed by admins alone and executes nothing it receives.

alter table runners alter column organisation_id drop not null;
create unique index runners_system_name on runners (name) where organisation_id is null;

create or replace function monitors_check_runner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.runner_id is not null and not exists (
    select 1 from runners r where r.id = new.runner_id and (r.organisation_id is null or exists (
      select 1 from projects p join environments e on e.project_id = p.id
      where p.organisation_id = r.organisation_id and e.id = new.environment_id))) then
    raise exception 'runner % does not belong to the organisation of environment %', new.runner_id, new.environment_id;
  end if;
  if new.runner_id is not null and new.kind not in ('http', 'tcp', 'dns', 'tls', 'health') then
    raise exception 'monitors of kind % cannot run on a runner', new.kind;
  end if;
  return new;
end $$;

create or replace function servers_check_runner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from runners r where r.id = new.runner_id and (r.organisation_id is null or exists (
      select 1 from projects p join environments e on e.project_id = p.id
      where p.organisation_id = r.organisation_id and e.id = new.environment_id))) then
    raise exception 'runner % does not belong to the organisation of environment %', new.runner_id, new.environment_id;
  end if;
  return new;
end $$;
