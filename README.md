# Vantage

Systaro's observability and operations suite. Customers and Systaro staff log in and see uptime,
test runs, incidents, errors, logs, APM, server health and security findings for the environments
they were granted. Admins get notified when something breaks. Internally, the ops service runs
Ansible, scheduled test pipelines and host checks.

- **Design and decisions:** [`docs/design.md`](docs/design.md)
- **Running it in production:** [`docs/self-hosting.md`](docs/self-hosting.md)
- **Uploading test runs from CI:** [`docs/tests-ingest.md`](docs/tests-ingest.md)
- **API and MCP server for agents:** [`docs/api.md`](docs/api.md)
- **Ops service, host agent, events:** [`docs/ops.md`](docs/ops.md)

## What it does

- **Grants, not tenants.** Admins create every account and every grant. A grant opens a project (all
  of its environments or named ones) at one of three levels: overview (uptime, test runs,
  incidents), diagnostics (plus errors, logs, APM) and security (plus vulnerabilities and Ansible
  runs). Postgres row-level security enforces it on every read.
- **Uptime**: http, tcp, dns, tls, health-page and heartbeat monitors, incidents and alerting by mail,
  Slack, Teams or webhook. Can take over the monitors of an Uptime Kuma, including its push URLs.
- **Test runs**: CI uploads Playwright results; reports are served from a separate origin.
- **Errors, logs, APM**: error groups from Elasticsearch APM and from ERROR log entries, log search and
  live tail, transaction metrics, all scoped by grant.
- **Security**: findings from Dependency-Track and Wazuh per environment.
- **Servers**: disk, memory, load, systemd and docker checks over SSH by a runner, also from inside
  networks the hub cannot reach (the runner only connects out).
- **Agents**: personal API tokens for a read-only REST API and an MCP server that see exactly what
  the token's user sees.

The user interface is German and carries Systaro's name.

## Quick start

```sh
docker compose -f docker/compose.dev.yml up -d   # Postgres 5460, Elasticsearch 5461, Mailpit 5462/5463
cp .env.example .env
bun install
bun run migrate                                  # hub + ops databases
bun run seed                                     # fictional demo world (dev only)
bun run dev                                      # hub :7100, worker, ops :7101
```

Seeded logins (dev only): `admin@vantage.local`, `alice@nordwind.example`, `bob@bergbau.example`,
`carol@agency.example`, all with the password `vantage-dev-password` and the TOTP secret
`JBSWY3DPEHPK3PXP`. Mails land in Mailpit at http://127.0.0.1:5463.

For a real installation, create the first admin with
`bun run scripts/create-admin.ts you@example.com "Name"` and open the printed invite link.

## Processes

| Process | Command | Port | Database role |
|---|---|---|---|
| hub (UI + API, customer-facing) | `bun run hub` | 7100 | `vantage_hub` (row-level security) |
| worker (probes, alerts, error polling, retention) | `bun run worker` | – | `vantage_worker` (BYPASSRLS) |
| ops (internal: Ansible, pipeline schedules, host checks) | `bun run ops` | 7101 | `vantage_ops` (own database) |
| runner (optional, inside a customer network) | `bun run src/runner/index.ts` | – | none, talks to the hub over HTTPS |

## Tests

```sh
bun test            # needs the dev Postgres; every test file gets its own throwaway database
bun run typecheck
```

## Contributing, security, license

This repository is published from Systaro's internal repository; see
[CONTRIBUTING.md](CONTRIBUTING.md) for how issues and pull requests are handled. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Vantage is **source-available**, not open source in the OSI sense:
[Business Source License 1.1](LICENSE). Free to use and modify, including in production;
**offering it to third parties as a competing hosted service requires a separate agreement**. Each
version converts to Apache 2.0 four years after its publication. For commercial licensing, contact
`licensing@systaro.de`.
