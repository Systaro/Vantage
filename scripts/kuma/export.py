"""
Uptime Kuma v2 (SQLite) → JSON on stdout, for scripts/kuma-import.ts. Runs on the Kuma host and
reads the database read-only. The output holds secrets (push tokens, request headers, API keys in
URLs): pipe it straight into the import, never into a file or a terminal.

  ssh <kuma host> 'sudo python3 - /data/monitoring/uptime-kuma/kuma.db | sudo docker compose -f /data/vantage/compose.yml exec -T hub bun run scripts/kuma-import.ts' < scripts/kuma/export.py
"""
import json
import sqlite3
import sys

db = sys.argv[1] if len(sys.argv) > 1 else "/data/monitoring/uptime-kuma/kuma.db"
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
con.row_factory = sqlite3.Row

notifications = {}
for r in con.execute("select mn.monitor_id, n.name from monitor_notification mn join notification n on n.id = mn.notification_id"):
    notifications.setdefault(r["monitor_id"], []).append(r["name"])

FIELDS = ["id", "parent", "name", "type", "active", "url", "method", "body", "headers", "accepted_statuscodes_json", "keyword",
          "invert_keyword", "json_path", "json_path_operator", "expected_value", "interval", "maxretries", "retry_interval", "timeout",
          "expiry_notification", "max_redirects", "ignore_tls", "upside_down", "push_token", "auth_method", "basic_auth_user"]
monitors = []
for row in con.execute("select * from monitor order by id"):
    m = {k: row[k] for k in FIELDS if k in row.keys()}
    m["has_basic_auth"] = bool(m.pop("basic_auth_user", None))
    m["notifications"] = notifications.get(m["id"], [])
    monitors.append(m)
json.dump({"monitors": monitors}, sys.stdout, ensure_ascii=False)
