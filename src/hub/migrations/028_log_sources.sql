-- Several logs sources per environment (#69812): an application of several services writes one index
-- family per service (a webshop: shop, shop-search-service, shop-translation-service, …). Every logs source gets
-- a name, unique in its environment; the other kinds stay at one row per environment.

alter table environment_sources add column name text;
-- The existing sources are named after their index pattern without prefix and wildcard.
update environment_sources
set name = left(coalesce(nullif(regexp_replace(regexp_replace(config->>'index', '^logstash-', ''), '[-_.]*\*.*$', ''), ''), 'Logs'), 40)
where kind = 'logs';

alter table environment_sources drop constraint environment_sources_environment_id_kind_key;
create unique index environment_sources_one_per_kind on environment_sources (environment_id, kind) where kind <> 'logs';
create unique index environment_sources_logs_name on environment_sources (environment_id, lower(name)) where kind = 'logs';
alter table environment_sources add constraint environment_sources_name_check
  check (case when kind = 'logs' then name is not null and length(name) between 1 and 40 else name is null end);

-- The log error poll stands per source now: sources lag differently, and a new source starts with its
-- own silent backfill without reading the others again (which would count their entries twice).
alter table log_error_poll_state add column source_id integer references environment_sources on delete cascade;
update log_error_poll_state p set source_id = s.id
from environment_sources s where s.environment_id = p.environment_id and s.kind = 'logs';
delete from log_error_poll_state where source_id is null;
alter table log_error_poll_state drop constraint log_error_poll_state_pkey;
alter table log_error_poll_state drop column environment_id;
alter table log_error_poll_state add primary key (source_id);
