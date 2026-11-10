#!/bin/bash
# One-time setup of /data/vantage: directories and secrets with fresh random values. Run as root,
#   ssh <host> 'sudo HUB_PUBLIC_URL=https://vantage.example.com REPORTS_URL=https://reports.example.net bash -s' < deploy/init-host.sh
# HUB_PUBLIC_URL is required. Without REPORTS_URL there is no reports origin; ELASTICSEARCH=1 adds the
# data directory of an Elasticsearch that a second compose file adds to the stack.
# Refuses to touch an existing secrets/ directory, so it can never overwrite live passwords.
set -euo pipefail
umask 077
base=/data/vantage
hub_url=${HUB_PUBLIC_URL:?HUB_PUBLIC_URL is missing, e.g. https://vantage.example.com}
reports_url=${REPORTS_URL:-}
if [ -e "$base/secrets" ]; then
  echo "$base/secrets already exists; nothing changed" >&2
  exit 1
fi

install -d -m 755 "$base"
install -d -m 700 "$base/secrets"
install -d -m 755 -o 1000 -g 1000 "$base/storage"
if [ "${ELASTICSEARCH:-}" = 1 ]; then
  install -d -m 770 -o 1000 -g 0 "$base/elasticsearch"
fi
if [ -n "$reports_url" ]; then
  reports_line="REPORTS_URL=$reports_url"
else
  reports_line="# REPORTS_URL unset: no reports origin, uploaded reports are not reachable from outside"
fi

pw() { openssl rand -hex 24; }
pg=$(pw) owner=$(pw) hub=$(pw) worker=$(pw)

cat > "$base/secrets/postgres.env" <<EOF
POSTGRES_PASSWORD=$pg
VANTAGE_OWNER_PASSWORD=$owner
VANTAGE_HUB_PASSWORD=$hub
VANTAGE_WORKER_PASSWORD=$worker
EOF
echo "HUB_MIGRATE_URL=postgres://vantage_owner:$owner@postgres:5432/vantage" > "$base/secrets/db-owner.env"
echo "HUB_DATABASE_URL=postgres://vantage_hub:$hub@postgres:5432/vantage" > "$base/secrets/db-hub.env"
echo "WORKER_DATABASE_URL=postgres://vantage_worker:$worker@postgres:5432/vantage" > "$base/secrets/db-worker.env"

cat > "$base/secrets/app.env" <<EOF
HUB_SECRET=$(openssl rand -hex 32)
HUB_PUBLIC_URL=$hub_url
$reports_line
TRUST_PROXY=true
TRUST_PROXY_HOPS=1
# Logs, APM, Wazuh, Dependency-Track and the mail relay are set up in Vantage itself
# (Verwaltung → Integrationen), see docs/self-hosting.md.
EOF

chmod 600 "$base/secrets/"*.env
echo "created $base/secrets ($(ls "$base/secrets" | tr '\n' ' '))"
