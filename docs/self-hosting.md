# Running Vantage in production

A production installation is one docker compose stack: Postgres, the hub, the worker and optionally
a system runner, behind a reverse proxy that terminates TLS. Ops (Ansible, pipeline schedules, host
checks) is deployed on its own, see [ops.md](ops.md#deployment) and [Ops](#ops) below.

## Images

| Image | Built from | Runs |
|---|---|---|
| hub | `Dockerfile` | hub `bun run src/hub/index.tsx` (port 7100), worker `bun run src/hub/worker.ts`, migrations `bun run src/shared/migrate-cli.ts hub` |
| runner | `Dockerfile.runner` | `bun run src/runner/index.ts`, inside a network the hub cannot reach ([Runners](#runners)) |
| ops | `Dockerfile.ops` | `bun run src/ops/index.tsx` (port 7101), internal only |

## The host

```
/data/vantage/
├─ compose.yml, postgres-init.sh   from deploy/, overwritten by every release
├─ .env                            written by the release: VANTAGE_IMAGE, VANTAGE_RUNNER_IMAGE,
│                                  VANTAGE_RELEASE, COMPOSE_FILE (nothing secret)
├─ secrets/                        host-only, root 600, created once (below); never in git
│  ├─ postgres.env                 POSTGRES_PASSWORD + VANTAGE_{OWNER,HUB,WORKER}_PASSWORD
│  ├─ app.env                      HUB_SECRET, URLs, proxy settings
│  ├─ db-{owner,hub,worker}.env    one database URL each; migrate / hub / worker get only theirs
│  └─ runner.env                   optional: the system runner's token, switches it on
├─ postgres/                       database files
└─ storage/                        uploaded test reports, owned by uid 1000 (the image's bun user)
```

- `deploy/compose.yml` puts the hub on the network of an existing
  [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) stack with its Let's Encrypt companion.
  The hub's `VIRTUAL_HOST`, `LETSENCRYPT_HOST` and `LETSENCRYPT_EMAIL` name the hub's host and the
  [reports origin](#reports-origin). In the published repository they come from `VANTAGE_HOSTS`
  (both host names, comma-separated) and `LETSENCRYPT_EMAIL`; put those into `.env` next to the
  release variables. The proxy has to pass the original Host header, which the hub needs to
  recognise the reports host.
- With exactly one proxy in front of the hub: `TRUST_PROXY=true`, `TRUST_PROXY_HOPS=1`.
- Run one hub replica. TOTP replay protection, the report-link window and the upload quota are held
  in memory per hub process ([design.md](design.md) section 8).
- Never edit `compose.yml` on the host; the next release overwrites it.

### Secrets (once)

`deploy/init-host.sh` creates the directories and every secret with fresh random values, and refuses
to run if `secrets/` already exists, so it can never overwrite live passwords:

```sh
ssh <host> 'sudo HUB_PUBLIC_URL=https://vantage.example.com REPORTS_URL=https://reports.example.net bash -s' < deploy/init-host.sh
```

The role passwords only take effect on the very first Postgres start (`postgres-init.sh` runs on an
empty data directory). Changing them later means `ALTER ROLE` in the database as well.

### First admin

```sh
sudo docker compose run --rm migrate bun run scripts/create-admin.ts <email> "<Name>"
```

prints a one-time invite link (72 h). Further users are created in the UI.

## Releasing a version

1. Copy `deploy/compose.yml` and `deploy/postgres-init.sh` to `/data/vantage`.
2. Pull the new hub image (and the runner image if `secrets/runner.env` exists) and export them as
   `VANTAGE_IMAGE` and `VANTAGE_RUNNER_IMAGE`; until `.env` is written, compose needs both from the
   environment for every command.
3. `docker compose up -d --wait postgres`, then `docker compose run --rm migrate`.
4. Only then write `.env` (`VANTAGE_IMAGE`, `VANTAGE_RUNNER_IMAGE`, `VANTAGE_RELEASE`, `COMPOSE_FILE`)
   and run `docker compose up -d --remove-orphans` (with `--profile runner` when `secrets/runner.env`
   exists). A failed migration therefore leaves the old release running.
5. Check that hub and worker run the new image, and that `/healthz` answers inside the host and
   through the proxy (DNS, proxy and certificate included).

Migrations only go forward, so a rollback across a migration needs care.

## Reports origin

Uploaded Playwright HTML reports run scripts, so they are served from a separate origin
(`REPORTS_URL`) on a **different registrable domain** than the hub. On a sibling of the hub's domain
those scripts would be same-site with the hub and could set cookies for the parent domain that reach
every application under it. Keep that domain free of other applications for the same reason. All
reports still share this one origin, so one report could read another report's
localStorage/IndexedDB; a per-run subdomain (wildcard certificate) would close that and is the next
step. Without `REPORTS_URL`, uploaded reports are not reachable from outside.

Unverified: the Playwright trace viewer under the reports CSP (`frame-ancestors 'none'`). If it
breaks, `frame-ancestors 'self'` is the fallback.

## Integrations

Where each external system is and how Vantage logs in is configured in Vantage itself:
**Verwaltung → Integrationen** (`/admin/integrations`). Credentials are stored encrypted with
`HUB_SECRET` and shown only as "set"; every card has a "Testen" button, and the worker re-checks all
of them every 5 minutes. What the page cannot do is the side of the other system. Give Vantage read
access only, and only to what it shows:

- **Mail**: any SMTP server, as an `smtp://` / `smtps://` URL. A relay without STARTTLS should use
  CRAM-MD5, which at least keeps the password off the wire.
- **Logs** (Elasticsearch with `logstash-*` indices): without Elasticsearch security, put an nginx
  block in front that admits only the hub's address, with a basic-auth user of its own, and only
  `POST /logstash-*/_search` and `GET /_cat/indices/logstash-*`; everything else 404. With security,
  a role with `read` on `logstash-*`.
- **APM / errors** (Elasticsearch with security): an API key with only `read` on `apm-*-error-*` and
  `apm-*-transaction-*`. If the cluster's certificate comes from its own CA, the integration holds
  that CA so TLS stays verified. To rotate: a new key with the same role descriptor, the new key on
  the Integrationen page, then invalidate the old one by id.
- **Wazuh**: the indexer is read through an nginx block that admits only the hub's address and only
  `POST /<index>/_search` on `wazuh-states-vulnerabilities-*` and `wazuh-alerts-4.x-*`, with an
  indexer user whose only role has `read` on those two patterns.
- **Dependency-Track**: a team with the permissions VIEW_PORTFOLIO and VIEW_VULNERABILITY and its API
  key; the address is the API server's, not the UI's. Each environment then gets its projects under
  Einstellungen → Datenquellen; the findings are only visible with the grant level "Sicherheit".
- **Ansible (Semaphore)**: a Semaphore user that is not admin and has the role **Guest** in the
  project, so it can read runs and their output but start nothing, and its API token. Vantage stores
  only what each server reported in the PLAY RECAP and the name of the task it failed in, never the
  log. `scripts/set-integration.ts` saves the token without it passing a terminal:

  ```sh
  ssh <semaphore host> 'cat /root/.vantage-semaphore-token' | ssh <vantage host> \
    'sudo docker compose -f /data/vantage/compose.yml exec -T hub bun run scripts/set-integration.ts \
     semaphore <admin e-mail> url=https://semaphore.example.com project_id=1'
  ```

  Each environment then lists its servers (names as in the inventory) under Einstellungen →
  Datenquellen → Ansible; Verwaltung → Ansible-Läufe shows the servers no environment lists yet.
- **Cortex login** (staff sign-in through Cortex, design 3.3): Cortex knows Vantage as an SSO client,
  which a Cortex admin creates through the API with a personal API token (`cx_…`):

  ```sh
  curl -X POST https://cortex.example.com/api/sso-client/ \
    -H "Authorization: Bearer cx_…" -H "Content-Type: application/json" \
    -d '{"name": "Vantage", "redirectUris": "https://vantage.example.com/login/cortex/callback", "scopes": "openid,profile"}'
  ```

  The answer holds `clientId` (`sso_…`) and, only this once, `generatedClientSecret`. "Testen"
  fetches the discovery and the keys and tries a code exchange with a code that cannot exist: Cortex
  answers a known client with `invalid_grant`, a wrong secret with `invalid_client`. Cortex has to
  send `user_id`, `amr` and `auth_time` in the ID token and needs a fixed signing key: without one it
  makes a new key on every restart, and every token issued before the restart is invalid. New
  secret: `POST /api/sso-client/action/regenerateSecret` with `{"id": <id>}`.

## Uptime Kuma

Vantage can take over the monitors of an Uptime Kuma v2 (design 6.1). `scripts/kuma/mapping.json`
says which Kuma monitor goes into which environment under which name, and which people and mail
channels stand for Kuma's notifications; `scripts/kuma/mapping.example.json` shows the format. The
import reads the mapping from the hub image, so build the image with your `mapping.json`.

The export holds secrets (push tokens, request headers, API keys in URLs), so it goes straight from
Kuma's SQLite database into the import. With Kuma and Vantage on the same host:

```sh
ssh <host> 'sudo python3 - /path/to/kuma.db | sudo docker compose -f /data/vantage/compose.yml exec -T hub bun run scripts/kuma-import.ts' < scripts/kuma/export.py
# the same with "… scripts/kuma-import.ts --apply" writes it
```

Without `--apply` the import runs and is rolled back, and prints the plan. A second run skips what is
there (`config.kumaId`). Monitors taken over keep Kuma's push token, and Vantage answers Kuma's path
`/api/push/<token>`, so the jobs that push keep their URL.

**Parallel run.** Kuma keeps alerting while Vantage checks everything too and gets a copy of every
push, through an nginx `mirror` in the proxy's file for the Kuma host (with nginx-proxy:
`/etc/nginx/vhost.d/<kuma host>`):

```nginx
# Vantage gets a copy of every Kuma push while both run.
location /api/push/ {
    mirror /__vantage_push;
    proxy_pass http://uptime.example.com;
}
location = /__vantage_push {
    internal;
    proxy_pass http://vantage.example.com$request_uri;
}
```

With nginx-proxy, the Let's Encrypt companion writes its `/.well-known/acme-challenge/` block into
this file itself. Do not also `include /etc/nginx/vhost.d/default` (it holds the same block): the
duplicate location fails `nginx -t`, nginx-proxy can then no longer reload and keeps routing to old
container addresses. After every edit: `nginx -t`, then `nginx -s reload`. Mail channels for people
outside your team can be created deactivated in the mapping, so they get no second mail during the
parallel run.

**Switch.** 1. In Kuma, take the notifications off (or pause all monitors), otherwise Kuma reports
every push monitor down once the pushes stop reaching it. 2. Point the push path at Vantage
(`location /api/push/ { proxy_pass http://vantage.example.com; }`) and drop the mirror block;
reload nginx. 3. Activate the deactivated mail channels under Verwaltung → Kanäle & Regeln. 4. Stop
Kuma; keep `kuma.db` until nobody misses anything.

## Runners

A runner (design 6.7) checks from inside a customer network what the hub cannot reach from the
internet: internal services (monitors of kind http, tcp, dns, tls, health) and servers (disk, memory,
load, systemd, docker, via the host agent over SSH). It only connects out.

1. Verwaltung → Runner → Runner anlegen (name, customer). The dialog shows `runner.env` with the
   token (once) and the `docker run` line. New token: same page; the old one stops at once.
2. On a machine with Docker inside the customer network, run the line from the dialog. Its image is
   the `RUNNER_IMAGE` in `src/hub/modules/runners/routes.tsx`; build it from `Dockerfile.runner` and
   push it to a registry the runner host can pull from.
3. The runner page then shows "verbunden", its version and its public SSH key. For every server it
   should read: a user without root (group `docker` if containers are to be checked) whose
   `authorized_keys` holds that key, ideally restricted like the [system runner's](#system-runner).
   The first connection trusts the host key and remembers it (`known_hosts` on the runner's volume).
4. In the environment's settings: Server → Server anlegen (SSH target `user@host`, runner, interval,
   thresholds), and for monitors "Geprüft von" → the runner.

What the customer's IT approves: one container, outbound HTTPS (443) from it to the hub, nothing
inbound; network access from it to the services and servers to check; an SSH user with the runner's
public key on those servers. The runner executes nothing it receives: the hub names targets of fixed
kinds, never commands. Monitor secrets (http headers, health auth) go to the runner that probes them,
over TLS; the runner's SSH key never leaves it.

A runner without a request for 3 minutes raises "Runner … meldet sich nicht" (critical, staff only);
its monitors keep their last state and show "letzte Prüfung vor …". Results it buffered while cut
off (up to 20,000) arrive afterwards. Test it locally: `docker build -f Dockerfile.runner -t
vantage-runner .`, then run it with `VANTAGE_URL=http://host.docker.internal:7100` against the dev hub.

## System runner

A runner without organisation ("Systaro, für alle Kunden") runs next to the hub as the compose
service `runner` and reads the servers the operator of the hub runs itself.

1. Verwaltung → Runner → Runner anlegen, Kunde "Systaro, für alle Kunden". Put the `runner.env` the
   dialog shows on the host as `/data/vantage/secrets/runner.env` (mode 600). The next release starts
   the runner; it only runs while that file exists.
2. The runner page shows its public key once it has connected. Each server gets a user `vantage` (no
   password, no sudo, group `docker` where Docker runs), the agent at a fixed path such as
   `/usr/local/lib/vantage-agent/vantage-agent`, and in a root-owned home an `authorized_keys` with
   `restrict,from="<hub address>",command="/usr/local/lib/vantage-agent/vantage-agent --print"`.
   Group `docker` is as good as root for anyone with a shell; the forced command is what keeps this
   key read-only.
3. Per server, in the settings of the environment it serves: Server anlegen, SSH target
   `vantage@<host>`, the system runner.

The forced command ignores the script the runner sends, so these hosts run their own copy of
`agent/vantage-agent.sh`. After a change to it, roll the new copy out to them.

## Ops

Ops is internal: it holds root-equivalent power over the fleet. [ops.md](ops.md#deployment) has the
configuration; in addition:

- Image `Dockerfile.ops` (Bun + ansible + git + openssh-client + curl). Agent hosts need to reach
  just `/api/ingest/v1/report` and `/agent/vantage-agent.sh`; everything else stays behind the VPN or
  an IP allowlist.
- Give the container `stop_grace_period: 45s`: ops waits 30 s for running playbooks, then SIGTERM,
  then SIGKILL after 10 s.
- The ops user's `~/.ssh` (`/home/bun/.ssh` in the image) needs the fleet keys and a filled
  `known_hosts`: the central sweep runs SSH with `BatchMode=yes`, which refuses unknown host keys.
- `OPS_DATA_DIR` (run logs) and the Ansible project (`ANSIBLE_PROJECT_DIR`) go on volumes.
- In the hub, create a machine token (Verwaltung → Maschinen-Tokens) and set it as
  `OPS_HUB_EVENT_TOKEN` in ops. Until then ops keeps events in its outbox and shows a warning.
