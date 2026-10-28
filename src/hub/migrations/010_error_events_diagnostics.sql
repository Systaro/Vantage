-- Error events carry exception messages and code locations from the application, which is
-- diagnostics data (level 2). Before this, any overview user could read them on the incidents page.
-- Mail delivery already required level 2 (requiredLevel in the alert engine); now the UI matches.
drop policy read on events;
create policy read on events for select using (
  vantage_is_admin()
  or (environment_id is not null and source <> 'errors' and environment_id in (select vantage_env_ids(1)))
  or (environment_id is not null and source = 'errors' and environment_id in (select vantage_env_ids(2)))
);

drop policy read on incidents;
create policy read on incidents for select using (
  vantage_is_admin()
  or (environment_id is not null and source <> 'errors' and environment_id in (select vantage_env_ids(1)))
  or (environment_id is not null and source = 'errors' and environment_id in (select vantage_env_ids(2)))
);
