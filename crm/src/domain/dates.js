export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const pad = (n) => String(n).padStart(2, "0");
export const toDateString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => new Date(s + "T12:00:00");
export function addDays(date, n) {
  const d = parse(date);
  d.setDate(d.getDate() + n);
  return toDateString(d);
}
export function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / 864e5);
}
export const isDate = (s) => typeof s === "string" && DATE_RE.test(s);
/** 2026-10-20 as 20.10.2026, for text that is stored. */
export const dayLabel = (s) => s.split("-").reverse().join(".");
