/** Time ranges for log, APM, error and server views: presets plus a custom range of at most 30 days. */
import { berlinLocalInput, parseBerlinLocal } from "../../../shared/time";

export type RangeKey = "15m" | "1h" | "24h" | "7d" | "30d" | "custom";

export interface Preset {
  key: Exclude<RangeKey, "custom">;
  label: string;
  ms: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const PRESETS: Preset[] = [
  { key: "15m", label: "15 min", ms: 15 * MIN },
  { key: "1h", label: "1 h", ms: HOUR },
  { key: "24h", label: "24 h", ms: DAY },
  { key: "7d", label: "7 Tage", ms: 7 * DAY },
];

export const MAX_RANGE_MS = 30 * DAY;

export interface TimeRange {
  key: RangeKey;
  from: number;
  to: number;
  /** Relative ranges end "now", so live updates make sense for them. */
  relative: boolean;
}

export function parseRange(
  get: (key: string) => string | undefined,
  opts: { now?: number; fallback?: Preset["key"]; presets?: Preset[] } = {},
): { range: TimeRange; problem: string | null } {
  const now = opts.now ?? Date.now();
  const presets = opts.presets ?? PRESETS;
  const fallback = presets.find((p) => p.key === (opts.fallback ?? "1h")) ?? presets[0]!;
  const relative = (p: Preset): TimeRange => ({ key: p.key, from: now - p.ms, to: now, relative: true });
  const key = get("range");
  const preset = presets.find((p) => p.key === key);
  if (preset) return { range: relative(preset), problem: null };
  if (key !== "custom") return { range: relative(fallback), problem: null };

  const from = parseBerlinLocal(get("from"));
  const to = parseBerlinLocal(get("to"));
  let problem: string | null = null;
  if (from === null || to === null) problem = "Bitte Beginn und Ende angeben.";
  else if (from >= to) problem = "Der Beginn muss vor dem Ende liegen.";
  else if (to - from > MAX_RANGE_MS) problem = "Der Zeitraum darf höchstens 30 Tage lang sein.";
  else if (from > now) problem = "Der Zeitraum liegt in der Zukunft.";
  if (problem) return { range: relative(fallback), problem };
  return { range: { key: "custom", from: from!, to: Math.min(to!, now), relative: false }, problem: null };
}

const BUCKETS = [MIN, 5 * MIN, 10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

/** The smallest bucket of at least `minMs` that keeps a chart at or below `target` columns. */
export function bucketFor(range: TimeRange, target = 60, minMs = 0): number {
  const span = range.to - range.from;
  return BUCKETS.find((b) => b >= minMs && span / b <= target) ?? DAY;
}

export function fixedInterval(ms: number): string {
  return ms % DAY === 0 ? `${ms / DAY}d` : ms % HOUR === 0 ? `${ms / HOUR}h` : `${ms / MIN}m`;
}

/** Query parameters that describe a range, for links that must keep it. */
export function rangeParams(range: TimeRange): Record<string, string> {
  if (range.key !== "custom") return { range: range.key };
  return { range: "custom", from: berlinLocalInput(range.from), to: berlinLocalInput(range.to) };
}

export function withParams(base: string, params: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    for (const one of Array.isArray(v) ? v : [v]) qs.append(k, one);
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * Preset links plus a custom range behind a disclosure. `keep` are the other parameters of the view
 * (search, filters) that every link and the custom form carry along.
 */
export function RangePicker(props: { base: string; range: TimeRange; keep?: Record<string, string | string[] | undefined>; presets?: Preset[]; custom?: boolean }) {
  const keep = props.keep ?? {};
  const presets = props.presets ?? PRESETS;
  return (
    <div class="range-picker">
      <div class="seg" role="group" aria-label="Zeitraum">
        {presets.map((p) => (
          <a class={`btn small ${props.range.key === p.key ? "active" : ""}`} href={withParams(props.base, { ...keep, range: p.key })} aria-current={props.range.key === p.key ? "true" : undefined}>
            {p.label}
          </a>
        ))}
      </div>
      {props.custom !== false && (
        <details class="disclosure range-custom" open={props.range.key === "custom"}>
          <summary class={`btn small ${props.range.key === "custom" ? "active" : ""}`}>Benutzerdefiniert</summary>
          <form method="get" action={props.base} class="toolbar">
            {Object.entries(keep).flatMap(([k, v]) =>
              v === undefined || v === "" ? [] : (Array.isArray(v) ? v : [v]).map((one) => <input type="hidden" name={k} value={one} />),
            )}
            <input type="hidden" name="range" value="custom" />
            <div class="field">
              <label for="range-from">Von</label>
              <input id="range-from" type="datetime-local" name="from" required value={berlinLocalInput(props.range.from)} />
            </div>
            <div class="field">
              <label for="range-to">Bis</label>
              <input id="range-to" type="datetime-local" name="to" required value={berlinLocalInput(props.range.to)} />
            </div>
            <button class="btn small" type="submit">Anwenden</button>
            <span class="muted small">höchstens 30 Tage</span>
          </form>
        </details>
      )}
    </div>
  );
}
