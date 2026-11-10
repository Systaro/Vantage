#!/bin/sh
# Runs once, on the first start of the production Postgres (docker-entrypoint-initdb.d): the hub's
# roles and database, the same layout as docker/postgres-init.sql but with the passwords from
# secrets/postgres.env. Ops is not deployed here, so its role and database are left out.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$VANTAGE_OWNER_PASSWORD" \
  -v hub_pw="$VANTAGE_HUB_PASSWORD" \
  -v worker_pw="$VANTAGE_WORKER_PASSWORD" <<'SQL'
CREATE ROLE vantage_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE vantage_hub LOGIN PASSWORD :'hub_pw';
CREATE ROLE vantage_worker LOGIN PASSWORD :'worker_pw' BYPASSRLS;
CREATE DATABASE vantage OWNER vantage_owner;
SQL
