-- Events → incidents → notifications. Every module reports through `events`; see design §5.

create table events (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  source          text not null check (source in ('uptime', 'tests', 'errors', 'ops', 'system')),
  environment_id  integer references environments on delete cascade,
  subject_key     text not null,
  state           text not null check (state in ('firing', 'resolved', 'notice')),
  severity        text not null check (severity in ('critical', 'warning', 'info')),
  title           text not null,
  body            text,
  link            text,
  processed_at    timestamptz
);
create index events_unprocessed on events (id) where processed_at is null;
create index events_env_at on events (environment_id, at desc);

create table incidents (
  id              integer generated always as identity primary key,
  subject_key     text not null,
  source          text not null,
  environment_id  integer references environments on delete cascade,
  severity        text not null,
  title           text not null,
  opened_at       timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  resolved_at     timestamptz,
  opened_event_id bigint references events on delete set null
);
create unique index incidents_one_open on incidents (subject_key) where resolved_at is null;
create index incidents_env on incidents (environment_id, opened_at desc);

create table channels (
  id          integer generated always as identity primary key,
  name        text not null check (length(name) between 1 and 200),
  kind        text not null check (kind in ('email', 'slack', 'teams', 'webhook')),
  -- Recipients / webhook URL / signing secret, encrypted with HUB_SECRET (AES-256-GCM).
  config_enc  text not null,
  summary     text not null default '',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table routes (
  id               integer generated always as identity primary key,
  channel_id       integer not null references channels on delete cascade,
  scope_kind       text not null check (scope_kind in ('all', 'organisation', 'project', 'environment')),
  scope_id         integer,
  sources          text[] not null default '{uptime,tests,errors,ops,system}',
  min_severity     text not null default 'warning' check (min_severity in ('critical', 'warning', 'info')),
  created_at       timestamptz not null default now(),
  check ((scope_kind = 'all') = (scope_id is null))
);

create table subscriptions (
  id            integer generated always as identity primary key,
  user_id       integer not null references users on delete cascade,
  scope_kind    text not null check (scope_kind in ('all', 'project', 'environment')),
  scope_id      integer,
  min_severity  text not null default 'warning' check (min_severity in ('critical', 'warning', 'info')),
  created_at    timestamptz not null default now(),
  check ((scope_kind = 'all') = (scope_id is null))
);
create unique index subscriptions_unique on subscriptions (user_id, scope_kind, coalesce(scope_id, 0));

create table notifications (
  id              bigint generated always as identity primary key,
  event_id        bigint not null references events on delete cascade,
  channel_id      integer references channels on delete cascade,
  user_id         integer references users on delete cascade,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz not null default now(),
  check ((channel_id is null) <> (user_id is null))
);
create index notifications_due on notifications (next_attempt_at) where status = 'pending';

alter table events enable row level security;
alter table incidents enable row level security;
alter table channels enable row level security;
alter table routes enable row level security;
alter table subscriptions enable row level security;
alter table notifications enable row level security;

-- Events without an environment (system, fleet-wide ops) are for admins only.
create policy read on events for select using (
  vantage_is_admin() or (environment_id is not null and environment_id in (select vantage_env_ids(1))));
create policy read on incidents for select using (
  vantage_is_admin() or (environment_id is not null and environment_id in (select vantage_env_ids(1))));
create policy admin_all on channels for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy admin_all on routes for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy admin_read on notifications for select using (vantage_is_admin());
-- Users manage their own subscriptions, and only for scopes they can actually see.
create policy own on subscriptions for all
  using (user_id = vantage_uid())
  with check (
    user_id = vantage_uid() and (
      scope_kind = 'all'
      or (scope_kind = 'project' and scope_id in (select vantage_project_ids()))
      or (scope_kind = 'environment' and scope_id in (select vantage_env_ids(1)))
    ));

grant select on events, incidents, notifications to vantage_hub;
grant select (id, name, kind, summary, enabled, created_at) on channels to vantage_hub;
grant insert (name, kind, config_enc, summary, enabled) on channels to vantage_hub;
grant update (name, config_enc, summary, enabled) on channels to vantage_hub;
grant delete on channels to vantage_hub;
grant select, insert, update, delete on routes, subscriptions to vantage_hub;

grant select, insert, update, delete on events, incidents, channels, routes, subscriptions, notifications to vantage_worker;

-- Machine tokens for writers that are not users: ops posting events. Shown once, stored hashed.
create table machine_tokens (
  id            integer generated always as identity primary key,
  name          text not null check (length(name) between 1 and 200),
  purpose       text not null check (purpose in ('ops-events')),
  token_hash    text not null unique,
  token_prefix  text not null,
  created_by    integer references users on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
alter table machine_tokens enable row level security;
create policy admin_all on machine_tokens for all using (vantage_is_admin()) with check (vantage_is_admin());
grant select (id, name, purpose, token_prefix, created_by, created_at, last_used_at, revoked_at) on machine_tokens to vantage_hub;
grant insert (name, purpose, token_hash, token_prefix, created_by) on machine_tokens to vantage_hub;
grant update (revoked_at) on machine_tokens to vantage_hub;
grant select, update on machine_tokens to vantage_worker;

-- Ops → hub. The token is verified here; the environment is addressed by its path so ops never needs
-- to know hub ids. Unknown paths are stored without environment (admin-only visibility).
create function ingest_ops_event(
  p_token_hash text, p_env_path text, p_subject text, p_state text, p_severity text,
  p_title text, p_body text, p_link text
) returns bigint language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare tok integer; env integer; ev bigint;
begin
  update machine_tokens set last_used_at = now()
  where token_hash = p_token_hash and purpose = 'ops-events' and revoked_at is null
  returning id into tok;
  if tok is null then return null; end if;
  if p_env_path is not null then
    select e.id into env from environments e
      join projects p on p.id = e.project_id
      join organisations o on o.id = p.organisation_id
    where o.slug || '/' || p.slug || '/' || e.slug = p_env_path;
  end if;
  insert into events (source, environment_id, subject_key, state, severity, title, body, link)
  values ('ops', env, 'ops:' || left(p_subject, 200), p_state, p_severity, left(p_title, 300), left(p_body, 4000), left(p_link, 1000))
  returning id into ev;
  return ev;
end $$;
revoke execute on function ingest_ops_event(text, text, text, text, text, text, text, text) from public;
grant execute on function ingest_ops_event(text, text, text, text, text, text, text, text) to vantage_hub;
