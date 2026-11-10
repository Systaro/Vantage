import { createHubApp } from "./app";
import { hubConfig } from "./config";

const app = createHubApp();

const server = Bun.serve({
  port: hubConfig.port,
  hostname: process.env.HUB_LISTEN ?? "0.0.0.0",
  // Test-report uploads (zipped Playwright HTML) can be large.
  maxRequestBodySize: 200 * 1024 * 1024,
  fetch: (req, srv) => app.fetch(req, srv),
});

console.log(`[hub] listening on ${server.url} (public ${hubConfig.publicUrl}, reports ${hubConfig.reportsUrl})`);
