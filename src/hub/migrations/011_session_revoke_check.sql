-- Users may end their own sessions, never revive one: the row must stay revoked after the update.
drop policy own_revoke on sessions;
create policy own_revoke on sessions for update
  using (user_id = vantage_uid())
  with check (user_id = vantage_uid() and revoked_at is not null);
