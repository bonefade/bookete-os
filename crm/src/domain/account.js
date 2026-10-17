import { ValidationError } from './errors.js';
import { isDate } from './dates.js';
import { str, isEmail } from './lead.js';

/**
 * The Kundenakte: what we deliver to a business, the systems it runs and who looks after them.
 * It lives on the lead record, so the write guard, history, trash, erase and backup cover it.
 * No passwords: `systems.access` says where logins are kept, never the logins themselves.
 * Empty is "", never null: the store writes a patch as RFC 7396, which drops a null nested in an object.
 */
export const SERVICE_KINDS = ["bookete", "Website", "bookete-Integration", "Google-Profil", "Weiteres"];
export const SERVICE_STATES = [["geplant", "Geplant"], ["in-arbeit", "In Arbeit"], ["live", "Live"], ["beendet", "Beendet"]];
export const OWNERS = [["wir", "Wir (bookete)"], ["Kunde", "Kunde"], ["Agentur", "Agentur"], ["unbekannt", "Unbekannt"]];
/** Systems that someone runs: what it is, and the contact who looks after it. */
export const SYSTEMS = [["domain", "Domain"], ["dns", "DNS"], ["hosting", "Hosting"], ["email", "E-Mail"], ["website", "Website / CMS"], ["pos", "Kassensystem"]];
export const ACCOUNT_LIMIT = 50;
export const EMPTY_ACCOUNT = {
  services: [],
  systems: { ...Object.fromEntries(SYSTEMS.map(([k]) => [k, { what: "", by: "" }])), domainOwner: "unbekannt", registrar: "", googleProfile: "unbekannt", access: "" },
  contacts: [],
};

/** Notes keep their line breaks; every other field is one line, so each writer stores what the form shows. */
const NOTE_MAX = 2000;
const line = (v, max) => str(String(v ?? "").replace(/\s*[\r\n]\s*/g, " "), max);
/** A value from `allowed`, or `empty` when none is given. Anything else is refused, never replaced. */
function oneOf(v, allowed, field, empty) {
  if (v == null || v === "") return empty;
  if (!allowed.includes(v)) throw new ValidationError(field, `Unbekannter Wert \u201E${line(v, 40)}\u201C`);
  return v;
}
const keys = (pairs) => pairs.map(([k]) => k);
function dateOrEmpty(v, field) {
  const d = line(v, 20);
  if (d && !isDate(d)) throw new ValidationError(field, `Datum \u201E${d}\u201C ung\xFCltig`);
  return d;
}

function list(items, field, newId, entry) {
  const out = (Array.isArray(items) ? items : []).map((x) => ({ id: str(x?.id, 100) || newId(), ...entry(x || {}) }));
  if (out.length > ACCOUNT_LIMIT) throw new ValidationError(field, `H\xF6chstens ${ACCOUNT_LIMIT} Eintr\xE4ge`);
  if (new Set(out.map((x) => x.id)).size !== out.length) throw new ValidationError(field, "Doppelter Eintrag");
  return out;
}

export function normalizeAccount(input, newId) {
  const a = input || {};
  const services = list(a.services, "services", newId, (s) => {
    const service = {
      kind: oneOf(s.kind, SERVICE_KINDS, "services", ""),
      // A service without a state is planned.
      state: oneOf(s.state, keys(SERVICE_STATES), "services", "geplant"),
      since: dateOrEmpty(s.since, "services"),
      goLive: dateOrEmpty(s.goLive, "services"),
      contractEnd: dateOrEmpty(s.contractEnd, "services"),
      price: line(s.price, 200),
      note: str(s.note, NOTE_MAX),
    };
    if (!service.kind) throw new ValidationError("services", "Leistung ohne Art");
    return service;
  });
  const contacts = list(a.contacts, "contacts", newId, (c) => {
    const contact = { name: line(c.name, 200), company: line(c.company, 200), role: line(c.role, 200), handles: line(c.handles, 500), email: line(c.email, 200), phone: line(c.phone, 100), note: str(c.note, NOTE_MAX) };
    if (!contact.name) throw new ValidationError("contacts", "Kontakt ohne Namen");
    if (contact.email && !isEmail(contact.email)) throw new ValidationError("contacts", `E-Mail von ${contact.name} ung\xFCltig`);
    return contact;
  });
  const known = new Set(contacts.map((c) => c.id));
  const sys = a.systems || {};
  const systems = {
    ...Object.fromEntries(SYSTEMS.map(([k]) => [k, { what: line(sys[k]?.what, 200), by: known.has(sys[k]?.by) ? sys[k].by : "" }])),
    domainOwner: oneOf(sys.domainOwner, keys(OWNERS), "systems", "unbekannt"),
    registrar: line(sys.registrar, 200),
    googleProfile: oneOf(sys.googleProfile, keys(OWNERS), "systems", "unbekannt"),
    access: line(sys.access, 500),
  };
  return { services, systems, contacts };
}

/**
 * A lead's Kundenakte in today's shape, so one stored before a part was added compares and shows like a new one.
 * A lead that never had one has the empty one. Stored entries all have their id, so no new id is needed.
 */
export const accountOf = (lead) => normalizeAccount(lead.account);
/** Shown on the lead page once a deal is near (Qualifiziert, Kunde) or as soon as anything is in it. */
export const showsAccount = (lead) => lead.status === "qualifiziert" || lead.status === "kunde" || JSON.stringify(accountOf(lead)) !== JSON.stringify(EMPTY_ACCOUNT);
/**
 * The given parts over the stored Kundenakte: a list replaces the stored list; systems, and each system, change field
 * by field. A write that leaves out the contact who runs a system must give that system's `by` too, so a contact
 * re-sent without its id never empties "betreut von" unnoticed.
 */
export function mergeAccount(stored, parts) {
  const systems = { ...stored.systems, ...parts.systems };
  for (const [k] of SYSTEMS) if (parts.systems?.[k]) systems[k] = { ...stored.systems[k], ...parts.systems[k] };
  const contacts = parts.contacts ?? stored.contacts;
  for (const [k, label] of SYSTEMS) {
    const by = stored.systems[k].by;
    if (by && parts.systems?.[k]?.by === undefined && !contacts.some((c) => c.id === by)) {
      const name = stored.contacts.find((c) => c.id === by).name;
      throw new ValidationError("contacts", `${name} betreut ${label}, fehlt aber in den Kontakten: den Kontakt mit seiner id senden oder bei ${label} \u201Ebetreut von\u201C angeben`);
    }
  }
  return { services: parts.services ?? stored.services, systems, contacts };
}

/** The systems a contact looks after, by label. */
export const handledBy = (account, contactId) => SYSTEMS.filter(([k]) => account.systems[k]?.by === contactId).map(([, label]) => label);
