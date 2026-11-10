-- Log error groups are keyed by the application's own stack frames now, not the first frames of any
-- kind (framework frames split one error by HTTP method and named Groovy internals as its place).
-- The groups of 019 had the old keys and were an hour old, untriaged, without events: built again
-- from the last 24 hours by the next poll, as a silent backfill.
delete from error_groups where source = 'logs';
delete from log_error_poll_state;
