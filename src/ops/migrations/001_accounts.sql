-- Ops accounts: staff only, created by an admin, password + mandatory TOTP (src/shared/auth.tsx).
-- Ops is a single internal app with one database role (vantage_ops) that owns everything, so there
-- is no row-level security here; roles are enforced in src/ops/roles.ts.

create table users (
  id               integer generated always as identity primary key,
  email            text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  name             text not null check (length(name) between 1 and 200),
  role             text not null default 'viewer' check (role in ('admin', 'operator', 'viewer')),
  password_hash    text,
  totp_secret_enc  text,
  created_at       timestamptz not null default now(),
  created_by       integer references users on delete set null,
  disabled_at      timestamptz,
  last_login_at    timestamptz
);

create table invites (
  id                integer generated always as identity primary key,
  user_id           integer not null references users on delete cascade,
  token_hash        text not null unique,
  pending_totp_enc  text,
  expires_at        timestamptz not null,
  used_at           timestamptz,
  created_by        integer references users on delete set null,
  created_at        timestamptz not null default now()
);

create table sessions (
  id            integer generated always as identity primary key,
  user_id       integer not null references users on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  ip            text,
  user_agent    text,
  revoked_at    timestamptz
);
create index sessions_user on sessions (user_id);

create table login_attempts (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  email  text,
  ip     text,
  ok     boolean not null
);
create index login_attempts_email on login_attempts (email, at desc);
create index login_attempts_ip on login_attempts (ip, at desc);

create table audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     integer references users on delete set null,
  actor_label  text,
  action       text not null,
  target       text,
  detail       jsonb not null default '{}',
  ip           text
);
create index audit_log_at on audit_log (at desc);
