import { REGIONS } from './region.js';
import { SCHEMA_VERSION, STATUSES, OPEN_STATUSES, OPT_OUT_REASON, LOST_REASONS, BUSINESS_TYPES, RESERVATION_TOOLS } from './constants.js';
import { ValidationError } from './errors.js';
import { isDate } from './dates.js';

const OPT_OUT_ACTIVE = "Opt-out aktiv \u2013 erst aufheben, wenn der Betrieb wieder Kontakt m\xF6chte";
export const LEAD_FIELDS = {
  name: "",
  city: "",
  type: "Restaurant",
  status: "recherchiert",
  fit: 2,
  instagram: "",
  phone: "",
  email: "",
  website: "",
  person: "",
  currentTool: "unbekannt",
  hook: "",
  notes: "",
  nextStep: "",
  followUp: null,
  lostReason: null,
  region: "",
  // optional override; empty = inferred from city (see region.js)
  optOutAt: null
  // date the business asked not to be contacted again (revocation of contact)
};
export const str = (v) => v == null ? "" : String(v).trim();
export function normalizeLead(input, base = LEAD_FIELDS) {
  const out = {};
  for (const k of Object.keys(LEAD_FIELDS)) out[k] = k in input ? input[k] : k in base ? base[k] : LEAD_FIELDS[k];
  for (const k of ["name", "city", "instagram", "phone", "email", "website", "person", "hook", "notes", "nextStep"]) out[k] = str(out[k]);
  if (!out.name) throw new ValidationError("name", "Name fehlt");
  if (!STATUSES.has(out.status)) throw new ValidationError("status", "Unbekannter Status");
  out.fit = Math.min(3, Math.max(1, parseInt(out.fit, 10) || 2));
  if (!BUSINESS_TYPES.includes(out.type)) out.type = "Sonstiges";
  if (!RESERVATION_TOOLS.includes(out.currentTool)) out.currentTool = "unbekannt";
  out.followUp = isDate(out.followUp) ? out.followUp : null;
  out.optOutAt = isDate(out.optOutAt) ? out.optOutAt : null;
  out.region = REGIONS.includes(out.region) ? out.region : "";
  out.lostReason = out.status === "kein-interesse" && LOST_REASONS.includes(out.lostReason) ? out.lostReason : null;
  if (out.optOutAt && OPEN_STATUSES.has(out.status)) throw new ValidationError("status", OPT_OUT_ACTIVE);
  if (out.instagram && !out.instagram.startsWith("@")) out.instagram = "@" + out.instagram;
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new ValidationError("email", "E-Mail ung\xFCltig");
  if (out.website && !/^https?:\/\//.test(out.website)) out.website = "https://" + out.website;
  return out;
}
export function newLeadRecord(input, { id, now }) {
  return { id, schemaVersion: SCHEMA_VERSION, ...normalizeLead(input), createdAt: now, updatedAt: now };
}
export const isOpen = (lead) => OPEN_STATUSES.has(lead.status);
export const isDue = (lead, today) => isOpen(lead) && !!lead.followUp && lead.followUp <= today;
export function transition(lead, status) {
  if (!STATUSES.has(status)) throw new ValidationError("status", "Unbekannter Status");
  if (lead.optOutAt && OPEN_STATUSES.has(status)) throw new ValidationError("status", OPT_OUT_ACTIVE);
  const patch = { status };
  if (!OPEN_STATUSES.has(status)) patch.followUp = null;
  if (status !== "kein-interesse") patch.lostReason = null;
  return patch;
}
export function lostReasonPatch(lead, reason) {
  if (lead.status !== "kein-interesse") throw new ValidationError("lostReason", "Nur bei \u201EKein Interesse\u201C");
  if (!LOST_REASONS.includes(reason)) throw new ValidationError("lostReason", "Unbekannter Grund");
  return { lostReason: reason };
}
export function followUpPatch(date) {
  if (date && !isDate(date)) throw new ValidationError("followUp", "Datum ung\xFCltig");
  return { followUp: date || null };
}
export function optOutPatch(date) {
  if (!isDate(date)) throw new ValidationError("optOutAt", "Datum ung\xFCltig");
  return { optOutAt: date, status: "kein-interesse", lostReason: OPT_OUT_REASON, followUp: null, nextStep: "" };
}
export function clearOptOutPatch(lead) {
  if (!lead.optOutAt) throw new ValidationError("optOutAt", "Kein Opt-out gesetzt");
  return { optOutAt: null };
}
