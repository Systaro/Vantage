-- Invites by e-mail. An admin can send a new invite to an account that is not set up yet; the new link
-- replaces every open one, so only the newest mail works. Admins also see whether an account is set
-- up (password and authenticator), which the user list showed as "aktiv" once an invite had expired.

create function admin_issue_invite(p_user integer, p_token_hash text, p_expires timestamptz) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  update invites set used_at = now() where user_id = p_user and used_at is null;
  insert into invites (user_id, token_hash, expires_at, created_by) values (p_user, p_token_hash, p_expires, vantage_uid());
end $$;
grant execute on function admin_issue_invite(integer, text, timestamptz) to vantage_hub;

-- Whether each account can log in yet; the hash and the secret themselves stay unreadable.
create function admin_user_access()
  returns table (user_id integer, set_up boolean)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  return query select u.id, u.password_hash is not null and u.totp_secret_enc is not null from users u;
end $$;
grant execute on function admin_user_access() to vantage_hub;
