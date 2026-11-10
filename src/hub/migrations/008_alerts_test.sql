-- "Send a test message" for a channel. The hub role cannot write notifications; this function can,
-- and only for admins. The event is marked processed so the router does not fan it out again.
create function admin_test_channel(p_channel integer) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare ev bigint;
begin
  if not vantage_is_admin() then raise exception 'admin only'; end if;
  if not exists (select 1 from channels where id = p_channel) then return null; end if;
  insert into events (source, subject_key, state, severity, title, body, processed_at)
  values ('system', 'test:' || p_channel || ':' || extract(epoch from now())::bigint, 'notice', 'info',
          'Testnachricht von Vantage', 'Wenn Sie das lesen, kommt dieser Kanal an.', now())
  returning id into ev;
  insert into notifications (event_id, channel_id) values (ev, p_channel);
  return ev;
end $$;
grant execute on function admin_test_channel(integer) to vantage_hub;
