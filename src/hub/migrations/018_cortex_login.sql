-- „Mit Cortex anmelden“: Systaro staff sign in through Cortex (OpenID Connect). The account's owner
-- links it once, after a normal login, to Cortex's `user_id` claim; Cortex never gives that id out
-- again, unlike the username in `sub`. A Cortex login finds an account only through this link: no
-- account is created, and none is matched by e-mail. Vantage still asks for its own TOTP code unless
-- Cortex reports that its authenticator code was typed for this session (`amr` otp, recent `auth_time`).
-- The connection itself (issuer, client id, encrypted secret) is the integration row 'cortex'.

alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('logs', 'apm', 'wazuh', 'dependency_track', 'mail', 'cortex'));

create table cortex_links (
  user_id          integer primary key references users on delete cascade,
  issuer           text not null,
  cortex_user_id   text not null,
  cortex_username  text not null,
  linked_at        timestamptz not null default now(),
  unique (issuer, cortex_user_id)
);

alter table cortex_links enable row level security;
create policy read on cortex_links for select using (user_id = vantage_uid() or vantage_is_admin());
create policy remove on cortex_links for delete using (user_id = vantage_uid() or vantage_is_admin());

grant select (user_id, issuer, cortex_username, linked_at) on cortex_links to vantage_hub;
grant delete on cortex_links to vantage_hub;

-- The signed-in user links their own account. Only staff, and a Cortex account belongs to one
-- Vantage account at most: 'taken' when another account holds it, 'not_staff' for customers.
create function account_link_cortex(p_issuer text, p_cortex_user_id text, p_cortex_username text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if vantage_uid() is null then raise exception 'no user'; end if;
  if not exists (select 1 from users where id = vantage_uid() and kind = 'staff' and disabled_at is null) then
    return 'not_staff';
  end if;
  if exists (select 1 from cortex_links where issuer = p_issuer and cortex_user_id = p_cortex_user_id and user_id <> vantage_uid()) then
    return 'taken';
  end if;
  insert into cortex_links (user_id, issuer, cortex_user_id, cortex_username)
    values (vantage_uid(), p_issuer, p_cortex_user_id, p_cortex_username)
    on conflict (user_id) do update set issuer = excluded.issuer, cortex_user_id = excluded.cortex_user_id,
      cortex_username = excluded.cortex_username, linked_at = now();
  return 'ok';
end $$;
grant execute on function account_link_cortex(text, text, text) to vantage_hub;

-- Login: the account behind a Cortex identity, if it is linked, staff, not locked and fully set up
-- (a reset account has to accept its new invite first).
create function auth_user_for_cortex(p_issuer text, p_cortex_user_id text)
  returns table (id integer, email text, totp_secret_enc text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.email, u.totp_secret_enc
  from cortex_links l join users u on u.id = l.user_id
  where l.issuer = p_issuer and l.cortex_user_id = p_cortex_user_id
    and u.kind = 'staff' and u.disabled_at is null and u.password_hash is not null and u.totp_secret_enc is not null
$$;
grant execute on function auth_user_for_cortex(text, text) to vantage_hub;

-- Resetting an account after a suspected compromise also drops its Cortex link.
create or replace function admin_reset_user(p_user integer) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  update users set password_hash = null, totp_secret_enc = null where id = p_user;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  update invites set used_at = now() where user_id = p_user and used_at is null;
  update api_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
  delete from cortex_links where user_id = p_user;
end $$;
