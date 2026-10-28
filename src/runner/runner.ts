/**
 * The Vantage runner (design 6.7): runs inside a customer network, asks the hub what to check,
 * probes monitors with the worker's own probe code, reads servers by running the host agent over
 * SSH, and posts the results back. It only connects out and executes nothing it is sent: the hub
 * names targets of fixed kinds, never commands.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { probeDns, probeHealth, probeHttp, probeTcp, probeTls, type ProbeResult } from "../hub/modules/uptime/probes";
import {
  checkPayload,
  KEY_HEADER,
  MAX_CHECKS,
  MAX_REPORTS,
  SSH_TARGET,
  VERSION_HEADER,
  type CheckPayload,
  type ReportPayload,
  type RunnerConfig,
  type RunnerMonitor,
  type RunnerServer,
} from "../shared/runner-protocol";

export interface RunnerOptions {
  url: string;
  token: string;
  dataDir: string;
  version: string;
  sshBin?: string;
  sshKeygenBin?: string;
  agentScript: string;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

const PARALLEL_PROBES = 20;
const PARALLEL_SERVERS = 4;
const SSH_TIMEOUT_MS = 120_000;
const FLUSH_MS = 10_000;
const DEFAULT_RETRY_SECONDS = 20;
/** Kept while the hub is unreachable; the oldest go first beyond this. */
const MAX_BUFFERED_CHECKS = 20_000;
const MAX_BUFFERED_REPORTS = 2_000;

export function probe(m: RunnerMonitor): Promise<ProbeResult> {
  switch (m.kind) {
    case "http":
      return probeHttp(m.config, m.timeout_ms, m.secrets);
    case "health":
      return probeHealth(m.config, m.auth, m.timeout_ms);
    case "tcp":
      return probeTcp(m.config, m.timeout_ms);
    case "dns":
      return probeDns(m.config, m.timeout_ms);
    case "tls":
      return probeTls(m.config, m.timeout_ms);
  }
}

/** Runs the host agent on `target` and returns its report, or why there is none. */
export async function readServer(o: { sshBin: string; keyFile: string; knownHosts: string; agentScript: string; target: string; timeoutMs?: number }): Promise<{ report: unknown; error: null } | { report: null; error: string }> {
  if (!SSH_TARGET.test(o.target)) return { report: null, error: `Ungültiges SSH-Ziel „${o.target}“` };
  const script = await readFile(o.agentScript);
  const proc = Bun.spawn([
    o.sshBin, "-i", o.keyFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${o.knownHosts}`, "--", o.target, "sh -s -- --print",
  ], { stdin: script, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? SSH_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) {
    const last = err.trim().split("\n").filter(Boolean).at(-1) ?? `Exit-Code ${code}`;
    return { report: null, error: `SSH zu ${o.target} fehlgeschlagen: ${last}`.slice(0, 500) };
  }
  try {
    return { report: JSON.parse(out), error: null };
  } catch {
    return { report: null, error: `${o.target} lieferte keinen gültigen Bericht` };
  }
}

type Target = { type: "monitor"; m: RunnerMonitor } | { type: "server"; s: RunnerServer };
const keyOf = (t: Target) => (t.type === "monitor" ? `m:${t.m.id}` : `s:${t.s.id}`);

export class Runner {
  config: RunnerConfig | null = null;
  publicKey: string | null = null;
  checks: CheckPayload[] = [];
  reports: ReportPayload[] = [];
  private due = new Map<string, number>();
  private running = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private lastProblem: string | null = null;
  private lastSummary: string | null = null;
  private readonly log: (msg: string) => void;
  private readonly http: typeof fetch;
  private readonly now: () => number;

  constructor(private o: RunnerOptions) {
    this.log = o.log ?? ((m) => console.log(`[runner] ${m}`));
    this.http = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  get keyFile() {
    return join(this.o.dataDir, "ssh", "id_ed25519");
  }

  /** Creates the runner's own SSH key on first start; only its public half ever leaves the machine. */
  async ensureKey(): Promise<void> {
    await mkdir(join(this.o.dataDir, "ssh"), { recursive: true, mode: 0o700 });
    if (!(await Bun.file(`${this.keyFile}.pub`).exists())) {
      const gen = Bun.spawn([this.o.sshKeygenBin ?? "ssh-keygen", "-t", "ed25519", "-N", "", "-C", "vantage-runner", "-f", this.keyFile, "-q"], { stdout: "ignore", stderr: "pipe" });
      if ((await gen.exited) !== 0) throw new Error(`ssh-keygen failed: ${await new Response(gen.stderr).text()}`);
      this.log("neuer SSH-Schlüssel angelegt");
    }
    this.publicKey = (await Bun.file(`${this.keyFile}.pub`).text()).trim();
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.o.token}`, [VERSION_HEADER]: this.o.version, accept: "application/json" };
    if (this.publicKey) h[KEY_HEADER] = this.publicKey;
    if (json) h["content-type"] = "application/json";
    return h;
  }

  private problem(text: string | null) {
    if (text === this.lastProblem) return;
    this.lastProblem = text;
    this.log(text ?? "Verbindung zum Hub steht wieder");
  }

  /** Fetches what to check. New targets are due at once, dropped ones are forgotten. */
  async refresh(): Promise<void> {
    let res: Response;
    try {
      res = await this.http(`${this.o.url}/api/runner/v1/config`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      return this.problem(`Hub nicht erreichbar: ${(err as Error).message}`);
    }
    if (res.status === 401) return this.problem("Der Hub lehnt das Token ab (gesperrt oder falsch).");
    if (!res.ok) return this.problem(`Hub antwortet mit HTTP ${res.status}`);
    this.config = (await res.json()) as RunnerConfig;
    this.problem(null);
    const keys = new Set(this.targets().map(keyOf));
    for (const k of this.due.keys()) if (!keys.has(k)) this.due.delete(k);
    for (const k of keys) if (!this.due.has(k)) this.due.set(k, this.now());
    const summary = `Runner „${this.config.runner.name}“: ${this.config.monitors.length} Monitore, ${this.config.servers.length} Server`;
    if (summary !== this.lastSummary) this.log(summary);
    this.lastSummary = summary;
  }

  private targets(): Target[] {
    if (!this.config) return [];
    return [...this.config.monitors.map((m) => ({ type: "monitor" as const, m })), ...this.config.servers.map((s) => ({ type: "server" as const, s }))];
  }

  /** Starts every due target that is not already running, within the parallel limits. */
  tick(): Promise<void>[] {
    const started: Promise<void>[] = [];
    const now = this.now();
    let probes = [...this.running].filter((k) => k.startsWith("m:")).length;
    let servers = this.running.size - probes;
    for (const t of this.targets()) {
      const key = keyOf(t);
      if (this.running.has(key) || (this.due.get(key) ?? 0) > now) continue;
      if (t.type === "monitor" ? probes >= PARALLEL_PROBES : servers >= PARALLEL_SERVERS) continue;
      if (t.type === "monitor") probes++;
      else servers++;
      this.running.add(key);
      started.push(this.run(t).finally(() => this.running.delete(key)));
    }
    return started;
  }

  private async run(t: Target): Promise<void> {
    const at = new Date(this.now());
    if (t.type === "monitor") {
      const result = await probe(t.m).catch((err): ProbeResult => ({ ok: false, latencyMs: null, message: `Prüfung abgebrochen: ${(err as Error).message}` }));
      this.push({ check: checkPayload(t.m.id, result, at) });
      const seconds = result.ok ? t.m.interval_seconds : Math.min(t.m.interval_seconds, t.m.retry_interval_seconds ?? DEFAULT_RETRY_SECONDS);
      this.due.set(keyOf(t), at.getTime() + seconds * 1000);
    } else {
      const r = await readServer({
        sshBin: this.o.sshBin ?? "ssh", keyFile: this.keyFile, knownHosts: join(this.o.dataDir, "ssh", "known_hosts"),
        agentScript: this.o.agentScript, target: t.s.ssh_target,
      });
      this.push({ report: { server_id: t.s.id, at: at.toISOString(), report: r.report, error: r.error } });
      this.due.set(keyOf(t), at.getTime() + t.s.interval_seconds * 1000);
    }
  }

  private push(x: { check?: CheckPayload; report?: ReportPayload }) {
    if (x.check) this.checks.push(x.check);
    if (x.report) this.reports.push(x.report);
    if (this.checks.length > MAX_BUFFERED_CHECKS) this.checks.splice(0, this.checks.length - MAX_BUFFERED_CHECKS);
    if (this.reports.length > MAX_BUFFERED_REPORTS) this.reports.splice(0, this.reports.length - MAX_BUFFERED_REPORTS);
  }

  /** Sends what is buffered, oldest first; keeps it when the hub cannot be reached. */
  flush(): Promise<void> {
    this.flushing ??= this.send().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async send(): Promise<void> {
    while (this.checks.length || this.reports.length) {
      const checks = this.checks.slice(0, MAX_CHECKS);
      const reports = this.reports.slice(0, MAX_REPORTS);
      let res: Response;
      try {
        res = await this.http(`${this.o.url}/api/runner/v1/results`, {
          method: "POST", headers: this.headers(true), body: JSON.stringify({ checks, reports }), signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        return this.problem(`Hub nicht erreichbar, ${this.checks.length + this.reports.length} Ergebnisse warten: ${(err as Error).message}`);
      }
      if (res.status === 401) return this.problem("Der Hub lehnt das Token ab (gesperrt oder falsch).");
      if (res.status >= 500 || res.status === 429) return this.problem(`Hub antwortet mit HTTP ${res.status}, Ergebnisse warten`);
      // Anything else is final for this batch: a body the hub refuses would be refused again.
      if (!res.ok) this.log(`Hub verwirft ${checks.length + reports.length} Ergebnisse: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      else this.problem(null);
      this.checks.splice(0, checks.length);
      this.reports.splice(0, reports.length);
    }
  }

  async start(): Promise<void> {
    await this.ensureKey();
    this.log(`Version ${this.o.version}, Hub ${this.o.url}, öffentlicher Schlüssel: ${this.publicKey}`);
    const refreshLoop = async () => {
      await this.refresh();
      this.refreshTimer = setTimeout(refreshLoop, (this.config?.poll_seconds ?? 60) * 1000);
    };
    await refreshLoop();
    this.timers.push(setInterval(() => void this.tick(), 1000));
    this.timers.push(setInterval(() => void this.flush(), FLUSH_MS));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.timers = [];
    await this.flush();
  }
}
