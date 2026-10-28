-- Error polling details (design §6.3).
-- A state row without `polled_until` means "never polled successfully": the next poll is the silent
-- 24 h backfill. A first poll that fails still records its error, which needs the null.
alter table error_poll_state alter column polled_until drop not null;

-- When an admin points an APM source at another service, the poll state is reset so that the new
-- service's existing errors arrive as a silent backfill instead of a burst of "new error" events.
create policy admin_delete on error_poll_state for delete using (vantage_is_admin());
grant delete on error_poll_state to vantage_hub;

-- The error list filters by status and sorts by last seen.
create index error_groups_env_status_last on error_groups (environment_id, status, last_seen_at desc);
