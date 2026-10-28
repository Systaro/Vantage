-- The overview and the sidebar compute 24 h uptime per environment.
create index monitor_checks_env_at on monitor_checks (environment_id, at desc);
