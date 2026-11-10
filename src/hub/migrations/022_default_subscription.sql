-- Everyone who sets up an invited account starts with one subscription: e-mails for everything they
-- may see, from "Warnung" on. Only on the first setup (never logged in): after "Zugang zurücksetzen"
-- the person keeps what they chose, including no subscription at all.

create or replace function auth_accept_invite(p_token_hash text, p_password_hash text) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare inv record;
begin
  select i.id, i.user_id, i.pending_totp_enc, u.last_login_at into inv
  from invites i join users u on u.id = i.user_id
  where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now() and u.disabled_at is null
  for update of i;
  if not found or inv.pending_totp_enc is null then
    return null;
  end if;
  update invites set used_at = now() where id = inv.id;
  update invites set used_at = now() where user_id = inv.user_id and used_at is null;
  update users set password_hash = p_password_hash, totp_secret_enc = inv.pending_totp_enc where id = inv.user_id;
  if inv.last_login_at is null then
    insert into subscriptions (user_id, scope_kind, scope_id, min_severity) values (inv.user_id, 'all', null, 'warning')
    on conflict (user_id, scope_kind, coalesce(scope_id, 0)) do nothing;
  end if;
  return inv.user_id;
end $$;
