/**
 * Entry point of the runner image (Dockerfile.runner):
 *   VANTAGE_URL            the hub, e.g. https://vantage.example.com
 *   VANTAGE_RUNNER_TOKEN   vrn_…, or VANTAGE_RUNNER_TOKEN_FILE with it
 *   VANTAGE_RUNNER_DATA    volume for the SSH key and known_hosts (default /data)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_TOKEN } from "../shared/runner-protocol";
import { Runner } from "./runner";

function fail(msg: string): never {
  console.error(`[runner] ${msg}`);
  process.exit(2);
}

const url = (process.env.VANTAGE_URL ?? "").replace(/\/+$/, "");
let u: URL;
try {
  u = new URL(url);
} catch {
  fail("VANTAGE_URL fehlt oder ist keine Adresse (z. B. https://vantage.example.com)");
}
const local = ["localhost", "127.0.0.1", "host.docker.internal"].includes(u.hostname);
if (u.protocol !== "https:" && !(local && u.protocol === "http:")) fail("VANTAGE_URL muss mit https:// beginnen");

const tokenFile = process.env.VANTAGE_RUNNER_TOKEN_FILE;
const token = (tokenFile ? readFileSync(tokenFile, "utf8") : process.env.VANTAGE_RUNNER_TOKEN ?? "").trim();
if (!RUNNER_TOKEN.test(token)) fail("VANTAGE_RUNNER_TOKEN fehlt oder hat nicht das Format vrn_…");

const runner = new Runner({
  url,
  token,
  dataDir: process.env.VANTAGE_RUNNER_DATA ?? "/data",
  version: process.env.VANTAGE_RUNNER_VERSION ?? "dev",
  sshBin: process.env.VANTAGE_RUNNER_SSH_BIN,
  agentScript: process.env.VANTAGE_RUNNER_AGENT ?? join(import.meta.dir, "..", "..", "agent", "vantage-agent.sh"),
});

async function shutdown() {
  await runner.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await runner.start();
