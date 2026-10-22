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
/** The Monday of the week a day is in. */
export const weekStart = (s) => addDays(s, -((parse(s).getDay() + 6) % 7));
/** The same day `n` months on; past the end of a shorter month, its last day (31.01. + 1 month is 28.02. or 29.02.). */
export function addMonths(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(y, m - 1 + n, 1, 12);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12).getDate();
  first.setDate(Math.min(d, last));
  return toDateString(first);
}
