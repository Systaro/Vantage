/**
 * Tests for agent/vantage-agent.sh: report output against the server contract, argument parsing,
 * check parsing with fake binaries and proc files, agent mode against an HTTP stub, ES checks and
 * --install / --uninstall in a throwaway HOME with a fake crontab.
 * The container runs (Debian, Ubuntu, Alpine) live in test/fixtures/agent/docker-check.sh and are not
 * part of `bun test`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseReportText, type HostReport } from "../src/shared/hosts/report";
import { INGEST_PATH, startStub, type Stub } from "./fixtures/agent/stub";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "agent/vantage-agent.sh");
const FIXTURES = join(ROOT, "test/fixtures/agent");
const FAKE_BIN = join(FIXTURES, "bin");
const CRON_BIN = join(FIXTURES, "cron-bin");
const CURL_SPY = join(FIXTURES, "curl-spy");
const TOKEN = `vha_${"A".repeat(20)}${"b".repeat(20)}_-9`;
const OTHER_TOKEN = `vha_${"z".repeat(43)}`;
const SLOW = 30_000;

let work: string;
let seq = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "vantage-agent-test-"));
  for (const dir of [FAKE_BIN, CRON_BIN, CURL_SPY]) {
    for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o755);
  }
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

function freshDir(name: string): string {
  const dir = join(work, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  env?: Record<string, string | undefined>;
  /** Feed the script on stdin (`sh -s -- args`), like central mode over SSH. */
  viaStdin?: boolean;
  shell?: string;
  /** Prepended to PATH. */
  path?: string[];
}

/** Runs the agent with a clean environment: no VANTAGE_* from the caller, HOME in the temp dir. */
async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("VANTAGE_")) env[k] = v;
  env.HOME = join(work, "home-default");
  env.PATH = [...(opts.path ?? []), process.env.PATH ?? "/usr/bin:/bin"].join(":");
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const shell = opts.shell ?? "sh";
  const cmd = opts.viaStdin ? [shell, "-s", "--", ...args] : [shell, SCRIPT, ...args];
  const proc = Bun.spawn(cmd, {
    cwd: work,
    env,
    stdin: opts.viaStdin ? Bun.file(SCRIPT) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** stdout must be exactly one JSON document that the server accepts. */
function report(res: RunResult): HostReport {
  if (res.code !== 0) throw new Error(`exit ${res.code}: ${res.stderr}`);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  expect(lines).toHaveLength(1);
  const parsed = parseReportText(lines[0] ?? "");
  if (!parsed.ok) throw new Error(`report rejected: ${parsed.error}\n${res.stdout}`);
  return parsed.report;
}

function expectSaneReport(r: HostReport) {
  expect(r.agent).toBe("1");
  expect(r.hostname.length).toBeGreaterThan(0);
  expect(Math.abs(r.time - Date.now() / 1000)).toBeLessThan(120);
}

describe("--print on this machine", () => {
  test("sh: valid report", async () => {
    const r = report(await run(["--print"]));
    expectSaneReport(r);
    if (process.platform === "darwin") {
      expect(r.memory).toBeNull();
      expect(r.disks.some((d) => d.mount === "/")).toBe(true);
    }
    expect(r.load?.cores ?? 1).toBeGreaterThanOrEqual(1);
  }, SLOW);

  test.skipIf(!existsSync("/bin/dash"))("dash: valid report", async () => {
    expectSaneReport(report(await run(["--print"], { shell: "/bin/dash" })));
  }, SLOW);

  test("piped into sh -s, as over SSH", async () => {
    expectSaneReport(report(await run(["--print"], { viaStdin: true })));
  }, SLOW);

  test("never posts and needs no token", async () => {
    const stub = startStub();
    try {
      const r = await run(["--print"], { env: { VANTAGE_URL: stub.url, VANTAGE_TOKEN: TOKEN } });
      report(r);
      expect(stub.requests).toHaveLength(0);
    } finally {
      stub.stop();
    }
  }, SLOW);
});

describe("argument parsing", () => {
  test("unknown flag exits 2", async () => {
    const r = await run(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown argument: --bogus");
  });

  test("positional argument exits 2", async () => {
    expect((await run(["print"])).code).toBe(2);
  });

  test("--url without a value exits 2", async () => {
    expect((await run(["--url"])).code).toBe(2);
    expect((await run(["--url", "--print"])).code).toBe(2);
    expect((await run(["--token"])).code).toBe(2);
  });

  test("conflicting modes exit 2", async () => {
    expect((await run(["--print", "--install"])).code).toBe(2);
  });

  test("invalid --interval exits 2", async () => {
    for (const v of ["0", "61", "90", "1500", "7x", "-5"]) expect((await run(["--print", "--interval", v])).code).toBe(2);
    expect((await run(["--print", "--interval=1441"])).code).toBe(2);
  });

  test("--help and --version exit 0", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: vantage-agent");
    expect((await run(["-h"])).code).toBe(0);
    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe("vantage-agent 1");
  });

  test("agent mode validates URL and token", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["--url", "ftp://x", "--token", TOKEN])).code).toBe(2);
    expect((await run(["--url", "http://127.0.0.1:1", "--token", "vha_short"])).code).toBe(2);
    expect((await run(["--url", "http://127.0.0.1:1", "--token", `vha_${"a".repeat(42)}!`])).code).toBe(2);
    expect((await run(["--print", "--es-url", "localhost:9200"])).code).toBe(2);
  });

  test("unreadable --config exits 2", async () => {
    expect((await run(["--print", "--config", join(work, "nope.conf")])).code).toBe(2);
  });

  test("--install from a pipe refuses and says to download the file", async () => {
    const r = await run(["--install", "--url", "http://127.0.0.1:1", "--token", TOKEN], { viaStdin: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Download vantage-agent.sh first");
  });
});

/** A fixture host: proc files, a mounts table pointing into a temp dir, numbers from the fake df. */
function fixtureHost(meminfo?: string) {
  const fx = freshDir("host");
  const proc = join(fx, "proc");
  mkdirSync(proc);
  copyFileSync(join(FIXTURES, "proc/loadavg"), join(proc, "loadavg"));
  if (meminfo === undefined) copyFileSync(join(FIXTURES, "proc/meminfo"), join(proc, "meminfo"));
  else writeFileSync(join(proc, "meminfo"), meminfo);
  for (const d of ["data dir", "bind", "empty", "run", "merged", "nfs", 'odd "q" \\b']) mkdirSync(join(fx, d));
  writeFileSync(join(fx, "hosts.conf"), "127.0.0.1 localhost\n");
  writeFileSync(join(fx, "resolv.conf"), "nameserver 127.0.0.1\n");
  const enc = (p: string) => p.replaceAll(" ", "\\040");
  const mounts = [
    "/dev/sda1 / ext4 rw,relatime 0 0",
    "proc /proc proc rw,nosuid 0 0",
    "sysfs /sys sysfs rw 0 0",
    `tmpfs ${enc(fx)}/run tmpfs rw 0 0`,
    `overlay ${enc(fx)}/merged overlay rw,lowerdir=/a:/b 0 0`,
    // bind-mounted files come first and share the device with the directory mount below
    `/dev/sdb1 ${enc(fx)}/hosts.conf ext4 rw 0 0`,
    `/dev/sdf1 ${enc(fx)}/resolv.conf ext4 rw 0 0`,
    `/dev/sdb1 ${enc(fx)}/data\\040dir xfs rw 0 0`,
    `/dev/sdb1 ${enc(fx)}/bind xfs rw 0 0`,
    `/dev/sdc1 ${enc(fx)}/empty ext4 rw 0 0`,
    `/dev/sdd1 ${enc(fx)}/tab\\011dir ext4 rw 0 0`,
    `/dev/sde1 ${enc(fx)}/missing ext4 rw 0 0`,
    `nas:/export ${enc(fx)}/nfs nfs4 rw,hard 0 0`,
    // quote and backslash (\134) in the mount point, quote and backslash in the device
    `dev"q\\134x ${enc(fx)}/odd\\040"q"\\040\\134b ext4 rw 0 0`,
  ];
  writeFileSync(join(proc, "mounts"), mounts.join("\n") + "\n");
  const dfTable = join(fx, "df-table");
  writeFileSync(
    dfTable,
    [
      "/|1000|400|600",
      `${fx}/hosts.conf|1000|400|600`,
      `${fx}/resolv.conf|1000|400|600`,
      `${fx}/data dir|2000|1500|500`,
      `${fx}/bind|2000|1500|500`,
      `${fx}/empty|0|0|0`,
      `${fx}/odd "q" \\b|300|100|200`,
    ].join("\n") + "\n",
  );
  const env = { VANTAGE_PROC: proc, VANTAGE_SYSTEMD_DIR: fx, FAKE_DF_TABLE: dfTable };
  return { fx, env };
}

describe("checks on a fixture host (fake proc, df, systemctl, docker)", () => {
  test("disks, memory, load, systemd and docker are parsed", async () => {
    const { fx, env } = fixtureHost();
    const r = report(await run(["--print"], { env, path: [FAKE_BIN] }));
    expect(r.disks).toEqual([
      { mount: "/", device: "/dev/sda1", fstype: "ext4", size_kb: 1000, used_kb: 400, avail_kb: 600, used_pct: 40 },
      { mount: `${fx}/data dir`, device: "/dev/sdb1", fstype: "xfs", size_kb: 2000, used_kb: 1500, avail_kb: 500, used_pct: 75 },
      { mount: `${fx}/odd "q" \\b`, device: 'dev"q\\x', fstype: "ext4", size_kb: 300, used_kb: 100, avail_kb: 200, used_pct: 33.3 },
    ]);
    expect(r.memory).toEqual({ total_kb: 2048000, available_kb: 1024000, used_pct: 50 });
    expect(r.load).toEqual({ load1: 0.12, load5: 0.2, load15: 0.3, cores: 4 });
    expect(r.systemd).toEqual({ failed: ["nginx.service", "backup@daily.service"] });
    expect(r.docker).toEqual({ total: 4, stopped: ["web", "worker"] });
    expect(r.es).toBeNull();
    // the hung/broken network mount is reported as an error, nothing else is
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain(`disk ${fx}/nfs: df failed`);
  }, SLOW);

  test("CPU time comes from the first line of /proc/stat; without the file it is null, garbage is an error", async () => {
    const { fx, env } = fixtureHost();
    writeFileSync(join(fx, "proc/stat"), "cpu  4705 150 1120 16250 520 20 30 5 7 3\ncpu0 1 2 3 4 5 6 7 8 9 10\nintr 1\n");
    expect(report(await run(["--print"], { env, path: [FAKE_BIN] })).cpu).toEqual({ total: 22800, idle: 16250, iowait: 520 });
    writeFileSync(join(fx, "proc/stat"), "cpu  x 1 2 3\n");
    const garbage = report(await run(["--print"], { env, path: [FAKE_BIN] }));
    expect(garbage.cpu).toBeNull();
    expect(garbage.errors.some((e) => e.startsWith("cpu:"))).toBe(true);
    const { env: noStat } = fixtureHost();
    expect(report(await run(["--print"], { env: noStat, path: [FAKE_BIN] })).cpu).toBeNull();
  }, SLOW);

  test("dash parses the fixture host the same way", async () => {
    if (!existsSync("/bin/dash")) return;
    const { env } = fixtureHost();
    const sh = report(await run(["--print"], { env, path: [FAKE_BIN] }));
    const dash = report(await run(["--print"], { env, path: [FAKE_BIN], shell: "/bin/dash" }));
    expect({ ...dash, time: 0 }).toEqual({ ...sh, time: 0 });
  }, SLOW);

  test("memory without MemAvailable falls back to MemFree + Buffers + Cached", async () => {
    const { env } = fixtureHost("MemTotal: 1000000 kB\nMemFree: 100000 kB\nBuffers: 50000 kB\nCached: 250000 kB\n");
    const r = report(await run(["--print"], { env, path: [FAKE_BIN] }));
    expect(r.memory).toEqual({ total_kb: 1000000, available_kb: 400000, used_pct: 60 });
  }, SLOW);

  test("no systemd runtime dir means systemd null; docker without access means null plus an error", async () => {
    const { fx, env } = fixtureHost();
    const r = report(await run(["--print"], { env: { ...env, VANTAGE_SYSTEMD_DIR: join(fx, "no-systemd"), FAKE_DOCKER: "denied" }, path: [FAKE_BIN] }));
    expect(r.systemd).toBeNull();
    expect(r.docker).toBeNull();
    expect(r.errors).toContain("docker: not accessible (permission denied)");
  }, SLOW);

  test("unparsable proc files degrade to null with an error, the report stays valid", async () => {
    const { fx, env } = fixtureHost("garbage\n");
    writeFileSync(join(fx, "proc/loadavg"), "nan nan nan\n");
    writeFileSync(join(fx, "proc/mounts"), "");
    const r = report(await run(["--print"], { env, path: [FAKE_BIN] }));
    expect(r.memory).toBeNull();
    expect(r.load).toBeNull();
    expect(r.disks).toEqual([]);
    expect(r.errors.some((e) => e.startsWith("memory:"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("load:"))).toBe(true);
  }, SLOW);
});

describe("agent mode", () => {
  let stub: Stub;
  beforeAll(() => {
    stub = startStub({ token: TOKEN });
  });
  afterAll(() => stub.stop());

  test("posts the report with the bearer token", async () => {
    const before = stub.reports().length;
    const r = await run([], { env: { VANTAGE_URL: stub.url, VANTAGE_TOKEN: TOKEN } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const reqs = stub.reports().slice(before);
    expect(reqs).toHaveLength(1);
    const req = reqs[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe(INGEST_PATH);
    expect(req.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.contentType).toBe("application/json");
    const parsed = parseReportText(req.body);
    expect(parsed.ok).toBe(true);
  }, SLOW);

  test("flags and a trailing slash work too", async () => {
    const before = stub.reports().length;
    const r = await run(["--url", `${stub.url}/`, `--token=${TOKEN}`]);
    expect(r.code).toBe(0);
    expect(stub.reports().slice(before).map((q) => q.path)).toEqual([INGEST_PATH]);
  }, SLOW);

  test("precedence: config file < environment < flags", async () => {
    const dir = freshDir("conf");
    const conf = join(dir, "agent.conf");
    writeFileSync(conf, `VANTAGE_URL='${stub.url}'\nVANTAGE_TOKEN='${OTHER_TOKEN}'\n`);
    // file alone: wrong token -> 401
    expect((await run(["--config", conf])).code).toBe(1);
    // environment beats the file
    expect((await run(["--config", conf], { env: { VANTAGE_TOKEN: TOKEN } })).code).toBe(0);
    // flags beat the environment
    expect((await run(["--config", conf, "--token", OTHER_TOKEN], { env: { VANTAGE_TOKEN: TOKEN } })).code).toBe(1);
    expect((await run(["--config", conf, "--token", TOKEN], { env: { VANTAGE_TOKEN: OTHER_TOKEN } })).code).toBe(0);
  }, SLOW);

  test("a 401 makes the agent exit non-zero with curl's error on stderr", async () => {
    const r = await run([], { env: { VANTAGE_URL: stub.url, VANTAGE_TOKEN: OTHER_TOKEN } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("401");
  }, SLOW);

  test("the token never appears on the curl command line", async () => {
    const realCurl = Bun.which("curl");
    expect(realCurl).not.toBeNull();
    const log = join(freshDir("spy"), "argv.log");
    const r = await run([], {
      env: { VANTAGE_URL: stub.url, VANTAGE_TOKEN: TOKEN, CURL_ARGV_LOG: log, REAL_CURL: realCurl ?? "" },
      path: [CURL_SPY],
    });
    expect(r.code).toBe(0);
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain(INGEST_PATH);
    expect(argv).not.toContain(TOKEN);
  }, SLOW);
});

describe("elasticsearch check", () => {
  let stub: Stub;
  beforeAll(() => {
    stub = startStub();
  });
  afterAll(() => stub.stop());

  test("counts blocked indices and takes the highest disk percentage", async () => {
    const r = report(await run(["--print", "--es-url", stub.url]));
    expect(r.es).toEqual({ reachable: true, blocked_indices: 2, max_disk_pct: 96 });
    expect(r.errors.filter((e) => e.startsWith("es:"))).toEqual([]);
    const seen = stub.requests.map((q) => `${q.path}${q.search}`);
    expect(seen).toContain("/_cluster/health");
    expect(seen).toContain("/_all/_settings/index.blocks.read_only_allow_delete?flat_settings=true");
    expect(seen).toContain("/_cat/allocation?h=disk.percent");
  }, SLOW);

  test("unreachable ES is reported, not fatal", async () => {
    const r = report(await run(["--print"], { env: { VANTAGE_ES_URL: "http://127.0.0.1:1" } }));
    expect(r.es).toEqual({ reachable: false, blocked_indices: 0, max_disk_pct: null });
    expect(r.errors.some((e) => e.startsWith("es: not reachable"))).toBe(true);
  }, SLOW);

  test("credentials in the ES URL stay off the command line", async () => {
    const realCurl = Bun.which("curl") ?? "";
    const log = join(freshDir("spy"), "argv.log");
    const esUrl = stub.url.replace("http://", "http://elastic:s3cr3t-pw@");
    const before = stub.requests.length;
    const r = report(await run(["--print", "--es-url", esUrl], { env: { CURL_ARGV_LOG: log, REAL_CURL: realCurl }, path: [CURL_SPY] }));
    expect(r.es?.reachable).toBe(true);
    expect(readFileSync(log, "utf8")).not.toContain("s3cr3t-pw");
    expect(stub.requests[before]?.authorization).toBe(`Basic ${btoa("elastic:s3cr3t-pw")}`);
  }, SLOW);
});

const isRoot = process.getuid?.() === 0;

describe.skipIf(isRoot)("--install / --uninstall as a normal user", () => {
  let stub: Stub;
  beforeAll(() => {
    stub = startStub({ token: TOKEN });
  });
  afterAll(() => stub.stop());

  function sandbox() {
    const home = freshDir("home");
    const crontab = join(home, "crontab.txt");
    const opts: RunOptions = { env: { HOME: home, FAKE_CRONTAB_FILE: crontab }, path: [CRON_BIN] };
    const bin = join(home, ".local/bin/vantage-agent");
    const conf = join(home, ".config/vantage-agent.conf");
    const cronLines = () => (existsSync(crontab) ? readFileSync(crontab, "utf8").split("\n").filter((l) => l !== "") : null);
    const ours = () => (cronLines() ?? []).filter((l) => l.includes("vantage-agent"));
    return { home, crontab, opts, bin, conf, cronLines, ours };
  }

  test("installs binary, config and one crontab line; re-install is idempotent; uninstall removes all", async () => {
    const s = sandbox();
    // other entries, blank lines included, must survive install and uninstall byte for byte
    const foreign = "# backups\n0 3 * * * /usr/bin/true backup\n\n";
    writeFileSync(s.crontab, foreign);
    const esUrl = "http://127.0.0.1:1/it's";
    const before = stub.reports().length;

    const first = await run(["--install", "--url", stub.url, "--token", TOKEN, "--es-url", esUrl, "--interval", "10"], s.opts);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("first report sent");

    expect(statSync(s.bin).mode & 0o777).toBe(0o755);
    expect(readFileSync(s.bin, "utf8")).toBe(readFileSync(SCRIPT, "utf8"));
    expect(statSync(s.conf).mode & 0o777).toBe(0o600);
    const sourced = Bun.spawnSync(["sh", "-c", '. "$1"; printf "%s\\n" "$VANTAGE_URL" "$VANTAGE_TOKEN" "$VANTAGE_ES_URL"', "sh", s.conf]);
    expect(sourced.stdout.toString()).toBe(`${stub.url}\n${TOKEN}\n${esUrl}\n`);
    expect(s.ours()).toEqual([`*/10 * * * * '${s.bin}' --config '${s.conf}' >/dev/null 2>&1 # managed by vantage-agent`]);

    const second = await run(["--install", "--url", stub.url, "--token", TOKEN, "--interval", "60"], s.opts);
    expect(second.code).toBe(0);
    expect(s.ours()).toHaveLength(1);
    expect(s.ours()[0]).toStartWith("0 * * * * ");
    expect(readFileSync(s.crontab, "utf8")).toStartWith(foreign);

    // without flags the values come from the installed config
    const third = await run(["--install"], s.opts);
    expect(third.code).toBe(0);
    expect(s.ours()).toHaveLength(1);
    expect(s.ours()[0]).toStartWith("*/5 * * * * ");

    const posted = stub.reports().slice(before);
    expect(posted).toHaveLength(3);
    for (const p of posted) expect(parseReportText(p.body).ok).toBe(true);
    // the first report came from the installed config, ES URL included
    expect(JSON.parse(posted[0]!.body).es).toEqual({ reachable: false, blocked_indices: 0, max_disk_pct: null });

    const un = await run(["--uninstall"], s.opts);
    expect(un.code).toBe(0);
    expect(existsSync(s.bin)).toBe(false);
    expect(existsSync(s.conf)).toBe(false);
    expect(readFileSync(s.crontab, "utf8")).toBe(foreign);

    const again = await run(["--uninstall"], s.opts);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("nothing to remove");
  }, SLOW);

  test("interval mapping", async () => {
    const s = sandbox();
    const cases: [string, string][] = [
      ["1", "*/1 * * * *"],
      ["59", "*/59 * * * *"],
      ["120", "0 */2 * * *"],
      ["1440", "0 */24 * * *"],
    ];
    for (const [interval, schedule] of cases) {
      expect((await run(["--install", "--url", stub.url, "--token", TOKEN, `--interval=${interval}`], s.opts)).code).toBe(0);
      expect(s.ours()).toHaveLength(1);
      expect(s.ours()[0]).toStartWith(`${schedule} '`);
    }
    // the crontab held only our line, so uninstall removes the crontab entirely
    expect((await run(["--uninstall"], s.opts)).code).toBe(0);
    expect(s.cronLines()).toBeNull();
  }, SLOW);

  test("a failing first report is reported with exit 1, the install itself stays", async () => {
    const s = sandbox();
    const r = await run(["--install", "--url", stub.url, "--token", OTHER_TOKEN], s.opts);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("401");
    expect(r.stderr).toContain("installed, but the first report failed");
    expect(existsSync(s.bin)).toBe(true);
    expect(s.ours()).toHaveLength(1);
    expect((await run(["--uninstall"], s.opts)).code).toBe(0);
    expect(existsSync(s.bin)).toBe(false);
  }, SLOW);

  test("rejects values with newlines before writing anything", async () => {
    const s = sandbox();
    const r = await run(["--install", "--url", stub.url, "--token", TOKEN, "--es-url", "http://a\nb"], s.opts);
    expect(r.code).toBe(2);
    expect(existsSync(s.bin)).toBe(false);
    expect(existsSync(s.conf)).toBe(false);
    expect(s.cronLines()).toBeNull();
  });
});
