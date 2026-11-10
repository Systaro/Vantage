-- Connections to the external systems Vantage reads from (logs and APM clusters, Wazuh indexer,
-- Dependency-Track) and sends through (mail relay). One row per system, configured by admins on
-- /admin/integrations. The credential is encrypted with HUB_SECRET (`secret_enc`); `config` holds
-- only non-secret settings (URL, sender, CA certificate).

create table integrations (
  kind              text primary key check (kind in ('logs', 'apm', 'wazuh', 'dependency_track', 'mail')),
  config            jsonb not null default '{}',
  secret_enc        text,
  updated_at        timestamptz not null default now(),
  updated_by        integer references users on delete set null,
  checked_at        timestamptz,
  check_ok          boolean,
  check_message     text
);

alter table integrations enable row level security;
create policy admin_all on integrations for all using (vantage_is_admin()) with check (vantage_is_admin());

grant select, insert, update, delete on integrations to vantage_hub;
grant select, insert, update, delete on integrations to vantage_worker;

-- Every request that queries a cluster needs its connection, whoever is logged in (a customer's logs
-- page reads the logs cluster too). The hub never selects the table for that; it calls this function,
-- which returns exactly one system's settings and nothing else.
create function integration_load(p_kind text)
  returns table (config jsonb, secret_enc text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select i.config, i.secret_enc from integrations i where i.kind = p_kind
$$;
grant execute on function integration_load(text) to vantage_hub, vantage_worker;
