import { join, resolve } from "node:path";
import { env, envInt, envOptional } from "../shared/config";

export interface OpsConfig {
  port: number;
  publicUrl: string;
  secret: string;
  databaseUrl: string;
  dataDir: string;
  hubUrl: string;
  /** Empty → events stay in the outbox and the dashboard shows a warning. */
  hubEventToken: string | undefined;
  ansible: { projectDir: string; gitPull: boolean; bin: string; gitBin: string };
  gitlabUrl: string;
  sshBin: string;
  agentScript: string;
}

export const AGENT_SCRIPT = join(import.meta.dir, "..", "..", "agent", "vantage-agent.sh");

export function loadOpsConfig(): OpsConfig {
  return {
    port: envInt("OPS_PORT", 7101),
    publicUrl: env("OPS_PUBLIC_URL", "http://localhost:7101").replace(/\/+$/, ""),
    secret: env("OPS_SECRET"),
    databaseUrl: env("OPS_DATABASE_URL"),
    dataDir: resolve(env("OPS_DATA_DIR", "./data/ops")),
    hubUrl: env("OPS_HUB_URL", "http://localhost:7100").replace(/\/+$/, ""),
    hubEventToken: envOptional("OPS_HUB_EVENT_TOKEN"),
    ansible: {
      projectDir: resolve(env("ANSIBLE_PROJECT_DIR", "./data/ansible-example")),
      gitPull: envOptional("ANSIBLE_GIT_PULL") === "true",
      bin: env("ANSIBLE_PLAYBOOK_BIN", "ansible-playbook"),
      gitBin: env("OPS_GIT_BIN", "git"),
    },
    gitlabUrl: env("GITLAB_URL", "https://gitlab.com").replace(/\/+$/, ""),
    sshBin: env("OPS_SSH_BIN", "ssh"),
    agentScript: AGENT_SCRIPT,
  };
}
