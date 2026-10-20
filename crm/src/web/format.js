import { addDays, daysBetween } from '../domain/dates.js';
import { STAGE_LABEL, FIELD_LABEL } from '../domain/constants.js';

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
// Statuses before 1.4.0, still in the history of versions written then.
const LEGACY_STAGE_LABEL = { recherchiert: "Recherchiert", antwort: "Antwort", demo: "Gespr\xE4ch/Demo", onboarding: "Onboarding", "kein-interesse": "Kein Interesse" };
const STATUS_LABEL = { ...LEGACY_STAGE_LABEL, ...STAGE_LABEL };
const shown = (key, v) => {
  if (v == null || v === "") return "\u2013";
  if (key === "status") return STATUS_LABEL[v] || v;
  if (key === "followUp" || key === "optOutAt" || key === "contactedAt") return fmtDate(v);
  const t = String(v).replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 59) + "\u2026" : t;
};
/** What one history entry of a lead did, as lines of text; none when only hidden fields changed (updatedAt after a logged contact). */
export function describeChange(entry) {
  if (!entry.before) return ["Angelegt"];
  if (entry.deleted && !entry.wasDeleted) return ["In den Papierkorb gelegt"];
  if (!entry.deleted && entry.wasDeleted) return ["Wiederhergestellt"];
  // The notes text and the notes list, changed together when a note of the text is changed, read as one line.
  return [...new Set(Object.keys(FIELD_LABEL).filter((k) => JSON.stringify(entry.before[k] ?? null) !== JSON.stringify(entry.after[k] ?? null))
    .map((k) => k === "account" ? "Kundenakte ge\xE4ndert" : k === "customer" ? "Betreuung ge\xE4ndert" : k === "todos" ? "Todos ge\xE4ndert" : k === "notes" || k === "noteEntries" ? "Notizen ge\xE4ndert" : `${FIELD_LABEL[k]}: ${shown(k, entry.before[k])} \u2192 ${shown(k, entry.after[k])}`))];
}
/** The status move of a history entry, for the lead's feed: "Status Neu → Kontaktiert", "Angelegt", or "" for none. */
export function statusMove(entry) {
  if (!entry.before) return entry.after ? "Angelegt" : "";
  if (!entry.after || entry.deleted || entry.before.status === entry.after.status) return "";
  const reason = entry.after.status === "disqualifiziert" && entry.after.lostReason ? ` (${entry.after.lostReason})` : "";
  return `Status ${shown("status", entry.before.status)} → ${shown("status", entry.after.status)}${reason}`;
}
/** "jo@bookete.com (mcp)" → "jo (mcp)". */
export const actorName = (actor) => String(actor || "").replace(/@\S+/, "");
export const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("de-AT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
