-- Lets the events endpoint authenticate before it looks at the body (401 before 400).
create function ops_event_token_valid(p_token_hash text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from machine_tokens where token_hash = p_token_hash and purpose = 'ops-events' and revoked_at is null)
$$;
grant execute on function ops_event_token_valid(text) to vantage_hub;
