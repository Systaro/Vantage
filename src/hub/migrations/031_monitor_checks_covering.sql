-- Uptime figures read up to a month of checks per monitor on every page that shows them (overview,
-- uptime tab, monitor page). The table stores checks in the order they arrive, so one monitor's month
-- is spread over nearly every page of it, and each page view read most of the table. With the columns
-- those figures need inside the index (environment_id for the read policy), they come from the index
-- alone, where one monitor's checks lie together.
drop index monitor_checks_monitor_at;
create index monitor_checks_monitor_at on monitor_checks (monitor_id, at desc) include (environment_id, ok, latency_ms);
drop index monitor_checks_env_at;
create index monitor_checks_env_at on monitor_checks (environment_id, at desc) include (ok);
