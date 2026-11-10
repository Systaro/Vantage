-- Test suites and Playwright runs. Ingestion goes through ingest_test_run(), which checks the token.

create table test_suites (
  id              integer generated always as identity primary key,
  environment_id  integer not null references environments on delete cascade,
  slug            text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name            text not null check (length(name) between 1 and 200),
  description     text,
  created_at      timestamptz not null default now(),
  unique (environment_id, slug)
);

create table ingest_tokens (
  id            integer generated always as identity primary key,
  suite_id      integer not null references test_suites on delete cascade,
  name          text not null check (length(name) between 1 and 200),
  token_hash    text not null unique,
  token_prefix  text not null,
  expires_at    timestamptz,
  created_by    integer references users on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create table test_runs (
  id              integer generated always as identity primary key,
  suite_id        integer not null references test_suites on delete cascade,
  environment_id  integer not null references environments on delete cascade,
  received_at     timestamptz not null default now(),
  started_at      timestamptz,
  duration_ms     integer,
  status          text not null check (status in ('passed', 'failed', 'flaky', 'interrupted')),
  total           integer not null default 0,
  passed          integer not null default 0,
  failed          integer not null default 0,
  flaky           integer not null default 0,
  skipped         integer not null default 0,
  commit_sha      text,
  branch          text,
  pipeline_url    text,
  job_url         text,
  has_report      boolean not null default false,
  report_purged   boolean not null default false,
  token_id        integer references ingest_tokens on delete set null
);
create index test_runs_suite on test_runs (suite_id, received_at desc);
create index test_runs_env on test_runs (environment_id, received_at desc);

create table test_cases (
  id              bigint generated always as identity primary key,
  run_id          integer not null references test_runs on delete cascade,
  environment_id  integer not null references environments on delete cascade,
  title           text not null,
  file            text,
  project         text,
  status          text not null check (status in ('passed', 'failed', 'flaky', 'skipped', 'timedOut', 'interrupted')),
  duration_ms     integer,
  retries         integer not null default 0,
  error           text
);
create index test_cases_run on test_cases (run_id);

alter table test_suites enable row level security;
alter table ingest_tokens enable row level security;
alter table test_runs enable row level security;
alter table test_cases enable row level security;

create policy read on test_suites for select using (environment_id in (select vantage_env_ids(1)));
create policy admin_write on test_suites for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy admin_all on ingest_tokens for all using (vantage_is_admin()) with check (vantage_is_admin());
create policy read on test_runs for select using (environment_id in (select vantage_env_ids(1)));
create policy read on test_cases for select using (environment_id in (select vantage_env_ids(1)));

grant select, insert, update, delete on test_suites to vantage_hub;
grant select (id, suite_id, name, token_prefix, expires_at, created_by, created_at, last_used_at, revoked_at) on ingest_tokens to vantage_hub;
grant insert (suite_id, name, token_hash, token_prefix, expires_at, created_by) on ingest_tokens to vantage_hub;
grant update (revoked_at) on ingest_tokens to vantage_hub;
grant select on test_runs, test_cases to vantage_hub;
grant select, insert, update, delete on test_suites, ingest_tokens, test_runs, test_cases to vantage_worker;

-- Resolves an ingest token to its suite (for the upload route to validate before parsing).
create function ingest_token_suite(p_token_hash text)
  returns table (token_id integer, suite_id integer, environment_id integer)
  language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, s.id, s.environment_id
  from ingest_tokens t join test_suites s on s.id = t.suite_id
  where t.token_hash = p_token_hash and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
$$;

-- Stores one run and its cases. The token is re-checked inside the same transaction, so a token
-- revoked between upload and insert cannot write. Emits a tests event when the suite flips colour.
create function ingest_test_run(p_token_hash text, p_run jsonb, p_cases jsonb)
  returns integer language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare tok record; rid integer; prev text; s record;
begin
  select t.id as token_id, su.id as suite_id, su.environment_id, su.name as suite_name into tok
  from ingest_tokens t join test_suites su on su.id = t.suite_id
  where t.token_hash = p_token_hash and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
  for update of t;
  if not found then return null; end if;
  update ingest_tokens set last_used_at = now() where id = tok.token_id;

  select status into prev from test_runs where suite_id = tok.suite_id order by received_at desc limit 1;

  insert into test_runs (suite_id, environment_id, started_at, duration_ms, status, total, passed, failed, flaky,
                         skipped, commit_sha, branch, pipeline_url, job_url, has_report, token_id)
  values (tok.suite_id, tok.environment_id,
          (p_run->>'started_at')::timestamptz, (p_run->>'duration_ms')::integer, p_run->>'status',
          coalesce((p_run->>'total')::integer, 0), coalesce((p_run->>'passed')::integer, 0),
          coalesce((p_run->>'failed')::integer, 0), coalesce((p_run->>'flaky')::integer, 0),
          coalesce((p_run->>'skipped')::integer, 0),
          left(p_run->>'commit_sha', 64), left(p_run->>'branch', 200), left(p_run->>'pipeline_url', 1000),
          left(p_run->>'job_url', 1000), coalesce((p_run->>'has_report')::boolean, false), tok.token_id)
  returning id into rid;

  insert into test_cases (run_id, environment_id, title, file, project, status, duration_ms, retries, error)
  select rid, tok.environment_id, left(c->>'title', 1000), left(c->>'file', 500), left(c->>'project', 100),
         c->>'status', (c->>'duration_ms')::integer, coalesce((c->>'retries')::integer, 0), left(c->>'error', 4000)
  from jsonb_array_elements(p_cases) c;

  if (p_run->>'status') = 'failed' and (prev is null or prev <> 'failed') then
    insert into events (source, environment_id, subject_key, state, severity, title, body, link)
    values ('tests', tok.environment_id, 'suite:' || tok.suite_id, 'firing', 'warning',
            'Tests rot: ' || tok.suite_name,
            (p_run->>'failed') || ' von ' || (p_run->>'total') || ' Tests fehlgeschlagen',
            '/runs/' || rid);
  elsif (p_run->>'status') <> 'failed' and prev = 'failed' then
    insert into events (source, environment_id, subject_key, state, severity, title, body, link)
    values ('tests', tok.environment_id, 'suite:' || tok.suite_id, 'resolved', 'warning',
            'Tests wieder grün: ' || tok.suite_name, null, '/runs/' || rid);
  end if;
  return rid;
end $$;

grant execute on function ingest_token_suite(text), ingest_test_run(text, jsonb, jsonb) to vantage_hub;
