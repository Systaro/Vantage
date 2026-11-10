-- "Diesem Gerät vertrauen": a browser that passed the code step once may skip it for 30 days. It
-- replaces the second factor only; the password (or Cortex) is still asked every time. The browser
-- keeps a random token in a cookie, the table only its hash. Users see, rename and remove their
-- devices under Mein Konto; a password change, a reset and locking the account forget all of them.

create table trusted_devices (
  id            integer generated always as identity primary key,
  user_id       integer not null references users on delete cascade,
  token_hash    text not null unique,
  name          text check (name is null or length(name) between 1 and 60),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  ip            text,
  user_agent    text,
  last_used_at  timestamptz,
  last_ip       text,
  revoked_at    timestamptz
);
create index trusted_devices_user on trusted_devices (user_id);

alter table trusted_devices enable row level security;
create policy read on trusted_devices for select using (user_id = vantage_uid() or vantage_is_admin());
-- Rename or remove one's own live devices; a removed one cannot be brought back.
create policy own_update on trusted_devices for update
  using (user_id = vantage_uid() and revoked_at is null)
  with check (user_id = vantage_uid());

grant select (id, user_id, name, created_at, expires_at, ip, user_agent, last_used_at, last_ip, revoked_at) on trusted_devices to vantage_hub;
grant update (name, revoked_at) on trusted_devices to vantage_hub;
grant select, delete on trusted_devices to vantage_worker;

-- Called after the code was typed with the box ticked. More than 20 live devices: the oldest go.
create function auth_trust_device(p_user integer, p_token_hash text, p_expires timestamptz, p_ip text, p_ua text)
  returns integer language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare did integer;
begin
  insert into trusted_devices (user_id, token_hash, expires_at, ip, user_agent)
  values (p_user, p_token_hash, p_expires, p_ip, left(p_ua, 300)) returning id into did;
  update trusted_devices set revoked_at = now()
  where id in (select id from trusted_devices where user_id = p_user and revoked_at is null and expires_at > now()
               order by created_at desc offset 20);
  return did;
end $$;

-- The device's id when this browser's token is a live device of this user, which also notes its use.
create function auth_use_device(p_user integer, p_token_hash text, p_ip text)
  returns integer language sql volatile security definer set search_path = public, pg_temp as $$
  update trusted_devices d set last_used_at = now(), last_ip = p_ip
  from users u
  where d.token_hash = p_token_hash and d.user_id = p_user and u.id = d.user_id
    and d.revoked_at is null and d.expires_at > now()
    and u.disabled_at is null and u.password_hash is not null and u.totp_secret_enc is not null
  returning d.id
$$;

-- A browser that is trusted for someone else and now ticks the box for its new user drops the old token.
create function auth_revoke_device(p_token_hash text) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  update trusted_devices set revoked_at = now() where token_hash = p_token_hash and revoked_at is null
$$;

-- Which of my devices this browser is ("dieses Gerät" on Mein Konto); the hub role cannot read hashes.
create function account_current_device(p_token_hash text)
  returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select id from trusted_devices
  where token_hash = p_token_hash and user_id = vantage_uid() and revoked_at is null and expires_at > now()
$$;

grant execute on function auth_trust_device(integer, text, timestamptz, text, text), auth_use_device(integer, text, text),
  auth_revoke_device(text), account_current_device(text) to vantage_hub;

-- Mein Konto lists the logins and failed attempts on one's own e-mail address from the audit log
-- (the hub role reads that table only as admin). All three carry the e-mail as actor_label.
create index audit_log_logins on audit_log (actor_label, at desc) where action in ('login.ok', 'login.failed', 'invite.accepted');

create function account_login_history(p_limit integer)
  returns table (at timestamptz, action text, detail jsonb, ip text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select a.at, a.action, a.detail, a.ip from audit_log a
  where a.action in ('login.ok', 'login.failed', 'invite.accepted') and a.actor_label = (select email from users where id = vantage_uid())
  order by a.at desc limit least(greatest(p_limit, 1), 100)
$$;
grant execute on function account_login_history(integer) to vantage_hub;

-- The admin user page counts a user's active sessions and devices; until now RLS hid other users'
-- sessions from admins too, so that count always read 0.
create policy admin_read on sessions for select using (vantage_is_admin());

-- Resetting an account after a suspected compromise, or locking it, also forgets its devices.
create or replace function admin_reset_user(p_user integer) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  update users set password_hash = null, totp_secret_enc = null where id = p_user;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  update invites set used_at = now() where user_id = p_user and used_at is null;
  update api_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
  update trusted_devices set revoked_at = now() where user_id = p_user and revoked_at is null;
  delete from cortex_links where user_id = p_user;
end $$;

create or replace function admin_set_disabled(p_user integer, p_disabled boolean) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  if p_user = vantage_uid() then raise exception 'admins cannot disable themselves'; end if;
  update users set disabled_at = case when p_disabled then now() else null end where id = p_user;
  if p_disabled then
    update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
    update trusted_devices set revoked_at = now() where user_id = p_user and revoked_at is null;
  end if;
end $$;
