import { REGIONS } from './region.js';
import { SCHEMA_VERSION, STATUSES, PIPELINE_STATUSES, OPT_OUT_REASON, LOST_REASONS, BUSINESS_TYPES, RESERVATION_TOOLS } from './constants.js';
import { ValidationError } from './errors.js';
import { isDate } from './dates.js';

const OPT_OUT_ACTIVE = "Opt-out aktiv \u2013 erst aufheben, wenn der Betrieb wieder Kontakt m\xF6chte";
export const LEAD_FIELDS = {
  name: "",
  city: "",
  type: "Restaurant",
  status: "neu",
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
  optOutAt: null,
  // date the business asked not to be contacted again (revocation of contact)
  contactedAt: null
  // date of the first contact either way; null exactly while the lead is neu (a disqualified lead may have either)
};
/** Trimmed text, "" for none; `max` caps its length. */
export const str = (v, max = Infinity) => (v == null ? "" : String(v).trim()).slice(0, max);
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
/**
 * The one place the lead rules live: every write (web, MCP, import) runs the merged lead through here.
 * `today` dates a first contact that a status change implies.
 */
export function normalizeLead(input, base = LEAD_FIELDS, today) {
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
  out.contactedAt = isDate(out.contactedAt) ? out.contactedAt : null;
  out.region = REGIONS.includes(out.region) ? out.region : "";
  if (out.status === "disqualifiziert") {
    if (!LOST_REASONS.includes(out.lostReason)) throw new ValidationError("lostReason", "Bitte einen Grund w\xE4hlen");
    out.followUp = null;
    // Picking the opt-out reason is an opt-out, so the business can never be contacted by mistake.
    if (out.lostReason === OPT_OUT_REASON && !out.optOutAt) out.optOutAt = today;
  } else out.lostReason = null;
  if (out.optOutAt) {
    if (PIPELINE_STATUSES.has(out.status)) throw new ValidationError("status", OPT_OUT_ACTIVE);
    if (out.status === "disqualifiziert" && out.lostReason !== OPT_OUT_REASON) throw new ValidationError("lostReason", OPT_OUT_ACTIVE);
  }
  if (base.contactedAt && !out.contactedAt) throw new ValidationError("contactedAt", "Der Erstkontakt l\xE4sst sich nicht l\xF6schen");
  if (out.contactedAt > today) throw new ValidationError("contactedAt", "Der Erstkontakt liegt in der Zukunft");
  if (out.status === "neu" && out.contactedAt) {
    // A first contact recorded on a Neu lead moves it on; asking for Neu on a contacted lead is refused.
    if ("status" in input) throw new ValidationError("contactedAt", "Schon kontaktiert \u2013 zur\xFCck auf \u201ENeu\u201C geht nicht");
    out.status = "kontaktiert";
  }
  if (out.status !== "neu" && out.status !== "disqualifiziert" && !out.contactedAt) out.contactedAt = today;
  if (out.instagram && !out.instagram.startsWith("@")) out.instagram = "@" + out.instagram;
  if (out.email && !isEmail(out.email)) throw new ValidationError("email", "E-Mail ung\xFCltig");
  if (out.website && !/^https?:\/\//.test(out.website)) out.website = "https://" + out.website;
  return out;
}
export function newLeadRecord(input, { id, now, today }) {
  return { id, schemaVersion: SCHEMA_VERSION, ...normalizeLead(input, LEAD_FIELDS, today), createdAt: now, updatedAt: now };
}
/** In the pipeline: neu, kontaktiert, qualifiziert. */
export const isPipeline = (lead) => PIPELINE_STATUSES.has(lead.status);
/** Everything but a disqualified lead can have a follow-up and a next step; a Kunde has onboarding to-dos. */
export const takesFollowUp = (lead) => lead.status !== "disqualifiziert";
export const isDue = (lead, today) => takesFollowUp(lead) && !!lead.followUp && lead.followUp <= today;
/** Status and reason as one change; normalizeLead checks the pair. */
export function transition(status, reason = null) {
  if (reason && status !== "disqualifiziert") throw new ValidationError("lostReason", "Ein Grund geh\xF6rt nur zu \u201EDisqualifiziert\u201C");
  return { status, lostReason: reason };
}
export function lostReasonPatch(lead, reason) {
  if (lead.status !== "disqualifiziert") throw new ValidationError("lostReason", "Nur bei \u201EDisqualifiziert\u201C");
  return { lostReason: reason };
}
export function followUpPatch(lead, date) {
  if (date && !isDate(date)) throw new ValidationError("followUp", "Datum ung\xFCltig");
  if (date && !takesFollowUp(lead)) throw new ValidationError("followUp", "Disqualifiziert \u2013 kein Nachfassen. Erst den Status \xE4ndern.");
  return { followUp: date || null };
}
export function optOutPatch(date) {
  if (!isDate(date)) throw new ValidationError("optOutAt", "Datum ung\xFCltig");
  return { optOutAt: date, status: "disqualifiziert", lostReason: OPT_OUT_REASON, followUp: null, nextStep: "" };
}
/** The business wants contact again: a lead closed by the opt-out reopens as kontaktiert. */
export function clearOptOutPatch(lead) {
  if (!lead.optOutAt) throw new ValidationError("optOutAt", "Kein Opt-out gesetzt");
  return lead.status === "disqualifiziert" ? { optOutAt: null, status: "kontaktiert", lostReason: null } : { optOutAt: null };
}

// Before 1.4.0 (schemaVersion 2): seven statuses and reasons that were no reasons.
const LEGACY_STATUS = { recherchiert: "neu", antwort: "kontaktiert", demo: "qualifiziert", onboarding: "kunde" };
const LEGACY_REASON = { "Zu wenig Reservierungen": "Zu klein", "Telefon reicht ihnen": "Kein Bedarf" };
// Old statuses that mean someone was in contact. "Keine Antwort" leads were emailed.
const CONTACTED_BEFORE = new Set(["kontaktiert", "antwort", "demo", "onboarding", "kunde", "qualifiziert"]);
// The UTC day of a timestamp, as migration 0003 cuts it; a timestamp an old import stored in another format gives none.
const dayOf = (iso) => (typeof iso === "string" && isDate(iso.slice(0, 10)) ? iso.slice(0, 10) : null);

/** On an upgraded lead: the lead as stored. Writes diff against it, so the first write stores the whole upgrade. */
export const STORED = Symbol("stored");

/**
 * Turns a lead stored before 1.4.0 into a 1.4.0 lead; a current one comes back as it is. `firstContact` is the date
 * of the lead's earliest activity, either way, where known. Runs on a lead that 1.4.0 already wrote parts of, too:
 * a status from the new list and a stored contactedAt are kept. Migration 0003 applies the same rule in SQL.
 */
export function upgradeLead(lead, firstContact = null) {
  // A status outside the five is a 1.3 write after 0003 (a deploy out of order, or a rollback): upgraded all the same.
  if (lead.schemaVersion >= SCHEMA_VERSION && STATUSES.has(lead.status)) return lead;
  const legacyNo = lead.status === "kein-interesse";
  const contactedAt = lead.contactedAt || firstContact || (CONTACTED_BEFORE.has(lead.status) || legacyNo && lead.lostReason === "Keine Antwort" ? dayOf(lead.createdAt) : null);
  const reason = Object.hasOwn(LEGACY_REASON, lead.lostReason) ? LEGACY_REASON[lead.lostReason] : lead.lostReason;
  const optOutAt = lead.optOutAt || (reason === OPT_OUT_REASON ? dayOf(lead.updatedAt) || dayOf(lead.createdAt) : null);
  let status = legacyNo ? (LOST_REASONS.includes(reason) ? "disqualifiziert" : "neu") : Object.hasOwn(LEGACY_STATUS, lead.status) ? LEGACY_STATUS[lead.status] : lead.status;
  if (optOutAt && status !== "kunde") status = "disqualifiziert";
  if (status === "neu" && contactedAt) status = "kontaktiert";
  const closed = status === "disqualifiziert";
  const upgraded = {
    ...lead, status, contactedAt, optOutAt: optOutAt || null,
    lostReason: closed ? (optOutAt ? OPT_OUT_REASON : reason) : null,
    followUp: closed ? null : lead.followUp ?? null,
    schemaVersion: SCHEMA_VERSION,
  };
  return Object.defineProperty(upgraded, STORED, { value: lead });
}
