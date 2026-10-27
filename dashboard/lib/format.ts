/** Pure formatters shared by the UI; no Date.now() unless `now` is omitted. */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3]];

export function relativeTime(iso: string | number | Date, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = t - now;
  if (Math.abs(d) < 5e3) return "just now";
  const [unit, ms] = UNITS.find(([, ms]) => Math.abs(d) >= ms) ?? UNITS[UNITS.length - 1];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(d / ms), unit);
}

export function absoluteTime(iso: string | number | Date): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export const formatNumber = (n: number) => new Intl.NumberFormat("en").format(n);

/** "em_01HZXY…K9QF": keeps both ends of an id readable. */
export function truncateId(id: string, head = 8, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
