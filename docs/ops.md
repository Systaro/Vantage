# Vantage Ops

Ops is the internal half of Vantage: the process that *acts*. It runs Ansible playbooks, triggers
the GitLab pipelines behind scheduled test runs, and checks hosts. It has its own database
(`vantage_ops`), its own staff accounts and its own secrets, and it talks to the hub in one direction
only: it posts events. The hub never calls ops. See `docs/design.md` §2 and §6.6 for the reasoning.

One process (`bun run ops`, port 7101) serves the UI and the agent API and runs every scheduler
in-process: the cron runner, the central SSH sweep, silent-host detection, the outbox sender and
retention.

## Accounts and roles

Accounts work like the hub's (shared code in `src/shared/auth.tsx`): an admin creates them, the
person sets a password and enrols TOTP through a one-time invite link (72 h), login is password plus
TOTP, there is no sign-up and no e-mail reset. Tokens are stored as SHA-256, TOTP secrets encrypted
with `OPS_SECRET`. Resetting or disabling an account ends its sessions immediately.

| Role | May |
|---|---|
| viewer | read everything except users and the audit log |
| operator | + run templates, trigger pipeline schedules, cancel runs, manage hosts (incl. agent tokens) |
| admin | + manage users, Ansible templates and pipeline schedules (the trigger tokens are secrets) |

The table lives in one place, `src/ops/roles.ts`: a middleware maps every request to a permission
and the UI asks the same table before rendering a button. Writes not listed there need admin.

Bootstrap the first admin (also the recovery path when no admin is left):

```sh
bun run scripts/create-ops-admin.ts admin@systaro.de "Vorname Nachname"   # prints the invite link
```

Every write and every login attempt goes to the audit log (`/audit`, kept two years).

## Ansible

- The project is `ANSIBLE_PROJECT_DIR`: in production a checkout of `ansible-configs`, with
  `ANSIBLE_GIT_PULL=true` to run `git pull --ff-only` before every run (serialised, so two runs never
  pull at the same time). Locally a harmless example: `cp -R test/fixtures/ansible data/ansible-example`
  (`ping-local.yml`, `slow-local.yml`, both `hosts: localhost`, `connection: local`).
- A template is a playbook, an inventory (file or directory), an optional `--limit`, extra vars (a
  JSON object), check mode, an optional cron schedule (five fields, Europe/Berlin) and an enabled
  flag. Disabled templates run neither on schedule nor by hand.
- Paths must stay inside the project after symlinks are resolved: no absolute paths, no `..`, no
  segment starting with `-`, no symlink pointing outside. Checked on save and again right before each
  run (after the pull). The limit is restricted to `A-Z a-z 0-9 _ . , : ! & * [ ] -`, not starting
  with `-` (so `@file` and option injection are impossible).
- Runs: `ansible-playbook --inventory=./… [--limit=…] [--extra-vars=<json>] [--check] ./<playbook>`
  via `Bun.spawn` with an argv array (never a shell), cwd = the project, a minimal environment
  (`PATH`, `HOME`, `LANG`/`LC_ALL` if set, `ANSIBLE_FORCE_COLOR=0`, `ANSIBLE_NOCOLOR=1`,
  `PYTHONUNBUFFERED=1`, and `ANSIBLE_CONFIG` when the project has an `ansible.cfg`). Nothing else from
  the ops environment (database URLs, secrets) reaches the playbook.
- One run per template at a time (a partial unique index), at most two at once (the rest queue).
  Cancel sends SIGTERM to the run's process group and SIGKILL after 10 s.
- The log is written straight to `OPS_DATA_DIR/runs/<id>.log` and streamed to the run page over SSE
  (`public/ops-log.js`; the event id is the byte offset, so reconnects continue). Exit code, duration,
  trigger and who started or cancelled it are stored with a snapshot of the template.
- A failed or broken *scheduled* run raises `ansible:<template>` (warning); the next successful
  scheduled run resolves it. Manual failures are seen by whoever started them and send nothing.
- Logs are deleted after 90 days; the run rows stay.

## Pipeline schedules

Scheduled cloud test runs: a GitLab project (numeric id or `group/project`), a ref, a trigger token,
variables (`KEY=value`, keys `^[A-Z_][A-Z0-9_]*$`), a cron schedule and an enabled flag. Ops calls
`POST {GITLAB_URL}/api/v4/projects/:id/trigger/pipeline` with the form fields `token`, `ref` and
`variables[KEY]`, and records status, pipeline id and `web_url` for every trigger. The pipeline then
uploads its results to the hub's test ingest like any other run.

The trigger token is encrypted with `OPS_SECRET`, never rendered again (the form shows its last four
characters) and never logged or audited. A failed trigger (manual or scheduled) raises
`pipeline:<name>` (warning); the next successful trigger resolves it.

## Host checks

Hosts are either

- **agent**: the host runs `agent/vantage-agent.sh` from cron and posts its report to
  `POST /api/ingest/v1/report` with `Authorization: Bearer vha_…` (one token per host, shown once,
  stored as a hash, resettable); or
- **central**: ops runs the same script over SSH every interval:
  `ssh -o BatchMode=yes -o ConnectTimeout=10 -- <target> 'sh -s -- --print' < agent/vantage-agent.sh`.
  The target is `user@host` or a host alias from ops' SSH config, validated so it can never be read
  as an ssh option. An SSH call is killed after 120 s.

Checks and default thresholds (overridable per host):

| Check | Warning | Critical |
|---|---|---|
| disk usage per real filesystem | 85 % | 95 % |
| memory used | 90 % | 97 % |
| load (5 min) per CPU core | 2 | 4 |
| failed systemd units | ≥ 1 | |
| docker containers that should run but don't (`always` / `unless-stopped`, or restarting / dead) | ≥ 1 | |
| Elasticsearch (only with `VANTAGE_ES_URL`) | unreachable, or a node disk ≥ 90 % | an index is read-only (flood stage), or a node disk ≥ 95 % |

Reports are validated strictly (`src/shared/hosts/report.ts`: unknown keys, wrong types or values out of
range reject the whole report, max 64 KB, at most one report per host per 20 s) and kept 30 days with
the results as evaluated at the time. They also carry the CPU time since boot (`cpu`, ticks from
`/proc/stat`; optional, older agents leave it out). It has no threshold: the hub's server page turns two
consecutive reports into CPU usage. Each check has a state; a change sends an event:
ok → warning/critical fires, warning ↔ critical fires again with the new severity, back to ok
resolves, a check that disappears from the report (unmounted filesystem) resolves.

Two watchdogs run every minute:

- **silent**: a host without a report for three intervals (agent or central, also one that never
  reported) raises `host:<name>:silent` (critical); the next report resolves it.
- **sweep**: if no central sweep has finished for five minutes, `ops:sweep` (critical) is raised;
  otherwise every central host would look healthy on stale data. The next finished sweep resolves it.
  (If the whole ops process dies, nothing inside it can report that: put a hub heartbeat monitor on
  `/healthz` or on a cron job.)

### Installing the agent

Creating an agent host, or resetting its token, shows a one-liner once:

```sh
curl -fsSL https://ops.example/agent/vantage-agent.sh -o /tmp/vantage-agent.sh \
  && sudo sh /tmp/vantage-agent.sh --install --url https://ops.example --token vha_… --interval 5
```

As root this installs `/usr/local/bin/vantage-agent`, `/etc/vantage-agent.conf` (mode 600, holds the
token) and `/etc/cron.d/vantage-agent`, then sends one report. Without root it uses
`~/.local/bin`, `~/.config/vantage-agent.conf` and the user's crontab. `--uninstall` removes all of
it. The token never appears on curl's command line (it goes through a private curl config file). For
the ES check add `--es-url http://localhost:9200`. The script needs POSIX `sh`, `awk`, `df` and
`curl` (`curl` only for posting and the ES check); `--print` works without it.

The agent host must reach ops over HTTPS (VPN or allowlist, see below). `GET /agent/vantage-agent.sh`
is served without login; it contains no secrets.

Re-test the agent in containers with `sh test/fixtures/agent/docker-check.sh` (Debian, Ubuntu,
Alpine; uses only images that exist locally).

## Events to the hub

Every problem above goes through one function (`setAlert` in `src/ops/alerts.ts`) that compares
with the stored state and, in the same transaction, writes an outbox row. A sender delivers the
outbox strictly in order:

```
POST {OPS_HUB_URL}/api/internal/v1/events
Authorization: Bearer {OPS_HUB_EVENT_TOKEN}
{ "environment"?: "org/project/env", "subject": "host:web1:disk:/data", "state": "firing" | "resolved" | "notice",
  "severity": "critical" | "warning" | "info", "title": "…", "body"?: "…", "link"?: "https://ops…/hosts/3" }
→ 202 {"id": n} | 400 {"error"} | 401
```

- Subjects: `host:<name>:<check>` (`disk:<mount>`, `memory`, `load`, `systemd`, `docker`, `es`),
  `host:<name>:silent`, `ops:sweep`, `ansible:<template>`, `pipeline:<schedule>`. The hub prefixes
  them with `ops:`. `environment` is the host's hub environment path, when set.
- Network errors, 5xx and 429 are retried: the sender stops at the first one and backs off for the
  whole outbox (10 s doubling up to 1 h), so a `resolved` never overtakes its `firing`. Any other 4xx
  (including 401) marks that event failed and keeps it for inspection on `/events`; an admin can
  resend the newest event of a subject.
- Events carry no log output: the body says what is wrong, the link leads into ops.
- Without `OPS_HUB_EVENT_TOKEN` events stay in the outbox and the dashboard shows a warning. Create
  the token in the hub under Verwaltung → Maschinen-Tokens.

## Deployment

- **Internal only.** Put ops behind the VPN or an IP allowlist; it holds root-equivalent power over
  the fleet. Agent hosts need to reach `/api/ingest/v1/report` and `/agent/vantage-agent.sh`, nothing
  else (both take no session).
- Same image as the hub, started as `bun run src/ops/index.tsx`. It needs `ansible-playbook`, `git`,
  `ssh` and `curl` in the image, the SSH private key(s) for the fleet in the ops user's `~/.ssh` (with
  `known_hosts` filled: BatchMode refuses unknown host keys), and the `ansible-configs` checkout with
  its vault password file if the playbooks use one.
- `OPS_DATA_DIR` (run logs) on a persistent volume. Database: `vantage_ops` with role `vantage_ops`
  (`bun run migrate ops` uses `OPS_MIGRATE_URL`).
- Shutdown: SIGTERM stops the schedulers, gives running playbooks 30 s, then cancels them (SIGTERM,
  SIGKILL after 10 s). Set the container stop grace period to at least 45 s
  (`stop_grace_period: 45s`), or running playbooks are killed without a log footer. Runs that were
  still queued or running when the process died are marked as interrupted at the next start.
- Configuration (`.env.example`): `OPS_PORT`, `OPS_PUBLIC_URL` (used in agent install lines and event
  links), `OPS_SECRET`, `OPS_DATABASE_URL`, `OPS_DATA_DIR`, `OPS_HUB_URL`, `OPS_HUB_EVENT_TOKEN`,
  `ANSIBLE_PROJECT_DIR`, `ANSIBLE_GIT_PULL`, `GITLAB_URL`; optional `ANSIBLE_PLAYBOOK_BIN`,
  `OPS_GIT_BIN`, `OPS_SSH_BIN` (tests use fakes).

## Retention

| Data | Kept |
|---|---|
| run logs (files) | 90 days; run rows forever |
| host reports | 30 days |
| delivered events | 30 days; failed 90 days; pending until delivered |
| pipeline triggers | 1 year |
| login attempts, ended sessions, used invites | 30 days |
| audit log | 2 years |

## Development

```sh
bun run migrate ops
bun run scripts/dev-ops-session.ts dev@systaro.de operator   # cookie for curl/browser, dev only
bun run ops                                                   # :7101
bun test test/ops-*.test.ts
```

Tests use a throwaway database per file, fake `ansible-playbook` / `git` / `ssh` scripts, and local
`Bun.serve` stubs for GitLab and the hub. One test runs the real `ansible-playbook` against
`ping-local.yml` when it is installed. Nothing in the tests touches real hosts, GitLab or the hub.
