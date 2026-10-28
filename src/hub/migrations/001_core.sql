-- Core: registry, users, grants, sessions, audit — and the access function every policy uses.
-- Runs as vantage_owner. The hub connects as vantage_hub (RLS enforced), the worker as
-- vantage_worker (BYPASSRLS). See docs/design.md §3.

create table organisations (
  id          integer generated always as identity primary key,
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text not null check (length(name) between 1 and 200),
  created_at  timestamptz not null default now()
);

create table projects (
  id               integer generated always as identity primary key,
  organisation_id  integer not null references organisations on delete restrict,
  slug             text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name             text not null check (length(name) between 1 and 200),
  created_at       timestamptz not null default now(),
  unique (organisation_id, slug)
);

create table environments (
  id          integer generated always as identity primary key,
  project_id  integer not null references projects on delete restrict,
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text not null check (length(name) between 1 and 200),
  kind        text not null default 'other'
              check (kind in ('production', 'staging', 'test', 'demo', 'development', 'other')),
  url         text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (project_id, slug)
);

create table users (
  id               integer generated always as identity primary key,
  email            text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  name             text not null check (length(name) between 1 and 200),
  kind             text not null default 'customer' check (kind in ('staff', 'customer')),
  is_admin         boolean not null default false,
  password_hash    text,
  totp_secret_enc  text,
  created_at       timestamptz not null default now(),
  created_by       integer references users on delete set null,
  disabled_at      timestamptz,
  last_login_at    timestamptz
);

create table invites (
  id                 integer generated always as identity primary key,
  user_id            integer not null references users on delete cascade,
  token_hash         text not null unique,
  pending_totp_enc   text,
  expires_at         timestamptz not null,
  used_at            timestamptz,
  created_by         integer references users on delete set null,
  created_at         timestamptz not null default now()
);

create table sessions (
  id            integer generated always as identity primary key,
  user_id       integer not null references users on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  ip            text,
  user_agent    text,
  revoked_at    timestamptz
);
create index sessions_user on sessions (user_id);

create table grants (
  id                integer generated always as identity primary key,
  user_id           integer not null references users on delete cascade,
  project_id        integer not null references projects on delete cascade,
  all_environments  boolean not null default true,
  level             text not null check (level in ('overview', 'diagnostics')),
  expires_at        timestamptz,
  note              text,
  created_by        integer references users on delete set null,
  created_at        timestamptz not null default now(),
  unique (user_id, project_id)
);

create table grant_environments (
  grant_id        integer not null references grants on delete cascade,
  environment_id  integer not null references environments on delete cascade,
  primary key (grant_id, environment_id)
);

-- A grant's environment list may only name environments of the grant's own project.
create function grant_environments_same_project() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from grants g join environments e on e.project_id = g.project_id
    where g.id = new.grant_id and e.id = new.environment_id
  ) then
    raise exception 'environment % does not belong to the project of grant %', new.environment_id, new.grant_id;
  end if;
  return new;
end $$;
create trigger grant_environments_same_project before insert or update on grant_environments
  for each row execute function grant_environments_same_project();

create table audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     integer references users on delete set null,
  actor_label  text,
  action       text not null,
  target       text,
  detail       jsonb not null default '{}',
  ip           text
);
create index audit_log_at on audit_log (at desc);

create table login_attempts (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  email  text,
  ip     text,
  ok     boolean not null
);
create index login_attempts_email on login_attempts (email, at desc);
create index login_attempts_ip on login_attempts (ip, at desc);

-- ── Access function ────────────────────────────────────────────────────────────────────────────

create function vantage_uid() returns integer language sql stable as $$
  select nullif(current_setting('vantage.user_id', true), '')::integer
$$;

create function vantage_is_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select is_admin from users where id = vantage_uid() and disabled_at is null), false)
$$;

-- 0 = none, 1 = overview, 2 = diagnostics. Disabled users have 0 everywhere.
create function vantage_level(p_user integer, p_env integer) returns integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not exists (select 1 from users where id = p_user and disabled_at is null) then 0
    when exists (select 1 from users where id = p_user and is_admin) then 2
    else coalesce((
      select max(case g.level when 'diagnostics' then 2 else 1 end)
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

-- Environments the current user reaches at the given level. Policies use it as an uncorrelated
-- subquery, so it is evaluated once per statement.
create function vantage_env_ids(p_min integer) returns setof integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select e.id from environments e where vantage_level(vantage_uid(), e.id) >= p_min
$$;

create function vantage_project_ids() returns setof integer
  language sql stable security definer set search_path = public, pg_temp as $$
  select p.id from projects p
  where vantage_is_admin()
     or exists (select 1 from grants g where g.project_id = p.id and g.user_id = vantage_uid()
                and (g.expires_at is null or g.expires_at > now())
                and exists (select 1 from users u where u.id = g.user_id and u.disabled_at is null))
$$;

-- ── Pre-login and self-service functions (the hub role cannot read other users' rows) ─────────

create function auth_user_for_login(p_email text)
  returns table (id integer, password_hash text, totp_secret_enc text, disabled boolean)
  language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.password_hash, u.totp_secret_enc, u.disabled_at is not null
  from users u where u.email = lower(p_email)
$$;

create function auth_user_for_totp(p_id integer)
  returns table (email text, totp_secret_enc text, disabled boolean)
  language sql stable security definer set search_path = public, pg_temp as $$
  select u.email, u.totp_secret_enc, u.disabled_at is not null from users u where u.id = p_id
$$;

create function auth_session(p_token_hash text, p_idle_seconds integer)
  returns table (session_id integer, user_id integer, email text, name text, kind text, is_admin boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return query
    update sessions s set last_seen_at = now()
    from users u
    where s.token_hash = p_token_hash
      and u.id = s.user_id
      and s.revoked_at is null
      and s.expires_at > now()
      and s.last_seen_at > now() - make_interval(secs => p_idle_seconds)
      and u.disabled_at is null
    returning s.id, u.id, u.email, u.name, u.kind, u.is_admin;
end $$;

create function auth_create_session(p_user integer, p_token_hash text, p_expires timestamptz, p_ip text, p_ua text)
  returns integer language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare sid integer;
begin
  insert into sessions (user_id, token_hash, expires_at, ip, user_agent)
  values (p_user, p_token_hash, p_expires, p_ip, left(p_ua, 300)) returning id into sid;
  update users set last_login_at = now() where id = p_user;
  return sid;
end $$;

create function auth_revoke_session(p_token_hash text) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  update sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null
$$;

create function auth_record_attempt(p_email text, p_ip text, p_ok boolean) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  insert into login_attempts (email, ip, ok) values (lower(p_email), p_ip, p_ok)
$$;

create function auth_recent_failures(p_email text, p_ip text, p_window_seconds integer)
  returns table (by_email integer, by_ip integer)
  language sql stable security definer set search_path = public, pg_temp as $$
  select
    (select count(*)::integer from login_attempts
      where email = lower(p_email) and not ok and at > now() - make_interval(secs => p_window_seconds)),
    (select count(*)::integer from login_attempts
      where ip = p_ip and not ok and at > now() - make_interval(secs => p_window_seconds))
$$;

create function auth_invite(p_token_hash text)
  returns table (invite_id integer, user_id integer, email text, name text, pending_totp_enc text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, u.id, u.email, u.name, i.pending_totp_enc
  from invites i join users u on u.id = i.user_id
  where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now() and u.disabled_at is null
$$;

create function auth_invite_set_pending_totp(p_token_hash text, p_totp_enc text) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  update invites set pending_totp_enc = p_totp_enc
  where token_hash = p_token_hash and used_at is null and expires_at > now() and pending_totp_enc is null
$$;

-- Accepting an invite sets the password and moves the pending TOTP secret onto the user.
create function auth_accept_invite(p_token_hash text, p_password_hash text) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare inv record;
begin
  select i.id, i.user_id, i.pending_totp_enc into inv
  from invites i join users u on u.id = i.user_id
  where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now() and u.disabled_at is null
  for update of i;
  if not found or inv.pending_totp_enc is null then
    return null;
  end if;
  update invites set used_at = now() where id = inv.id;
  update invites set used_at = now() where user_id = inv.user_id and used_at is null;
  update users set password_hash = p_password_hash, totp_secret_enc = inv.pending_totp_enc where id = inv.user_id;
  return inv.user_id;
end $$;

create function account_set_password(p_password_hash text) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  update users set password_hash = p_password_hash where id = vantage_uid() and disabled_at is null
$$;

-- Audit rows always carry the real actor from the session context, never a value the caller picks.
create function audit(p_action text, p_target text, p_detail jsonb, p_ip text, p_actor_label text default null)
  returns void language sql volatile security definer set search_path = public, pg_temp as $$
  insert into audit_log (actor_id, actor_label, action, target, detail, ip)
  values (vantage_uid(), coalesce(p_actor_label, (select email from users where id = vantage_uid())),
          p_action, p_target, coalesce(p_detail, '{}'::jsonb), p_ip)
$$;

-- Admin actions on accounts that must also end live sessions.
create function admin_reset_user(p_user integer) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  update users set password_hash = null, totp_secret_enc = null where id = p_user;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  update invites set used_at = now() where user_id = p_user and used_at is null;
end $$;

create function admin_set_disabled(p_user integer, p_disabled boolean) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  if p_user = vantage_uid() then raise exception 'admins cannot disable themselves'; end if;
  update users set disabled_at = case when p_disabled then now() else null end where id = p_user;
  if p_disabled then
    update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  end if;
end $$;

-- ── Row-level security ─────────────────────────────────────────────────────────────────────────

alter table organisations enable row level security;
alter table projects enable row level security;
alter table environments enable row level security;
alter table users enable row level security;
alter table invites enable row level security;
alter table sessions enable row level security;
alter table grants enable row level security;
alter table grant_environments enable row level security;
alter table audit_log enable row level security;
alter table login_attempts enable row level security;

create policy read on organisations for select using (
  vantage_is_admin() or id in (select organisation_id from projects where id in (select vantage_project_ids())));
create policy admin_write on organisations for all using (vantage_is_admin()) with check (vantage_is_admin());

create policy read on projects for select using (id in (select vantage_project_ids()));
create policy admin_write on projects for all using (vantage_is_admin()) with check (vantage_is_admin());

create policy read on environments for select using (id in (select vantage_env_ids(1)));
create policy admin_write on environments for all using (vantage_is_admin()) with check (vantage_is_admin());

create policy read on users for select using (id = vantage_uid() or vantage_is_admin());
create policy admin_write on users for all using (vantage_is_admin()) with check (vantage_is_admin());

create policy admin_all on invites for all using (vantage_is_admin()) with check (vantage_is_admin());

create policy own on sessions for select using (user_id = vantage_uid());
create policy own_revoke on sessions for update using (user_id = vantage_uid()) with check (user_id = vantage_uid());

create policy read on grants for select using (user_id = vantage_uid() or vantage_is_admin());
create policy admin_write on grants for all using (vantage_is_admin()) with check (vantage_is_admin());

create policy read on grant_environments for select using (
  vantage_is_admin() or grant_id in (select id from grants where user_id = vantage_uid()));
create policy admin_write on grant_environments for all using (vantage_is_admin()) with check (vantage_is_admin());

create policy admin_read on audit_log for select using (vantage_is_admin());
-- login_attempts: no policy for the hub role at all; only the auth_* functions touch it.

-- ── Privileges ─────────────────────────────────────────────────────────────────────────────────

grant usage on schema public to vantage_hub, vantage_worker;

grant select, insert, update, delete on organisations, projects, environments, grants, grant_environments
  to vantage_hub;
-- Secret columns (password_hash, totp_secret_enc, token hashes) are not readable by the hub role at
-- all; only the auth_* functions see them.
grant select (id, email, name, kind, is_admin, created_at, created_by, disabled_at, last_login_at) on users
  to vantage_hub;
grant insert (email, name, kind, is_admin, created_by) on users to vantage_hub;
grant update (name, kind, is_admin) on users to vantage_hub;
grant select (id, user_id, expires_at, used_at, created_by, created_at) on invites to vantage_hub;
grant insert (user_id, token_hash, expires_at, created_by) on invites to vantage_hub;
grant select (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at) on sessions
  to vantage_hub;
grant update (revoked_at) on sessions to vantage_hub;
grant select on audit_log to vantage_hub;

grant select, insert, update, delete on all tables in schema public to vantage_worker;
grant usage on all sequences in schema public to vantage_worker;

revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to vantage_hub, vantage_worker;
-- Functions added by later migrations are not executable by anyone until granted explicitly.
alter default privileges for role vantage_owner revoke execute on functions from public;
