import { REGIONS } from './region.js';
import { SCHEMA_VERSION, STATUSES, PIPELINE_STATUSES, OPT_OUT_REASON, LOST_REASONS, BUSINESS_TYPES, RESERVATION_TOOLS, FIELD_LABEL } from './constants.js';
import { ValidationError } from './errors.js';
import { isDate, dayLabel } from './dates.js';

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
  // the notes as one text, from before 1.25.0; since then each note is an entry in noteEntries (notes.js)
  nextStep: "",
  followUp: null,
  lostReason: null,
  region: "",
  // optional override; empty = inferred from city (see region.js)
  optOutAt: null,
  // date the business asked not to be contacted again (revocation of contact)
  contactedAt: null,
  // date we first spoke with them (spokeWith); null exactly while the lead is neu (a disqualified lead may have either)
  wonAt: null
  // date the lead became kunde; null on any other status, and on a customer from before 1.8.0
};
/** Trimmed text, "" for none; `max` caps its length. */
export const str = (v, max = Infinity) => (v == null ? "" : String(v).trim()).slice(0, max);
/** One line of text: every run of white space, line breaks included, one space; trimmed and capped as `str`. */
export const oneLine = (v, max = Infinity) => str(String(v ?? "").replace(/\s+/g, " "), max);
/**
 * A reservation system as stored: one of RESERVATION_TOOLS or of the `known` ones other leads have, spelled as there
 * whatever the case, or any other name typed (a system new to us, such as Respilot); none is "unbekannt".
 */
export function toolName(v, known = []) {
  const name = oneLine(v, 60);
  return !name ? "unbekannt" : [...RESERVATION_TOOLS, ...known].find((t) => t.toLowerCase() === name.toLowerCase()) || name;
}
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
/**
 * A Kontakt: a partner, an association or a person we talk to beside the restaurants. A record in the leads like a
 * Betrieb, with its notes, logged contacts, todos, next step and the people at it (account.contacts), but none of a
 * restaurant's parts: no status, first contact, opt-out, fit, type, system or hook, and a topic (Thema) instead.
 * Its kind is set when it is made and never changes; a record without one is a Betrieb.
 */
export const KINDS = ["betrieb", "kontakt"];
export const isContact = (lead) => lead.kind === "kontakt";
export const TOPIC_MAX = 60;
// What a Kontakt has none of, as it holds them; a Betrieb's fields only, so a write that gives one is refused.
const NOT_ON_CONTACT = { status: null, lostReason: null, optOutAt: null, contactedAt: null, wonAt: null, fit: null, type: "", currentTool: "", hook: "" };
/**
 * The one place the lead rules live: every write (web, MCP, import) runs the merged lead through here.
 * `today` dates a first contact that a status change implies. A Betrieb has no `kind` or `topic` stored, so the
 * records from before stay as they were.
 */
export function normalizeLead(input, base = LEAD_FIELDS, today) {
  if ("kind" in input && (input.kind || "betrieb") !== (base.kind || "betrieb")) throw new ValidationError("kind", "Ein Betrieb bleibt ein Betrieb, ein Kontakt ein Kontakt");
  const out = {};
  for (const k of Object.keys(LEAD_FIELDS)) out[k] = k in input ? input[k] : k in base ? base[k] : LEAD_FIELDS[k];
  for (const k of ["name", "city", "instagram", "phone", "email", "website", "person", "hook", "notes", "nextStep"]) out[k] = str(out[k]);
  if (!out.name) throw new ValidationError("name", "Name fehlt");
  out.followUp = isDate(out.followUp) ? out.followUp : null;
  out.region = REGIONS.includes(out.region) ? out.region : "";
  if (out.instagram && !out.instagram.startsWith("@")) out.instagram = "@" + out.instagram;
  if (out.email && !isEmail(out.email)) throw new ValidationError("email", "E-Mail ung\xFCltig");
  if (out.website && !/^https?:\/\//.test(out.website)) out.website = "https://" + out.website;
  if (isContact(base)) {
    for (const [k, none] of Object.entries(NOT_ON_CONTACT)) {
      if (k in input && input[k] != null && input[k] !== none) throw new ValidationError(k, `${FIELD_LABEL[k] || k} hat nur ein Betrieb, kein Kontakt`);
      out[k] = none;
    }
    return { ...out, kind: "kontakt", topic: oneLine("topic" in input ? input.topic : base.topic, TOPIC_MAX) };
  }
  if (oneLine(input.topic)) throw new ValidationError("topic", "Ein Thema hat nur ein Kontakt");
  if (!STATUSES.has(out.status)) throw new ValidationError("status", "Unbekannter Status");
  out.fit = Math.min(3, Math.max(1, parseInt(out.fit, 10) || 2));
  if (!BUSINESS_TYPES.includes(out.type)) out.type = "Sonstiges";
  out.currentTool = toolName(out.currentTool);
  out.optOutAt = isDate(out.optOutAt) ? out.optOutAt : null;
  out.contactedAt = isDate(out.contactedAt) ? out.contactedAt : null;
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
  // Only going back to Neu clears it, which the use case allows only while nobody has spoken with them.
  if (base.contactedAt && !out.contactedAt && out.status !== "neu") throw new ValidationError("contactedAt", "Der Erstkontakt l\xE4sst sich nicht l\xF6schen");
  if (out.contactedAt > today) throw new ValidationError("contactedAt", "Der Erstkontakt liegt in der Zukunft");
  if (out.status === "neu" && out.contactedAt) {
    // A first contact recorded on a Neu lead moves it on; asking for Neu on a lead spoken with is refused.
    if ("status" in input) throw new ValidationError("contactedAt", "Schon mit ihnen gesprochen \u2013 zur\xFCck auf \u201ENeu\u201C geht nicht");
    out.status = "kontaktiert";
  }
  if (out.status !== "neu" && out.status !== "disqualifiziert" && !out.contactedAt) out.contactedAt = today;
  // A Neu lead has no date: nobody has spoken with them, so nothing is agreed, and Heute stays clear of them.
  if (out.status === "neu") out.followUp = null;
  // Dated by the change to Kunde, so a status tapped by mistake and set back is not counted as won.
  out.wonAt = out.status !== "kunde" ? null : base.status === "kunde" ? (isDate(out.wonAt) ? out.wonAt : null) : today;
  return out;
}
/** In the pipeline: neu, kontaktiert, qualifiziert. */
export const isPipeline = (lead) => PIPELINE_STATUSES.has(lead.status);
/** Everything but a disqualified lead can have a follow-up and a next step; a Kunde has onboarding to-dos. */
export const takesFollowUp = (lead) => lead.status !== "disqualifiziert";
/** A follow-up date, beside the next step: not on a disqualified lead, nor on a Neu one (normalizeLead). */
export const takesDate = (lead) => takesFollowUp(lead) && lead.status !== "neu";
/**
 * Mail to a Kunde is service mail and carries no unsubscribe link: one click would otherwise block every mail and call
 * to a customer. Mail to a Kontakt is no marketing either.
 */
export const getsUnsubscribeLink = (lead) => lead.status !== "kunde" && !isContact(lead);
/**
 * An opt-out holds for the email address too: the same business added again under a new id (a new scrape, a
 * duplicate) is not mailed again. Addresses compare trimmed and with A–Z lower-cased, as the store's query does
 * with SQLite's trim() and lower() (store.optOutByAddress).
 */
export const addressKey = (email) => str(email).replace(/[A-Z]/g, (c) => c.toLowerCase());
/** The business among `leads` with an opt-out that holds this lead's email address, if any. */
export const optOutByAddress = (leads, lead) => lead.email ? leads.find((x) => x.optOutAt && addressKey(x.email) === addressKey(lead.email)) : undefined;
/**
 * Whether another business's opt-out closes this record's address too: on every record but a Kunde, whose service mail
 * still goes out. A Kontakt is held to it although its mail carries no Abmeldelink: an address someone asked us not
 * to mail stays closed whichever record holds it.
 */
export const heldToOptOuts = (lead) => lead.status !== "kunde";
/**
 * The business whose opt-out closes this lead's address: the lead itself, or, where it is held to them
 * (heldToOptOuts), the one with an opt-out that `holderOf` gives for its address key.
 */
const closedBy = (lead, holderOf) => lead.optOutAt ? lead : heldToOptOuts(lead) && lead.email ? holderOf(addressKey(lead.email)) : undefined;
/** The business whose opt-out closes this lead's address, among `leads` (closedBy). */
export const mailClosedBy = (leads, lead) => closedBy(lead, (key) => optOutByAddress(leads, { email: key }));
/** Whether mail may go to this lead: it has an address that no opt-out closes (closedBy). `closed`: the address keys the businesses with an opt-out hold. */
export const addressOpen = (lead, closed) => !!lead.email && !closedBy(lead, (key) => closed.has(key));
/** Why no mail may go to this address: `holder` has an opt-out and the same address; `trashed`, it is in the Papierkorb. */
export const addressOptOutText = (holder, trashed = false) => `Keine E-Mail an diese Adresse: \u201E${holder.name}\u201C${trashed ? " (im Papierkorb)" : ""} hat dieselbe Adresse und ein Opt-out seit ${dayLabel(holder.optOutAt)}`;
/** Due: a lead that takes a date, with one today or before; a Neu lead's date stored before 1.24.0 is none. */
export const isDue = (lead, today) => takesDate(lead) && !!lead.followUp && lead.followUp <= today;
/** A lead in work with no date for what comes next: Kontaktiert or Qualifiziert without a follow-up. Neu, Kunde and Disqualifiziert are never short of one. */
export const lacksNextStep = (lead) => (lead.status === "kontaktiert" || lead.status === "qualifiziert") && !lead.followUp;
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
  if (date && !takesDate(lead)) throw new ValidationError("followUp", "Ein neuer Lead hat kein Datum. F\xFCr etwas mit Datum ein Todo anlegen.");
  return { followUp: date || null };
}
/**
 * An opt-out closes a lead with the opt-out reason. A customer stays Kunde with its win date and next step;
 * only the follow-up date goes, since nobody may contact them.
 */
export function optOutPatch(date, lead) {
  if (!isDate(date)) throw new ValidationError("optOutAt", "Datum ung\xFCltig");
  if (lead.status === "kunde") return { optOutAt: date, followUp: null };
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

/**
 * Turns a lead stored before 1.4.0 into a 1.4.0 lead; a current one comes back as it is. `firstContact` is the date
 * of the lead's earliest activity, either way, where known. Runs on a lead that 1.4.0 already wrote parts of, too:
 * a status from the new list and a stored contactedAt are kept. Migration 0003 applied the same rule in SQL to the
 * stored leads; this now upgrades the leads of an old backup, with their activities (chunkBackup).
 */
export function upgradeLead(lead, firstContact = null) {
  // A Kontakt came after 1.4.0 and has no status to upgrade.
  if (isContact(lead)) return lead;
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
  return {
    ...lead, status, contactedAt, optOutAt: optOutAt || null,
    lostReason: closed ? (optOutAt ? OPT_OUT_REASON : reason) : null,
    followUp: closed ? null : lead.followUp ?? null,
    schemaVersion: SCHEMA_VERSION,
  };
}
