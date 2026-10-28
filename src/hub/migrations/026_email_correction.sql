-- Correcting the e-mail address of an account that has never been used (a typo at creation).
-- The address is the login name, so it stays fixed once the person has logged in or set up a
-- password. The open invite went to the old address, possibly someone else's mailbox, so it stops
-- working; the admin sends a new one to the corrected address.

create function admin_correct_email(p_user integer, p_email text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  if not exists (select 1 from users where id = p_user and last_login_at is null and password_hash is null and totp_secret_enc is null) then
    raise exception 'account already in use';
  end if;
  update invites set used_at = now() where user_id = p_user and used_at is null;
  update users set email = lower(p_email) where id = p_user;
end $$;
grant execute on function admin_correct_email(integer, text) to vantage_hub;
