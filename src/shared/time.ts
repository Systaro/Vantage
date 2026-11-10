/** Europe/Berlin wall-clock helpers. Every user-facing time in Vantage is Berlin time. */

const TZ = "Europe/Berlin";
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function wallClock(t: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}

/** Milliseconds Berlin wall-clock time is ahead of UTC at instant `t`. */
export function berlinOffset(t: number): number {
  const w = wallClock(t);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/** `2026-10-12T14:30` as Berlin wall-clock time → epoch ms, or null when it is not such a value. */
export function parseBerlinLocal(value: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? "");
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Twice, so a guess on the far side of a DST switch is corrected.
  let t = asUtc - berlinOffset(asUtc);
  t = asUtc - berlinOffset(t);
  return t;
}

/** Epoch ms → value for `<input type="datetime-local">` in Berlin time. */
export function berlinLocalInput(t: number): string {
  const w = wallClock(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${two(w.mo)}-${two(w.d)}T${two(w.h)}:${two(w.mi)}`;
}
