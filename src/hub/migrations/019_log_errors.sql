-- Error groups from the logs as well: the ERROR entries of an environment's logs source, grouped by
-- logger, exception class and call path (or, without a stack trace, by the message without its
-- variable parts). For applications that send nothing to APM. Same table, same triage and the same
-- "Neuer Fehler" events; `source` tells the two apart.

alter table error_groups add column source text not null default 'apm' check (source in ('apm', 'logs'));
-- logs: the newest entry of the group, shown like an entry of the logs page.
alter table error_groups add column sample_entry_id text;

-- Where the log error poll stands, per environment. Deleted when the logs source changes, so the
-- next poll is a silent backfill again.
create table log_error_poll_state (
  environment_id  integer primary key references environments on delete cascade,
  polled_until    timestamptz,
  last_error      text,
  updated_at      timestamptz not null default now()
);

alter table log_error_poll_state enable row level security;
create policy admin_read on log_error_poll_state for select using (vantage_is_admin());
create policy admin_delete on log_error_poll_state for delete using (vantage_is_admin());

grant select, delete on log_error_poll_state to vantage_hub;
grant select, insert, update, delete on log_error_poll_state to vantage_worker;
