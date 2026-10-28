import { env, envInt, envOptional } from "../shared/config";

export const hubConfig = {
  port: envInt("HUB_PORT", 7100),
  publicUrl: env("HUB_PUBLIC_URL", "http://localhost:7100"),
  reportsUrl: env("REPORTS_URL", "http://127.0.0.1:7100"),
  secret: env("HUB_SECRET"),
  /** Only the hub process connects with this; the worker has its own role and never needs it. */
  databaseUrl: envOptional("HUB_DATABASE_URL"),
  storageDir: env("STORAGE_DIR", "./data/storage"),
  // Where the clusters are and how to log in: /admin/integrations (src/hub/modules/integrations).
  logs: {
    prefixes: env("LOGS_INDEX_PREFIXES", "logstash-").split(",").map((p) => p.trim()).filter(Boolean),
  },
  apm: {
    errorIndex: env("APM_ERROR_INDEX", "apm-*-error-*"),
    transactionIndex: env("APM_TRANSACTION_INDEX", "apm-*-transaction-*"),
  },
  esTimeoutMs: envInt("ES_TIMEOUT_MS", 15000),
};

export type HubConfig = typeof hubConfig;
