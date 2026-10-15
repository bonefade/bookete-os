import { addDays, daysBetween } from '../domain/dates.js';

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmtDate = (d) => d ? (new Date(d + "T12:00:00")).toLocaleDateString("de-AT", { weekday: "short", day: "numeric", month: "short" }) : "";
export function relDate(d, today) {
  if (!d) return "";
  if (d === today) return "heute";
  if (d === addDays(today, 1)) return "morgen";
  if (d < today) {
    const n = daysBetween(d, today);
    return n === 1 ? "seit gestern" : `seit ${n} Tagen`;
  }
  return fmtDate(d);
}
export const options = (arr, sel) => arr.map((v) => {
  const [k, l] = Array.isArray(v) ? v : [v, v];
  return `<option value="${esc(k)}"${String(k) === String(sel) ? " selected" : ""}>${esc(l)}</option>`;
}).join("");
