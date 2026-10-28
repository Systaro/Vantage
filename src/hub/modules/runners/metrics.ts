/**
 * A server's readings over time, from the reports the worker keeps for 30 days (server_reports):
 * CPU usage between consecutive reports, memory, load per core and disk use per filesystem. Only
 * reports the worker accepted count (`results` is set). Runs inside rls() (level 2, like the servers).
 */
import { cpuUsagePct } from "../../../shared/hosts/evaluate";
import type { HostReport } from "../../../shared/hosts/report";
import { berlinOffset } from "../../../shared/time";
import type { TimePoint } from "../../../shared/ui/charts";
import { SERVER_SILENT_INTERVALS } from "./process";

const HOUR = 3600_000;

/** Two reports further apart than this say nothing about one moment, so they give no CPU value. */
const maxGapMs = (intervalSeconds: number) => intervalSeconds * 1000 * SERVER_SILENT_INTERVALS;

function cpuBetween(prev: { t: number; cpu: HostReport["cpu"] } | undefined, cur: { t: number; cpu: HostReport["cpu"] }, intervalSeconds: number) {
  return prev && cur.t - prev.t <= maxGapMs(intervalSeconds) ? cpuUsagePct(prev.cpu, cur.cpu) : null;
}

/** CPU usage of each server of an environment, from its two newest reports. */
export async function currentCpu(tx: any, envId: number): Promise<Map<number, number | null>> {
  const rows = (await tx`
    select s.id, s.interval_seconds, r.t, r.cpu
    from servers s cross join lateral (
      select (extract(epoch from at) * 1000)::float8 as t, report->'cpu' as cpu
      from server_reports where server_id = s.id and results is not null order by at desc limit 2
    ) r
    where s.environment_id = ${envId}
    order by s.id, r.t`) as { id: number; interval_seconds: number; t: number; cpu: HostReport["cpu"] }[];
  const out = new Map<number, number | null>();
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    out.set(r.id, cpuBetween(prev?.id === r.id ? prev : undefined, r, r.interval_seconds));
  });
  return out;
}

export interface ServerHistory {
  cpu: TimePoint[];
  memory: TimePoint[];
  load: TimePoint[];
  disks: { mount: string; points: TimePoint[] }[];
  /** Whether any report in the range carried CPU counters (agents before them only report load). */
  hasCpu: boolean;
}

/** Bucket starts on round Berlin clock times for buckets of an hour and more, like the chart's ticks. */
function bucketStarts(from: number, to: number, bucketMs: number): number[] {
  const off = bucketMs >= HOUR ? berlinOffset(from) : 0;
  const starts: number[] = [];
  for (let t = Math.floor((from + off) / bucketMs) * bucketMs - off; t < to; t += bucketMs) starts.push(t);
  return starts;
}

/** Average (or maximum) of the values per bucket; a bucket without a value stays a gap. */
function bucketed(starts: number[], bucketMs: number, values: { t: number; v: number | null }[], agg: "avg" | "max"): TimePoint[] {
  const sum = starts.map(() => 0);
  const count = starts.map(() => 0);
  const max = starts.map(() => -Infinity);
  for (const { t, v } of values) {
    const i = Math.floor((t - starts[0]!) / bucketMs);
    if (v === null || i < 0 || i >= starts.length) continue;
    sum[i]! += v;
    count[i]!++;
    max[i] = Math.max(max[i]!, v);
  }
  return starts.map((t, i) => ({ t, v: count[i] ? (agg === "avg" ? sum[i]! / count[i]! : max[i]!) : null }));
}

export async function serverHistory(tx: any, server: { id: number; interval_seconds: number }, from: number, to: number, bucketMs: number): Promise<ServerHistory> {
  // One gap's worth before `from`, so the first reading in the range has a predecessor for its CPU value.
  const rows = (await tx`
    select (extract(epoch from at) * 1000)::float8 as t, report->'cpu' as cpu,
           (report->'memory'->>'used_pct')::float8 as memory,
           (report->'load'->>'load5')::float8 / (report->'load'->>'cores')::float8 as load,
           (select coalesce(jsonb_object_agg(d->>'mount', (d->>'used_pct')::float8), '{}') from jsonb_array_elements(report->'disks') d) as disks
    from server_reports
    where server_id = ${server.id} and results is not null
      and at >= ${new Date(from - maxGapMs(server.interval_seconds))} and at <= ${new Date(to)}
    order by at`) as { t: number; cpu: HostReport["cpu"]; memory: number | null; load: number | null; disks: Record<string, number> }[];
  const starts = bucketStarts(from, to, bucketMs);
  if (starts.length === 0) return { cpu: [], memory: [], load: [], disks: [], hasCpu: false };
  const mounts = [...new Set(rows.flatMap((r) => Object.keys(r.disks)))].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
  return {
    cpu: bucketed(starts, bucketMs, rows.map((r, i) => ({ t: r.t, v: cpuBetween(rows[i - 1], r, server.interval_seconds) })), "avg"),
    memory: bucketed(starts, bucketMs, rows.map((r) => ({ t: r.t, v: r.memory })), "avg"),
    load: bucketed(starts, bucketMs, rows.map((r) => ({ t: r.t, v: r.load })), "avg"),
    disks: mounts.map((mount) => ({ mount, points: bucketed(starts, bucketMs, rows.map((r) => ({ t: r.t, v: r.disks[mount] ?? null })), "max") })),
    hasCpu: rows.some((r) => r.cpu),
  };
}
