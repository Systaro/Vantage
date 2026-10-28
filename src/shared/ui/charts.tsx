/**
 * Server-rendered SVG charts. No client JS: hover detail comes from SVG <title> elements on hit
 * targets larger than the marks. Colours come from classes in vantage.css (tokens), so CSP holds and
 * dark mode follows the tokens. Charts follow the dataviz rules: one series per chart (the card title
 * names it, no legend), thin marks, a recessive grid, and a table twin with the same numbers.
 */
import { berlinOffset } from "../time";

const W = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface TimePoint {
  /** Bucket start, epoch ms. */
  t: number;
  v: number | null;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", ...opts });
const hm = fmt({ hour: "2-digit", minute: "2-digit" });
const dm = fmt({ day: "2-digit", month: "2-digit" });
const dmhm = (t: number) => `${dm.format(t)} ${hm.format(t)}`;
const r1 = (v: number) => Math.round(v * 10) / 10;

function niceStep(raw: number, integer: boolean): number {
  if (integer && raw <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  // Counts never get a 2.5 step: 0, 2.5, 5 would label half occurrences.
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 && !(integer && mag === 1) ? 2.5 : r <= 5 ? 5 : 10) * mag;
}

/** Round y-axis ticks from 0 up to (at least) `max`. */
export function yTicks(max: number, count = 4, integer = false): number[] {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / count, integer);
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

const TIME_STEPS = [MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

/** Time ticks on round Berlin clock times (03:00, 06:00, midnight), never on odd minutes. */
export function xTicks(from: number, to: number, max = 6): number[] {
  const step = TIME_STEPS.find((s) => (to - from) / s <= max) ?? 7 * DAY;
  const off = step >= HOUR ? berlinOffset(from) : 0;
  const ticks: number[] = [];
  for (let t = Math.ceil((from + off) / step) * step - off; t <= to; t += step) ticks.push(t);
  return ticks;
}

function timeLabel(t: number, span: number, step: number): string {
  if (step >= DAY) return dm.format(t);
  // Up to about a day the clock is enough; midnight names the new day instead.
  if (span <= 26 * HOUR) return hm.format(t) === "00:00" ? dm.format(t) : hm.format(t);
  return dmhm(t);
}

export function bucketLabel(t: number, bucketMs: number): string {
  if (bucketMs >= DAY) return dm.format(t);
  return `${dmhm(t)}–${hm.format(t + bucketMs)}`;
}

/** Column with a rounded data end and a square base (dataviz mark spec). */
/** Runs of points with a value; a bucket without one breaks the line instead of being drawn as zero. */
function splitAtGaps(pts: TimePoint[]): TimePoint[][] {
  const segments: TimePoint[][] = [];
  let current: TimePoint[] = [];
  for (const p of pts) {
    if (p.v === null) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(p);
  }
  if (current.length) segments.push(current);
  return segments;
}

function columnPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/**
 * A single time series as columns (counts per bucket) or a line (rates, latencies), with an optional
 * table view. Gaps (`v: null`) break the line instead of drawing a fake zero.
 */
export function TimeChart(props: {
  points: TimePoint[];
  bucketMs: number;
  kind: "columns" | "line";
  label: string;
  format: (v: number) => string;
  tone?: "accent" | "bad";
  /** The y axis reaches at least this value, so a flat series near zero is not drawn as a spike. */
  minTop?: number;
  /** Counts: whole-number ticks only. */
  integer?: boolean;
  /** Show the "Werte als Tabelle" twin below the chart (default true). */
  table?: boolean;
  height?: number;
}) {
  const pts = props.points;
  if (pts.length === 0) return <p class="muted small">Keine Daten im Zeitraum.</p>;
  const H = props.height ?? 200;
  const M = { l: 72, r: 12, t: 12, b: 30 };
  const PW = W - M.l - M.r;
  const PH = H - M.t - M.b;
  const from = pts[0]!.t;
  const to = pts.at(-1)!.t + props.bucketMs;
  const values = pts.map((p) => p.v).filter((v): v is number => v !== null);
  const ticks = yTicks(Math.max(props.minTop ?? 0, ...values, 0), 4, props.integer);
  const yMax = ticks.at(-1)!;
  const x = (t: number) => M.l + ((t - from) / (to - from)) * PW;
  const y = (v: number) => M.t + PH - (Math.min(v, yMax) / yMax) * PH;
  const base = M.t + PH;
  const slot = PW / pts.length;
  const tone = props.tone ?? "accent";
  const xt = xTicks(from, to);
  const xStep = xt.length > 1 ? xt[1]! - xt[0]! : props.bucketMs;

  let marks: unknown;
  if (props.kind === "columns") {
    const w = Math.max(1, Math.min(24, slot - 2));
    marks = pts.map((p) => {
      const v = p.v ?? 0;
      return v > 0 ? <path class={tone === "bad" ? "bar-bad" : "bar"} d={columnPath(r1(x(p.t) + (slot - w) / 2), r1(y(v)), r1(w), base)} /> : null;
    });
  } else {
    const cx = (p: TimePoint) => r1(x(p.t) + slot / 2);
    marks = splitAtGaps(pts).map((seg) =>
      seg.length > 1 ? (
        <path class={tone === "bad" ? "series-bad" : "series-1"} stroke-linejoin="round" stroke-linecap="round"
          d={seg.map((p, i) => `${i ? "L" : "M"}${cx(p)},${r1(y(p.v!))}`).join("")} />
      ) : (
        <circle class={`point ${tone}`} cx={cx(seg[0]!)} cy={r1(y(seg[0]!.v!))} r="4" />
      ),
    );
  }

  return (
    <figure class="chart-figure">
      <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.label}>
        {ticks.map((t) => (
          <>
            <line class="grid-line" x1={M.l} x2={W - M.r} y1={r1(y(t))} y2={r1(y(t))} />
            <text class="axis-label" x={M.l - 8} y={r1(y(t)) + 4} text-anchor="end">{props.format(t)}</text>
          </>
        ))}
        {xt.map((t) => (
          <text class="axis-label" x={r1(x(t))} y={H - 8} text-anchor="middle">{timeLabel(t, to - from, xStep)}</text>
        ))}
        {marks}
        {pts.map((p) => (
          <rect class="hit" x={r1(x(p.t))} y={M.t} width={r1(slot)} height={PH}>
            <title>{`${bucketLabel(p.t, props.bucketMs)}: ${p.v === null ? "keine Daten" : props.format(p.v)}`}</title>
          </rect>
        ))}
      </svg>
      {props.table !== false && (
        <details class="chart-data">
          <summary>Werte als Tabelle</summary>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Zeit</th><th class="num">{props.label}</th></tr></thead>
              <tbody>
                {pts.map((p) => (
                  <tr><td class="small">{bucketLabel(p.t, props.bucketMs)}</td><td class="num">{p.v === null ? "–" : props.format(p.v)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

/**
 * A tiny bar sparkline for table rows (e.g. occurrences per hour over 24 h): no axes, the label
 * carries the number, the newest bucket is accented. Styled by `.spark` in vantage.css.
 */
export function Sparkline(props: { values: number[]; label: string }) {
  const w = 96;
  const h = 22;
  const max = Math.max(1, ...props.values);
  const slot = w / Math.max(1, props.values.length);
  const bw = Math.max(1, slot - 1);
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={props.label}>
      <title>{props.label}</title>
      <line class="spark-base" x1="0" x2={w} y1={h - 0.5} y2={h - 0.5} />
      {props.values.map((v, i) => {
        const bh = Math.max(2, (v / max) * h);
        return v > 0 ? <rect class={i === props.values.length - 1 ? "now" : undefined} x={(i * slot).toFixed(1)} y={(h - bh).toFixed(1)} width={bw.toFixed(1)} height={bh.toFixed(1)} /> : null;
      })}
    </svg>
  );
}

/**
 * The trend under a stat tile's big number (CPU, memory, a disk over 24 h): one line over a soft area,
 * no axes, the scale from 0 to at least `max`, so 30 % fills a third of the height. Gaps stay gaps and
 * every bucket has a hover title. Stretches to the tile's width; its colour follows the value's state.
 */
export function Trend(props: { points: TimePoint[]; bucketMs: number; max: number; format: (v: number) => string; label: string; tone?: "warn" | "bad" }) {
  const pts = props.points;
  if (pts.length === 0) return null;
  const w = 300;
  const h = 48;
  const top = Math.max(props.max, ...pts.map((p) => p.v ?? 0));
  const slot = w / pts.length;
  const x = (t: number) => r1(((t - pts[0]!.t) / props.bucketMs) * slot + slot / 2);
  const y = (v: number) => r1(h - 1 - (v / top) * (h - 2));
  return (
    <svg class={props.tone ? `trend ${props.tone}` : "trend"} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={props.label}>
      <title>{props.label}</title>
      <line class="base" vector-effect="non-scaling-stroke" x1="0" x2={w} y1={h - 0.5} y2={h - 0.5} />
      {splitAtGaps(pts).map((seg) => {
        const line = seg.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v!)}`).join("");
        return seg.length > 1 ? (
          <>
            <path class="area" d={`${line}L${x(seg.at(-1)!.t)},${h}L${x(seg[0]!.t)},${h}Z`} />
            <path class="line" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" d={line} />
          </>
        ) : (
          <path class="line" vector-effect="non-scaling-stroke" stroke-linecap="round" d={`${line}h0.01`} />
        );
      })}
      {pts.map((p, i) => (
        <rect class="hit" x={r1(i * slot)} y="0" width={r1(slot)} height={h}>
          <title>{`${bucketLabel(p.t, props.bucketMs)}: ${p.v === null ? "keine Daten" : props.format(p.v)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/**
 * A strip of status cells (one per check or per day), newest on the right. Status colours are
 * reserved for state; each cell carries its state in words in the hover title.
 */
export function StatusStrip(props: { cells: { tone: "ok" | "bad" | "warn" | "none"; title: string }[]; slots?: number; label: string }) {
  const strip = stripLayout(props.slots, props.cells.length);
  return (
    <svg class="bars" viewBox={`0 0 ${W} 28`} preserveAspectRatio="none" role="img" aria-label={props.label}>
      <StripPadding strip={strip} />
      {props.cells.map((cell, i) => (
        <rect class={cell.tone} x={strip.x(i)} y="0" width={strip.width} height="28" rx="2">
          <title>{cell.title}</title>
        </rect>
      ))}
    </svg>
  );
}

/**
 * StatusStrip whose cells are links (e.g. one cell per test run → its run page). Adds the `idle`
 * tone for states that are neither good nor bad (an interrupted run), distinct from an empty slot.
 * Not role="img": keyboard and screen-reader users get one labelled link per cell.
 */
export function StatusStripLinks(props: {
  cells: { tone: "ok" | "bad" | "warn" | "idle" | "none"; title: string; href: string }[];
  slots?: number;
  label: string;
}) {
  const strip = stripLayout(props.slots, props.cells.length);
  return (
    <svg class="bars" viewBox={`0 0 ${W} 28`} preserveAspectRatio="none" role="group" aria-label={props.label}>
      <StripPadding strip={strip} />
      {props.cells.map((cell, i) => (
        <a href={cell.href} aria-label={cell.title}>
          <rect class={cell.tone} x={strip.x(i)} y="0" width={strip.width} height="28" rx="2">
            <title>{cell.title}</title>
          </rect>
        </a>
      ))}
    </svg>
  );
}

interface StripLayout {
  cellW: number;
  offset: number;
  width: number;
  /** x of the i-th real cell; empty slots fill the left so the newest cell is always rightmost. */
  x: (i: number) => number;
}

function stripLayout(slotsProp: number | undefined, count: number): StripLayout {
  const slots = Math.max(slotsProp ?? count, 1);
  const cellW = W / slots;
  const offset = slots - count;
  return { cellW, offset, width: Math.max(1, cellW - 2), x: (i) => (offset + i) * cellW + 1 };
}

function StripPadding(props: { strip: StripLayout }) {
  const { cellW, offset, width } = props.strip;
  return (
    <>
      {Array.from({ length: offset }, (_, i) => (
        <rect class="none" x={i * cellW + 1} y="0" width={width} height="28" rx="2"><title>keine Daten</title></rect>
      ))}
    </>
  );
}
