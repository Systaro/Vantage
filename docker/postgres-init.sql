-- Roles and databases for local development. Production creates the same roles with real passwords.
CREATE ROLE vantage_owner LOGIN PASSWORD 'vantage_dev' CREATEDB;
CREATE ROLE vantage_hub LOGIN PASSWORD 'vantage_dev';
CREATE ROLE vantage_worker LOGIN PASSWORD 'vantage_dev' BYPASSRLS;
CREATE ROLE vantage_ops LOGIN PASSWORD 'vantage_dev' CREATEDB;
CREATE DATABASE vantage OWNER vantage_owner;
CREATE DATABASE vantage_ops OWNER vantage_ops;
