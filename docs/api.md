# Vantage API and MCP server for agents

Agents and scripts read Vantage with a **personal API token**. A token acts as the person who
created it: the same environments, the same access level (overview, diagnostics, security), nothing
more. Every request runs under that user's row-level security, exactly like the UI, and everything
is read-only.

## Tokens

Mein Konto → API-Zugänge für Agenten → Token anlegen. The token (`vpat_…`) is shown once. Valid for
30 days, 90 days (default), a year or without end; revoke it on the same page. Tokens stop working
when the account is disabled, and an admin's "Zugang zurücksetzen" revokes them too. Only the
SHA-256 of a token is stored.

Requests send it as `Authorization: Bearer vpat_…`. The API never reads the session cookie.

## MCP

Streamable HTTP, stateless, JSON responses: `POST https://vantage.example.com/api/mcp`.

```sh
claude mcp add --transport http vantage https://vantage.example.com/api/mcp \
  --header "Authorization: Bearer vpat_…"
```

Supported protocol versions: 2025-06-18, 2025-03-26, 2024-11-05. Methods: `initialize`, `ping`,
`tools/list`, `tools/call`; notifications are accepted with 202. Requests carrying an `Origin` header
other than Vantage's own are refused (DNS rebinding).

## Tools

| Tool | Access | What it returns |
|---|---|---|
| `list_environments` | any | every environment you see: id, organisation, project, kind, your access, monitors down, open incidents |
| `get_environment_status` | overview | monitors with status and 24 h uptime (health-page monitors with the components and metrics of their latest reading, `via_runner` for monitors a runner probes from inside the customer network), open incidents, latest run per test suite; plus open error groups and the servers a runner reads with their checks and current CPU usage (diagnostics), and open vulnerabilities by severity (security) |
| `get_server_history` | diagnostics | one server's readings over time as its page shows them: CPU usage (null while its agent sends no CPU time, `has_cpu`), load per core, memory and each filesystem in percent, per bucket; `environment_id`, `server` (a name from `get_environment_status`), `range` (24h, 7d, 30d) |
| `list_incidents` | overview | incidents, newest first; `environment_id`, `include_resolved`, `limit` (≤ 200) |
| `list_test_runs` | overview | recent test runs; `environment_id`, `limit` (≤ 100) |
| `search_logs` | diagnostics | log entries with their `id` and `source`, newest first, from all log sources of the environment or from the one `source` names; the result's `sources` lists the names; `environment_id`, `query` (simple query string), `levels`, `range` (15m, 1h, 24h, 7d), `source`, `limit` (≤ 100) |
| `get_log_entry` | diagnostics | one log entry with every field of the document (host, application, thread, MDC values) and its `source`, as the logs page's detail dialog shows it; `environment_id`, `entry_id` (an `id` from `search_logs`) |
| `list_errors` | diagnostics | error groups from APM (`source: apm`) and from ERROR log entries (`source: logs`, with `sample_entry_id` for `get_log_entry`); `environment_id`, `status` (open, resolved, ignored), `limit` |
| `list_error_ignore_rules` | diagnostics | the ignore rules that drop matching errors before they become a group: `pattern` (regex on title or place), `scope` (environment or project), `note`, `matched` (occurrences dropped), `last_matched_at`; `environment_id` |
| `list_vulnerabilities` | security | counts by severity, the Dependency-Track projects (age of the last SBOM) and Wazuh servers behind them, and the findings; `environment_id`, `severity`, `limit` (≤ 500) |
| `list_ansible_runs` | security | Ansible runs from Semaphore on the environment's servers, newest first, with each of those servers' PLAY RECAP counts and the task it failed in, plus a 30-day summary per server; `environment_id`, `failed_only`, `limit` (≤ 200) |
| `get_security_alerts` | security | Wazuh alerts of the environment's servers, last 24 h: totals by rule level, top rules, every alert from level 10, `stale` when the newest is older than 6 h |

Without the access a tool needs, it answers "Environment not found, or your access does not
include …", the same whether the environment exists or not.

## REST

The same tools as plain GET requests, answers as `{"data": …}` or `{"error": "…"}`:

| Request | Tool |
|---|---|
| `GET /api/v1/environments` | `list_environments` |
| `GET /api/v1/environments/:id` | `get_environment_status` |
| `GET /api/v1/environments/:id/logs?query=&levels=ERROR,WARN&range=24h&source=&limit=50` | `search_logs` |
| `GET /api/v1/environments/:id/logs/:entryId` | `get_log_entry` |
| `GET /api/v1/environments/:id/errors?status=open` | `list_errors` |
| `GET /api/v1/environments/:id/error-ignore-rules` | `list_error_ignore_rules` |
| `GET /api/v1/environments/:id/vulnerabilities?severity=critical` | `list_vulnerabilities` |
| `GET /api/v1/environments/:id/security-alerts` | `get_security_alerts` |
| `GET /api/v1/environments/:id/ansible-runs?failed_only=true` | `list_ansible_runs` |
| `GET /api/v1/environments/:id/servers/:server/history?range=7d` | `get_server_history` |
| `GET /api/v1/environments/:id/test-runs` | `list_test_runs` |
| `GET /api/v1/incidents?environment_id=&include_resolved=true` | `list_incidents` |

Status codes: 401 without a valid token, 404 when the environment is not visible at the needed
level, 400 for invalid arguments.

## Code

`src/hub/modules/agent/`: `tools.ts` (the tools, shared by REST and MCP), `routes.ts` (token
middleware, REST, MCP), `tokens.tsx` (Mein Konto). Tests: `test/agent-api.test.ts`.
