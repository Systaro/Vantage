-- Personal API tokens for agents (REST /api/v1/… and MCP /api/mcp). A token acts as its user: the
-- API sets that user for the request and every read runs under the same RLS as the UI, so an agent
-- can never see more than its owner. Users manage their own tokens; admins can revoke any.

create table api_tokens (
  id            integer generated always as identity primary key,
  user_id       integer not null references users on delete cascade,
  name          text not null check (length(name) between 1 and 100),
  token_hash    text not null unique,
  token_prefix  text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index api_tokens_user on api_tokens (user_id);

alter table api_tokens enable row level security;
create policy read on api_tokens for select using (user_id = vantage_uid() or vantage_is_admin());
create policy own_insert on api_tokens for insert with check (user_id = vantage_uid());
create policy own_revoke on api_tokens for update using (user_id = vantage_uid() or vantage_is_admin())
  with check (user_id = vantage_uid() or vantage_is_admin());

grant select (id, user_id, name, token_prefix, created_at, expires_at, last_used_at, revoked_at) on api_tokens to vantage_hub;
grant insert (user_id, name, token_hash, token_prefix, expires_at) on api_tokens to vantage_hub;
grant update (revoked_at) on api_tokens to vantage_hub;
grant select, delete on api_tokens to vantage_worker;

-- Bearer token → user, like auth_session for cookies. last_used_at moves at most once a minute.
create function auth_api_token(p_token_hash text)
  returns table (token_id integer, user_id integer, email text, name text, kind text, is_admin boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return query
    update api_tokens t set last_used_at = case when t.last_used_at > now() - interval '1 minute' then t.last_used_at else now() end
    from users u
    where t.token_hash = p_token_hash and u.id = t.user_id and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > now()) and u.disabled_at is null
    returning t.id, u.id, u.email, u.name, u.kind, u.is_admin;
end $$;
grant execute on function auth_api_token(text) to vantage_hub;

-- Resetting an account after a suspected compromise also ends its API tokens.
create or replace function admin_reset_user(p_user integer) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  update users set password_hash = null, totp_secret_enc = null where id = p_user;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  update invites set used_at = now() where user_id = p_user and used_at is null;
  update api_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
end $$;
