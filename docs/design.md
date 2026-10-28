# Vantage — design

Vantage is Systaro's observability and operations suite: one place where Systaro staff and customers
see uptime, test runs, errors, logs and APM for the environments they were granted, get notified when
something breaks, and where Systaro runs its fleet automation (Ansible, scheduled test pipelines,
host checks).

Status: 2026-10-12, first build. Decisions below were made with the product owner in a design session
(1-3) or by Claude while building (marked *build decision*), and can be revisited.

## 1. Decisions that shape everything

1. **Customers log in.** They get their own accounts and see only what they were granted. Systaro
   staff create every account and every grant. Customers never invite, grant or revoke (a customer
   admin role was rejected as too insecure).
2. **No tenants, only grants.** Access is a set of grants per user. A grant can point at a project of
   any organisation; the organisation is a label for grouping, not a wall. Systaro employees get
   grants like everybody else; only the small `admin` group sees everything.
   Full C5 tenant separation is out of scope: everything runs on shared infrastructure, separation is
   logical, enforced in one place and covered by tests. Vantage must never be described as offering
   "Mandantentrennung" or C5 compliance.
3. **A grant = user + project + (all environments | named list) + level.**
   `overview` = uptime, test runs, environments, incidents. `diagnostics` = overview + errors, logs,
   APM. `security` (2026-10-15) = diagnostics + known vulnerabilities (Dependency-Track, later
   Wazuh); only ever granted explicitly. "All environments" includes environments created later; a
   named list never does.

## 2. Architecture

One repository, one container image, three processes.

```
                 customers + staff (browser)                    CI pipelines, cron jobs
                           │                                            │
                           ▼                                            ▼
               ┌───────────────────────┐   heartbeats, test reports  ┌──────────────┐
               │ hub  :7100            │◄────────────────────────────│ Bearer tokens│
               │ UI + API, RLS role    │                             └──────────────┘
               └──────────┬────────────┘
     reads (RLS)          │ Postgres `vantage`        events ▲ (token, write-only)
                          ▼                                  │
               ┌───────────────────────┐           ┌─────────┴─────────────┐
               │ worker (no port)      │           │ ops  :7101 (internal) │
               │ probes, alerts,       │           │ Ansible, test         │
               │ error polling,        │           │ schedules, host checks│
               │ retention, BYPASSRLS  │           │ own DB `vantage_ops`  │
               └──────────┬────────────┘           └───────────────────────┘
                          │ read-only
                          ▼
        logs ES (logs cluster, 7.17)      APM ES (APM cluster, 7.15)
```

- **hub** is the only process customers talk to. It holds read-only credentials: its DB role is
  subject to row-level security, its ES credentials are read-only, it stores no pipeline-trigger or
  Ansible secrets. A compromised hub can leak data it can read; it cannot deploy, trigger a pipeline
  or touch a server.
- **worker** runs everything scheduled for the hub database. It uses a DB role with `BYPASSRLS` and
  has no HTTP port, so nothing reachable from the internet can bypass RLS.
- **ops** is internal-only (VPN / IP allowlist in front). It *acts*: runs `ansible-playbook`,
  triggers GitLab pipelines for scheduled test runs, sweeps hosts. It has its own database, its own
  staff accounts and its own secrets. It talks to the hub in one direction only: it posts events to
  `POST /api/internal/v1/events`. The hub never calls ops.

*Build decision:* hub and ops are separate processes with separate databases rather than modules
in one app, because ops holds root-equivalent power over the fleet and the hub is internet-facing.
Shared *code* lives in `src/shared`; shared *data* does not exist.

### Stack

Bun + TypeScript + Hono, server-rendered JSX (`hono/jsx`) with htmx for partial updates and polling.
Postgres 17 for both databases. Elasticsearch is only read. No frontend build step.

Dependencies are kept deliberately few: `hono`, `htmx.org` (served as a static file), `nodemailer`
(SMTP), `croner` (cron expressions), `uqr` (QR code for TOTP enrolment), `fflate` (zip extraction of
Playwright HTML reports). Password hashing (argon2id), SHA-256, HMAC, AES-GCM and the Postgres client
come from Bun / WebCrypto.

### Ports (local)

| Process | Port |
|---|---|
| hub (UI + API) | 7100 |
| ops (UI + API) | 7101 |
| Postgres (dev container) | 5460 |
| Elasticsearch (dev container, stands in for both clusters) | 5461 |
| Mailpit SMTP / UI (dev container) | 5462 / 5463 |

CORS: not needed — every UI is served from the same origin as its API. Test reports are served from a
second origin (`REPORTS_URL`, see 6.5), which is the point of it.

## 3. Data model (hub database `vantage`)

```
organisations ─< projects ─< environments ─< monitors ─< monitor_checks
                    │              │           └── monitor_state
                    │              ├─< environment_sources (logs index pattern / APM service)
                    │              ├─< test_suites ─< test_runs ─< test_cases
                    │              ├─< error_groups
                    │              └─< events ─ incidents
users ─< grants >── projects
          └─< grant_environments >── environments
users ─< sessions, invites, subscriptions
channels ─< routes          notifications (event × channel|user)
audit_log, login_attempts, ingest_tokens
integrations (one row per external system: logs, apm, wazuh, dependency_track, mail)
```

### 3.1 The access function

Everything visible hangs off an environment. One SQL function answers "what level does this user
have on this environment":

```
vantage_level(user_id, environment_id) → 0 none | 1 overview | 2 diagnostics | 3 security
```

- admin users → 3 everywhere.
- otherwise the highest level of any non-expired grant on the environment's project whose
  `all_environments` is true or whose `grant_environments` contains the environment.

### 3.2 Row-level security

The hub connects as `vantage_hub`, which does not own the tables and has RLS enforced. Every request
runs in a transaction that first sets `vantage.user_id` (and nothing else; admin status is looked up,
not passed). Policies:

| Table | Visible when |
|---|---|
| organisations, projects | user has level ≥ 1 on any of its environments, or is admin |
| environments, monitors, monitor_state, monitor_checks, test_suites, test_runs, test_cases, events, incidents | level ≥ 1 on the environment |
| error_groups, environment_sources | level ≥ 2 |
| security_findings, security_projects, security_agents; events and incidents with source `security` | level 3 |
| users | own row, or admin |
| grants, grant_environments | own grants, or admin |
| sessions, subscriptions | own rows |
| channels, routes, audit_log, ingest_tokens, invites, integrations | admin |
| api_tokens | own rows (admins: all, to revoke) |

Writes to registry, grants, users, channels, monitors, sources and suites require admin in the
policy, not just in the route. A query that runs without `vantage.user_id` set sees nothing (fail
closed). Pre-login lookups (session by token hash, user by email, invite by token hash) go through
three `SECURITY DEFINER` functions so the hub role never needs to read other users' rows.

ES has no equivalent on these clusters (the logs cluster runs without security; document-level
security needs a paid licence). Log and APM queries are therefore built server-side from
`environment_sources` rows that the user can only read with level 2 under RLS; the user's own input
never chooses an index or a service. See 6.4.

### 3.3 Users and auth

- Local accounts for everybody: email + password (argon2id) + **mandatory TOTP**. No SSO in v1 was
  the first build decision (customers have no GitLab accounts, and two login paths double the attack
  surface).
- **Cortex login for staff** (user decision 2026-10-15, revising the one above): Cortex is
  an OpenID Connect provider, and Systaro staff all have an account there. It stays small on purpose:
  - Linking only. An account's owner links it once under Mein Konto, after a normal login, to
    Cortex's `user_id` claim. No account is ever created or matched through Cortex, not by e-mail
    either, and customers cannot link (`kind = 'staff'` only).
  - `user_id`, not `sub`: in Cortex `sub` is the username, and a deleted account's username can go to
    a new one.
  - Cortex replaces the password, not the second factor. Vantage skips its own TOTP only when the ID
    token says the authenticator code was typed into Cortex (`amr` contains `otp`) within the last
    12 hours (`auth_time`). Password-only, trusted-browser, Microsoft and remember-me sessions in
    Cortex all end on Vantage's TOTP page, unless the browser is a trusted Vantage device (below).
  - Resetting or locking an account also stops its Cortex login; resetting removes the link.
  - No button on the login page (user decision 2026-10-26: it caused confusion, and customers see
    that page too). A linked account finds its sign-in link, `/login/cortex`, on Mein Konto.
  - Ops keeps local accounts only.
- Accounts are created by an admin → one-time invite link (72 h), sent by e-mail through the mail
  integration (or passed on by hand; a new invite replaces every open link) → the user sets a password
  and enrols TOTP → logged in. "Forgot password" = an admin issues a new invite; there is no self-service
  reset by email.
- The e-mail address is the login name and stays fixed once the account is used. Until then (no login,
  no password, no authenticator) an admin can correct a typo (`admin_correct_email`); the open invite
  went to the old address, so it stops working and the admin sends a new one.
- Sessions: random 32-byte token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` outside dev),
  stored as SHA-256. Idle timeout 8 h, absolute 7 days. Users see and revoke their sessions.
- Trusted devices (user decision 2026-10-24): „Diesem Gerät vertrauen“ on the code step puts a
  second random token in its own cookie (30 days, not extended by use) and its hash in
  `trusted_devices`. On that browser the next logins skip the code, never the password or Cortex.
  One cookie per browser: ticking the box for another account drops the previous token. At most 20
  live devices per account (the oldest go). Mein Konto lists them (rename, remove); a password
  change, an admin reset and locking the account forget all of them. Hub only; ops asks every time.
- Mein Konto also shows the last logins and failed attempts on the account's e-mail address, read
  from the audit log through `account_login_history`; login rows carry the method, the second factor
  and the browser.
- Login rate limits: 5 failures per email or 20 per IP per 15 minutes.
- CSRF: `hono/csrf` (Origin check) on every non-GET plus SameSite cookies.
- CSP: `default-src 'self'`, no inline scripts. Security headers via `hono/secure-headers`.

## 4. Modules

| Module | Process | What it does |
|---|---|---|
| core | hub | login, users, grants, registry, audit |
| uptime | worker + hub | HTTP / TCP / DNS / TLS-expiry / heartbeat / Uptime-Kuma-bridge monitors, uptime %, status per environment |
| alerts | worker + hub | events → incidents → notifications via email, Slack, Teams, webhook; personal email subscriptions |
| tests | hub | Playwright report ingestion, run history, failing tests, HTML reports on a separate origin |
| logs | hub | log search on the logs cluster, scoped by grant |
| apm | hub | transactions, latency, throughput, error rate from the APM cluster |
| errors | worker + hub | error groups from APM (`error.grouping_key`), new/regression detection → alerts |
| security | worker + hub | Dependency-Track projects and Wazuh agents mapped per environment (`environment_sources` kinds `dependency_track`, `wazuh`). The worker copies DT findings every 15 minutes and Wazuh's critical/high vulnerability states hourly into `security_findings` (Wazuh's per-severity counts into `security_agents`); first sync silent, then one notice per project/agent and run for new serious findings (Wazuh: critical only, kernels bring CVEs in batches). The "Sicherheit" tab and overview card read them under RLS at level 3; Wazuh alerts of the mapped agents are read live from the indexer |
| ansible | worker + hub | runs from Semaphore (which runs the playbooks until ops does): the worker reads the run list every minute and each finished run's PLAY RECAP into `ansible_runs` / `ansible_run_hosts` (counts per server and the failing task's name, no log). Environments list their servers (`environment_sources` kind `ansible`); a server's results are visible through such an environment at level 3, since failed patch runs and CVE mitigations say how to attack it. "Wartung" tab and overview card; admins see every run and the unmapped servers on `/admin/ansible` |
| runners | runner + worker + hub | a process inside a customer network (6.7): probes monitors assigned to it and reads servers over SSH, posts to `/api/runner/v1/…`; the worker applies the results like its own probes and ops' host checks; Verwaltung → Runner, servers in the environment settings, „Server“ tab of the environment (level 2, shown once it has servers) with one tile each for CPU, memory and every disk per server, showing the current value and the last 24 h, and a page per server with all checks and their history over 24 h, 7 or 30 days, read from the kept reports (no metrics store, see below); CPU usage is the difference of the agent's tick counters between two reports |
| agent | hub | personal API tokens (Mein Konto) for agents: REST `/api/v1/…` and an MCP server `/api/mcp`, read-only tools that run as the token's user under RLS (`docs/api.md`) |
| integrations | worker + hub | where the external systems are and how Vantage logs in (encrypted), configured on `/admin/integrations`, checked every 5 minutes; requests of any user load a connection through `integration_load()` without reading the table |
| ops | ops | Ansible templates (run now / cron / live log), GitLab pipeline schedules for test runs, host checks (agent push + central SSH), events to the hub |

Out of scope: a metrics TSDB (Prometheus/Grafana depth); netdata stays. Shipping logs (Logstash stays).

## 5. Events, incidents, notifications

Every module reports state changes as **events**:
`{source, environment_id?, subject_key, state: firing|resolved|notice, severity: critical|warning|info, title, body, link}`.

- `firing` opens an incident for `subject_key` if none is open (→ notify); repeated `firing` only
  updates `last_seen_at`. `resolved` closes the open incident (→ notify). `notice` notifies once, no
  incident (e.g. "new error group").
- **Channels** (admin): email list, Slack webhook, Teams workflow webhook, generic webhook (JSON +
  HMAC-SHA256 signature header). Secrets encrypted at rest (AES-256-GCM).
- **Routes** (admin): channel × scope (everything | organisation | project | environment | one
  monitor) × sources × minimum severity. Routes are meant for Systaro-internal channels; a route for
  one monitor is how a customer contact without a login gets exactly the alerts Kuma sent them.
- **Subscriptions** (every user, for themselves): email me about environment / project / everything I
  can see, from severity X. The worker re-checks `vantage_level` for the recipient at delivery time,
  so a revoked grant stops mail immediately. Setting up an invited account adds "everything I can
  see, from Warnung" (user decision 2026-10-16); a reset account keeps what the person chose.
- Subject lines and chat messages lead with the state: 🔴 problem (critical), 🟡 problem (warning),
  🟢 resolved, ℹ️ notice.
- Delivery by the worker with retries (1, 5, 15, 60 min, then failed).

| Source | Events |
|---|---|
| uptime | monitor down (critical) / up (resolved); TLS expires in < 14 d (warning) / < 3 d (critical) |
| tests | suite went red (warning) / green again (resolved) |
| errors | new error group (notice, warning); resolved group seen again (notice, warning) |
| ops | host check critical/warning/silent and recovery; Ansible scheduled run failed |

## 6. Module details

### 6.1 Uptime
Monitors belong to an environment. Interval ≥ 30 s, timeout, retries (consecutive failures before
"down") and the retry interval (default 20 s, never longer than the interval). Kinds:
- `http`: method (GET, HEAD, POST with a body), URL, expected status (e.g. `200-299,401`), optional
  body keyword, follow redirects, latency recorded. Optional: a JSON rule (`path op expected`, e.g.
  `dmts > 80000`; numbers compare as numbers, everything else as its JSON text), request headers and
  a query string appended to the URL, both stored encrypted (tokens, API keys) and never shown again,
  and the certificate of an https URL watched like a `tls` monitor (an incident of its own at
  < 14 days warning, < 3 days critical, while the monitor stays up).
- `tcp`: host + port. `dns`: name + record type, optional expected value.
- `tls`: host + port, days until expiry, thresholds 14 / 3 days.
- `heartbeat`: push — `GET|POST /api/v1/heartbeat/:token`; down when no beat within interval + grace.
  Replaces Kuma push monitors (e.g. the backup role's `backup_heartbeat_url`). Monitors taken over
  from Kuma keep Kuma's token and are reached at Kuma's path `/api/push/:token` (`msg` is shown with
  the state; `status=down` counts as no signal), so the jobs keep their URL (self-hosting.md, "Uptime Kuma").
- `kuma`: bridge to an existing Uptime Kuma v2 — reads its `/metrics`
  endpoint (API key) and mirrors one monitor's status. Lets environments show Kuma monitors before
  they are migrated.
- `health`: the application's own health page (Cortex `/api/health`, Spring `/actuator/health`,
  IETF health+json), optional Authorization header (encrypted). Up/down from the page's overall
  status; every check also stores the reported components and up to 40 numeric figures in
  `monitor_checks.details` (kept 14 days), shown with their hourly trend on the monitor page.

Checks are kept 30 days raw. Uptime % over 24 h / 7 d / 30 d is computed from them.

### 6.2 Tests
- Test suites belong to an environment. Admins create ingest tokens per suite (shown once, stored as
  SHA-256, revocable, optional expiry).
- `POST /api/v1/test-runs` (Bearer ingest token, multipart): `report` = Playwright JSON reporter
  output (required), `html` = zipped Playwright HTML report (optional), `commit`, `branch`,
  `pipeline_url`, `job_url` (optional).
- Stored: run summary + every test case (title path, project/browser, status, duration, first error
  line). Runs with failures emit an event when the suite flips red/green.
- Artifacts (HTML report) on local disk under `STORAGE_DIR` (*build decision*: no S3 in v1; one
  volume is enough at this size, and the storage interface is one file to swap). Kept 90 days, run
  statistics forever.
- **Scheduled runs** are triggered by **ops** (it holds the GitLab trigger tokens), the pipeline then
  uploads to the hub like any other run.

### 6.3 Errors
Worker polls the APM cluster every minute per environment that has an APM source: a terms
aggregation on `error.grouping_key` since the last poll, with the newest document per group. Groups
are upserted into `error_groups` (count, first/last seen, type, message, culprit). A new group, or a
resolved one seen again, emits a `notice` event. Users with diagnostics can mark groups resolved or
ignored. The detail view loads the newest occurrence (stack trace, transaction, trace id) live from
ES.

Error groups from the logs (2026-10-16, for applications that send nothing to APM, like
Cortex): a second worker loop reads the ERROR and FATAL entries of each logs source since the last
poll (up to 5000 per minute, paged by timestamp so nothing is counted twice) and groups them in the
worker, because Elasticsearch cannot compute the key: logger, exception class from the stack trace's
first line and its first 8 frames without line numbers; without a stack trace, the logger and the
message's first line with numbers, ids, quoted values and addresses taken out. They land in the same
`error_groups` (`source = 'logs'`, `grouping_key` `log:<sha1>`, `sample_entry_id` = the newest
entry), with the same triage and events; the detail page shows that entry. A logs source can switch
this off (`errorGroups: false`), for an application that reports its errors to APM as well. The poll
state (`log_error_poll_state`) is kept per source since #69812: a source added later starts with its
own silent backfill of the last day, without reading the others again. The groups stay per
environment, so the same error from two sources of one environment is one group.

Since 2026-10-23 (#69810) the variable parts also include JWTs, the word after "in session" / "for
session", values after `sessionId=`, `sid`, `token` that contain a digit, and Java identity hashes
(`RequestData@5c4a5d63`). R2's STOMP handler had put a session id and an expiring token into every
message, which made one error 47,000 groups and a mail for each. v0.1.24 merged the existing groups
once at worker start, keeping their triage (48,322 groups on production; the one-off code went out
again in v0.1.25).

At most 10 error events per environment and hour (APM and logs together). What would go past it
becomes one summary event, and after a summary the environment stays quiet for the rest of the hour;
the errors page lists every group regardless.

Ignore rules (#69811, `error_ignore_rules`, `ignore-rules.ts`, `rules.tsx`): a regular expression,
case-insensitive, on an error's title ("Type: message") or its place, for one environment or every
environment of its project. Both pollers drop matching groups before they are stored, so they make
no group and no event; the rule counts the occurrences it dropped. Errors that grouping cannot catch
because the variable part is free text (a job title, a customer name) go here. Admins create and
delete them (on the errors page, or "Ähnliche ignorieren" on a group with a pattern built from its
message shape); everyone with diagnostics sees them, because they decide what is missing from the
list. Creating one can set the matching open groups to ignored. A rule is the admin's code running
in the worker: the pattern is at most 300 characters, nested repetition like `(a+)+` is refused,
and only the first 2000 characters of a text are matched.

### 6.4 Logs and APM
`environment_sources` rows (admin):
- `logs`: an index pattern on the logs cluster (`logstash-portal.bergbau.prod-default-*`), validated
  (must start with an allowed prefix, no commas, no leading wildcard, no `_all`), plus an optional
  exact field filter for shared indices. The admin form previews which index families the pattern
  matches before saving.
- `apm`: `service.name` and `service.environment` on the APM cluster.

Logs is the only kind with several rows per environment (#69812, migration 028): an application of
several services writes one index family per service (a webshop: `shop`, `shop-search-service`,
`shop-translation-service`, …). Each logs source has a name, unique in its environment regardless of
case (default: the pattern without prefix and wildcard), at most 10 per environment; every other kind
stays at one row (partial unique index). The Logs tab shows all sources together or one ("Quelle"
picker with the entry count per source in the current view, and a "Quelle" column); error groups,
the overview card, the entry dialog and the agent tools read all of them.

Several sources are one request: every pattern goes into the URL path (comma-joined, each validated
on its own), and the query gets one named `should` clause per source, a `wildcard` on `_index` with
that source's pattern plus its own field filter. Each source thus stays inside its own indices with
its own filter, and `matched_queries` on a hit names the source it came from. Limit: a pattern that
names an alias or data stream does not match the `_index` wildcard (it holds the backing index), so
such a source shows nothing in the combined view. It fails closed; alone, it works as before. With
only one source the request is the same as before.

The hub reads the source rows under RLS (so level 2 is required), builds the ES request itself and
puts the index in the URL path; user input only reaches `simple_query_string`, level and time
filters. Time ranges are capped at 30 days, page size at 200.

Logs view: time range, level filter, text search, newest first with "older", stack traces
expandable, `trace.id` links to the APM trace when an APM source exists, live tail (poll every 5 s).
APM view: throughput, p95 latency and failure rate over time, transaction table.

### 6.5 Test report origin
Playwright HTML reports contain scripts and come from CI uploads, so they must not run on the hub's
origin (they could act with the viewer's session). The hub links to
`REPORTS_URL/r/:runId/:expires/:signature/index.html`; requests on the reports host are only served
for a valid HMAC signature (15 min validity, extended per file request within the same run) and never
see the session cookie. Locally: hub on `http://localhost:7100`, reports on `http://127.0.0.1:7100`.

### 6.6 Ops
- **Accounts**: local staff accounts with password + TOTP (same shared code as the hub, separate
  table, separate database). Roles: `admin`, `operator` (run templates), `viewer`.
- **Ansible**: the project is a checkout of `ansible-configs` at `ANSIBLE_PROJECT_DIR` (optionally
  `git pull` before each run). Templates = playbook + inventory + limit + extra vars + check mode,
  run now or on a cron schedule, one run per template at a time, live log over SSE, cancel, history
  (logs 90 days). Failed scheduled runs emit events.
- **Pipeline schedules**: GitLab project + ref + trigger token (encrypted) + variables + cron →
  `POST /api/v4/projects/:id/trigger/pipeline`. Records pipeline id and URL. The pipeline uploads
  results to the hub's test ingest.
- **Host checks**: hosts are `agent` (push from `agent/vantage-agent.sh` via cron, Bearer host
  token) or `central` (ops runs the same script over SSH on a schedule). Checks: disk usage per
  filesystem, memory, load, systemd failed units, docker containers not running, optional ES flood
  stage. Thresholds default + per host. A host that misses 3 intervals is `silent`. A stalled
  central sweep is itself reported (otherwise every central host looks healthy on stale data).
  State changes → events to the hub, optionally tagged with an environment path (`org/project/env`).

### 6.7 Runner (stage 1: read-only, decided 2026-10-21)

Vantage reaches only what is reachable from the internet. Services and servers behind a customer
VPN or in an internal network are invisible to it. A **runner** is a small process Systaro installs
inside such a network; it checks what it is told to check and reports back. Stage 1 is read-only.

- **Direction**: the runner only connects outward, over HTTPS to the hub (`/api/runner/v1/…`).
  Nothing listens on it and the hub never calls it, so the customer's firewall needs one outbound
  rule (443 to the hub) and no inbound one.
- **What it does**: uptime probes for monitors assigned to it (kinds `http`, `tcp`, `dns`, `tls`,
  `health`, the same probe code as the worker) and server checks: it runs `agent/vantage-agent.sh
  --print` over SSH on the servers assigned to it (disk per filesystem, memory, load, failed systemd
  units, stopped docker containers, optional ES flood stage). It executes nothing it receives: the
  config names targets of these fixed kinds, never commands or scripts.
- **Identity**: a runner belongs to one organisation. An admin creates it (Verwaltung → Runner),
  gets the token `vrn_…` once (stored as SHA-256, revocable, one per runner). Monitors and servers
  of that organisation's environments can be assigned to it, no others.
- **System runner** (decided 2026-10-25): a runner without organisation ("Systaro, für alle
  Kunden") is Systaro's own and runs in our network. It may serve monitors and servers of every
  organisation, so a server lands in the environment it serves (web1.nordwind.example under Nordwind /
  Webshop / Production) and not in a catch-all. The organisation is a label, not a wall (section 1, item 2);
  the per-organisation rule stays for runners at customers, which must never receive another
  customer's monitor secrets. The first one runs next to the hub and reads the servers Systaro
  operates; its key may only run the agent there (self-hosting.md, "System runner").
- **API** (Bearer only, never cookies): `GET /api/runner/v1/config` returns its monitors (with the
  secrets of http headers / health auth decrypted, so they leave Vantage only to the runner, over
  TLS) and its servers; `POST /api/runner/v1/results` takes probe results and server reports (strict
  validation, size limit). Both go through SECURITY DEFINER functions that check the token hash and,
  for every result, that the monitor or server belongs to this runner; results land in queue tables.
  The worker applies them with the same code as its own probes (uptime state machine, retries) and
  the same threshold evaluation as ops, so events, incidents and routing are unchanged.
- **SSH key**: the runner creates its own key on first start and keeps it on its volume; the hub
  only learns the public key (shown on the runner page, to be added to the servers). Vantage never
  holds a key to a customer server, so a compromised hub still cannot log in anywhere.
- **Silence**: a runner without a request for 3 minutes raises `runner:<id>:silent` (critical,
  system-wide, staff only); its monitors and servers keep their last state and are shown as stale.
  Results it buffered while cut off are delivered afterwards. A server without a report for three
  intervals while its runner is alive raises `server:<id>:silent` (warning: a server that is really
  down shows up as critical through its uptime monitor; silence usually means SSH broke).
- **Server checks live in the hub**, not in ops: they only read, ops is not deployed, and the runner
  posts to the hub anyway. Report validation and thresholds are shared code (`src/shared/hosts/`);
  defaults as in ops (disk 85/95 %, memory 90/97 %, load per core 2/4), overridable per server.
  Server data is environment data at level 2 (diagnostics), like logs and errors.
- **Not in stage 1**: running Ansible or anything else that changes a server. That would make the
  runner a remote control into customer networks and belongs to ops, with an allowlist of templates
  on the runner itself; compare with Semaphore Pro project runners before building it.

## 7. Retention

| Data | Kept |
|---|---|
| monitor checks | 30 days |
| events, closed incidents, notifications | 180 days |
| test artifacts (HTML reports) | 90 days; runs and cases forever |
| audit log | 2 years |
| sessions, trusted devices | 30 days after they expire or end |
| ops run logs | 90 days |
| host check results | 30 days |
| runner server reports | 30 days; probe results of runners like monitor checks |

## 8. Known gaps and risks

- The index pattern is only as good an isolation key as the log pipeline behind it: if senders choose
  their index themselves, one application can write into another's. Vantage cannot check that.
- APM data streams are shared across services; isolation by `service.name` is enforced by Vantage,
  not by ES.
- Applications do not name their environment consistently in the index, so mapping an environment to
  its pattern is a manual admin step per environment.

### Security review 2026-10-12

An independent review probed RLS on every table (throwaway DB and the live dev hub) and found no way
for one customer to read another customer's data. Fixed as a result: error events now need diagnostics
level (migration 010); open redirect via `next`; `__Host-` cookies over HTTPS; client IP from the
right end of `X-Forwarded-For`; TOTP replay; live-tail cursor clamped to the chosen range; revived
sessions blocked (migration 011); ops host → customer environment mapping is admin-only; links into
ops are shown and mailed only to admins; Slack/Teams text escaped; upload quota and disk guard.

Accepted for now, documented on purpose:
- The idle timeout counts every request, including htmx auto-refresh, so an open dashboard stays
  logged in up to the 7-day absolute limit.
- A signed report link stays usable up to 2 h after it was issued (sliding 15-minute window), even if
  the grant is revoked in between.
- TOTP replay protection, the report-link window and the upload quota are held in memory per hub
  process; that is complete only with one hub replica.
- The hub role can call `vantage_level()` and `auth_user_for_totp()` for any user id. Reachable only
  from inside the hub process.
- A new heartbeat URL is passed once through the 60 s flash cookie (httpOnly, `__Host-`, Secure in
  production).
- The reports origin must sit on its own registrable domain; per-run subdomains are the next step
  (see `docs/self-hosting.md`).
