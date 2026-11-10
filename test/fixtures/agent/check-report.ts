/**
 * Validates one vantage-agent report from stdin with the server's parser; used by docker-check.sh.
 * Prints a one-line summary, exits 1 when the report is invalid or an expectation fails.
 *
 *   --has-mount PATH   a disk with this mount point must be reported
 *   --no-mount PATH    no disk with this mount point may be reported
 *   --es R/B/M         es must be reachable R, blocked_indices B, max_disk_pct M (e.g. true/2/96)
 *   --memory set|null  memory must be present or null
 */
import { parseReportText } from "../../../src/shared/hosts/report";

const text = (await Bun.stdin.text()).trim();
const parsed = parseReportText(text);
if (!parsed.ok) {
  console.error(`INVALID REPORT: ${parsed.error}\n${text.slice(0, 2000)}`);
  process.exit(1);
}
const r = parsed.report;
const problems: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1] ?? "";
  switch (flag) {
    case "--has-mount":
      if (!r.disks.some((d) => d.mount === value)) problems.push(`mount ${value} missing`);
      break;
    case "--no-mount":
      if (r.disks.some((d) => d.mount === value)) problems.push(`mount ${value} must not be reported`);
      break;
    case "--es": {
      const got = r.es ? `${r.es.reachable}/${r.es.blocked_indices}/${r.es.max_disk_pct}` : "null";
      if (got !== value) problems.push(`es is ${got}, expected ${value}`);
      break;
    }
    case "--memory":
      if ((r.memory === null ? "null" : "set") !== value) problems.push(`memory is ${JSON.stringify(r.memory)}, expected ${value}`);
      break;
    default:
      problems.push(`unknown flag ${flag}`);
  }
}

const disks = r.disks.map((d) => `${d.mount}(${d.fstype},${d.used_pct}%)`).join(" ");
console.log(
  `valid: host=${r.hostname} disks=[${disks}] memory=${r.memory ? `${r.memory.used_pct}%` : "null"} ` +
    `load=${r.load ? `${r.load.load1}/${r.load.cores}c` : "null"} systemd=${JSON.stringify(r.systemd)} ` +
    `docker=${JSON.stringify(r.docker)} es=${JSON.stringify(r.es)} errors=${JSON.stringify(r.errors)}`,
);
if (problems.length) {
  console.error(`EXPECTATION FAILED: ${problems.join("; ")}`);
  process.exit(1);
}
