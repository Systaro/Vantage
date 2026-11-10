-- The covering indexes of 031 only spare the table for pages vacuum has marked all-visible. By default
-- autovacuum waits until a fifth of this table is new, which is several days of checks; until then every
-- page view still fetches those days row by row from the table. Vacuum after one percent instead.
alter table monitor_checks set (autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_scale_factor = 0.02);
