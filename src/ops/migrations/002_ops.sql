-- Ansible templates and runs, GitLab pipeline schedules, hosts and their checks, alert state and the
-- event outbox to the hub. See docs/ops.md.

-- ── Ansible ────────────────────────────────────────────────────────────────────────────────────

create table templates (
  id           integer generated always as identity primary key,
  name         text not null unique check (length(name) between 1 and 200),
  -- Paths relative to ANSIBLE_PROJECT_DIR; re-checked against the real filesystem before each run.
  playbook     text not null check (length(playbook) between 1 and 500),
  inventory    text not null check (length(inventory) between 1 and 500),
  limit_hosts  text not null default ''
               check (length(limit_hosts) <= 500 and limit_hosts ~ '^[A-Za-z0-9_.,:!&*\[\]-]*$' and limit_hosts !~ '^-'),
  extra_vars   jsonb not null default '{}' check (jsonb_typeof(extra_vars) = 'object'),
  check_mode   boolean not null default false,
  schedule     text check (schedule is null or length(schedule) between 9 and 120),
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   integer references users on delete set null,
  updated_at   timestamptz not null default now(),
  updated_by   integer references users on delete set null
);

create table runs (
  id                  integer generated always as identity primary key,
  template_id         integer references templates on delete set null,
  -- What actually ran: a snapshot, so editing the template later does not rewrite history.
  template_name       text not null,
  playbook            text not null,
  inventory           text not null,
  limit_hosts         text not null,
  extra_vars          jsonb not null,
  check_mode          boolean not null,
  trigger             text not null check (trigger in ('manual', 'schedule')),
  started_by          integer references users on delete set null,
  started_by_label    text not null,
  status              text not null default 'queued'
                      check (status in ('queued', 'running', 'ok', 'failed', 'cancelled', 'error')),
  exit_code           integer,
  error               text,
  cancelled_by_label  text,
  queued_at           timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  duration_ms         integer,
  log_deleted_at      timestamptz
);
create index runs_template on runs (template_id, id desc);
create index runs_status on runs (status) where status in ('queued', 'running');
-- One run per template at a time, enforced where it cannot race.
create unique index runs_one_active_per_template on runs (template_id) where status in ('queued', 'running');

-- ── GitLab pipeline schedules ──────────────────────────────────────────────────────────────────

create table pipeline_schedules (
  id          integer generated always as identity primary key,
  name        text not null unique check (length(name) between 1 and 200),
  project     text not null check (project ~ '^([0-9]{1,12}|[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*){1,10})$'),
  ref         text not null check (ref ~ '^[A-Za-z0-9._/-]{1,255}$'),
  token_enc   text not null,
  token_hint  text not null,
  variables   jsonb not null default '[]' check (jsonb_typeof(variables) = 'array'),
  schedule    text check (schedule is null or length(schedule) between 9 and 120),
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  integer references users on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  integer references users on delete set null
);

create table pipeline_triggers (
  id                integer generated always as identity primary key,
  schedule_id       integer not null references pipeline_schedules on delete cascade,
  trigger           text not null check (trigger in ('manual', 'schedule')),
  started_by        integer references users on delete set null,
  started_by_label  text not null,
  at                timestamptz not null default now(),
  status            text not null check (status in ('ok', 'failed')),
  http_status       integer,
  pipeline_id       bigint,
  web_url           text,
  error             text
);
create index pipeline_triggers_schedule on pipeline_triggers (schedule_id, id desc);

-- ── Hosts and checks ───────────────────────────────────────────────────────────────────────────

create table hosts (
  id                integer generated always as identity primary key,
  name              text not null unique check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  mode              text not null check (mode in ('agent', 'central')),
  interval_seconds  integer not null default 300 check (interval_seconds between 60 and 86400),
  ssh_target        text check (ssh_target ~ '^([a-z_][a-z0-9_.-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$'),
  environment_path  text check (environment_path ~ '^[a-z0-9][a-z0-9-]{0,62}/[a-z0-9][a-z0-9-]{0,62}/[a-z0-9][a-z0-9-]{0,62}$'),
  thresholds        jsonb not null default '{}' check (jsonb_typeof(thresholds) = 'object'),
  token_hash        text unique,
  token_prefix      text,
  enabled           boolean not null default true,
  last_report_at    timestamptz,
  last_attempt_at   timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  created_at        timestamptz not null default now(),
  created_by        integer references users on delete set null,
  updated_at        timestamptz not null default now(),
  check (mode = 'agent' or ssh_target is not null)
);

-- One row per accepted report (30 days), with the evaluated results as they were at the time.
create table host_reports (
  id       bigint generated always as identity primary key,
  host_id  integer not null references hosts on delete cascade,
  at       timestamptz not null default now(),
  source   text not null check (source in ('agent', 'central')),
  report   jsonb not null,
  results  jsonb not null,
  worst    text not null check (worst in ('ok', 'warning', 'critical'))
);
create index host_reports_host on host_reports (host_id, at desc);
create index host_reports_at on host_reports (at);

create table check_states (
  host_id     integer not null references hosts on delete cascade,
  check_key   text not null,
  severity    text not null check (severity in ('ok', 'warning', 'critical')),
  value       double precision,
  detail      text not null default '',
  since       timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (host_id, check_key)
);

-- ── Alerts and the outbox to the hub ───────────────────────────────────────────────────────────

-- Open problems, keyed by the event subject. A row exists while the subject is firing; state
-- changes are written in the same transaction as the outbox row, so the two never disagree.
create table alerts (
  subject      text primary key check (length(subject) between 1 and 200),
  severity     text not null check (severity in ('warning', 'critical')),
  title        text not null,
  body         text,
  link         text,
  environment  text,
  since        timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table outbox (
  id               integer generated always as identity primary key,
  created_at       timestamptz not null default now(),
  subject          text not null check (length(subject) between 1 and 200),
  state            text not null check (state in ('firing', 'resolved', 'notice')),
  severity         text not null check (severity in ('critical', 'warning', 'info')),
  title            text not null check (length(title) between 1 and 300),
  body             text check (length(body) <= 4000),
  link             text check (length(link) <= 1000),
  environment      text,
  status           text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts         integer not null default 0,
  last_attempt_at  timestamptz,
  last_error       text,
  sent_at          timestamptz,
  hub_event_id     bigint
);
create index outbox_pending on outbox (id) where status = 'pending';
create index outbox_created on outbox (created_at);
