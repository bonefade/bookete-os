import { ValidationError } from './errors.js';
import { str, isEmail, addressKey } from './lead.js';

/**
 * The Kundenakte: the systems a business runs, who looks after them, and the people to reach. What we deliver is the
 * customer's package (customer.js).
 * It lives on the lead record, so the write guard, history, trash, erase and backup cover it.
 * No passwords: `systems.access` says where logins are kept, never the logins themselves.
 * Empty is "", never null: the store writes a patch as RFC 7396, which drops a null nested in an object.
 */
/** Systems that someone runs: what it is (for the domain also whose it is and where it is registered), and the contact who looks after it. */
export const SYSTEMS = [["domain", "Domain"], ["dns", "DNS"], ["website", "Website / Hosting"], ["email", "E-Mail"]];
export const ACCOUNT_LIMIT = 50;
export const EMPTY_ACCOUNT = {
  systems: { ...Object.fromEntries(SYSTEMS.map(([k]) => [k, { what: "", by: "" }])), access: "" },
  contacts: [],
};

/** Notes keep their line breaks; every other field is one line, so each writer stores what the form shows. */
const NOTE_MAX = 2000;
const line = (v, max) => str(String(v ?? "").replace(/\s*[\r\n]\s*/g, " "), max);

function list(items, field, newId, entry) {
  const out = (Array.isArray(items) ? items : []).map((x) => ({ id: str(x?.id, 100) || newId(), ...entry(x || {}) }));
  if (out.length > ACCOUNT_LIMIT) throw new ValidationError(field, `H\xF6chstens ${ACCOUNT_LIMIT} Eintr\xE4ge`);
  if (new Set(out.map((x) => x.id)).size !== out.length) throw new ValidationError(field, "Doppelter Eintrag");
  return out;
}

/**
 * A Kundenakte in today's shape. What one stored before 1.27.0 holds besides (the services, hosting and the till as
 * systems, the domain's owner and registrar, who runs the Google profile) is left out: that release moved it to the
 * notes, and the history keeps it.
 */
export function normalizeAccount(input, newId) {
  const a = input || {};
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
    access: line(sys.access, 500),
  };
  return { systems, contacts };
}

/**
 * A lead's Kundenakte in today's shape, so one stored before a part was added or dropped compares and shows like a new
 * one. A lead that never had one has the empty one. Stored entries all have their id, so no new id is needed.
 */
export const accountOf = (lead) => normalizeAccount(lead.account);
/** Shown on the lead page once a deal is near (Qualifiziert, Kunde) or as soon as anything is in it. */
export const showsAccount = (lead) => lead.status === "qualifiziert" || lead.status === "kunde" || JSON.stringify(accountOf(lead)) !== JSON.stringify(EMPTY_ACCOUNT);
/**
 * The given parts over the stored Kundenakte: the contacts replace the stored list; systems, and each system, change
 * field by field. A write that leaves out the contact who runs a system must give that system's `by` too, so a contact
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
      throw new ValidationError("contacts", `${name} betreut ${label}, fehlt aber in den Kontakten: den Kontakt mit seiner id senden oder bei ${label} „betreut von“ angeben`);
    }
  }
  return { systems, contacts };
}

/**
 * A Kundenakte as the patch that writes it over the stored one: what the stored one holds and today's shape has not
 * (a part 1.27.0 dropped) is null, which the store's RFC 7396 patch removes.
 */
export function accountPatch(stored, account) {
  const gone = (from, to) => Object.fromEntries(Object.keys(from || {}).filter((k) => !(k in to)).map((k) => [k, null]));
  return { ...gone(stored, account), ...account, systems: { ...gone(stored?.systems, account.systems), ...account.systems } };
}

/**
 * A contact this write adds or changes that holds the business's own email or phone, if one does: that is the
 * business's own contact, which lives in the lead's fields (person, email, phone), so the Kundenakte keeps only the
 * people besides it. A contact stored as it is never counts, so one from before, or one the lead's own fields came to
 * match later, never blocks an unrelated save.
 */
const national = (phone) => String(phone || "").replace(/\D/g, "").replace(/^(00)?43/, "").replace(/^0/, "");
export function ownContactIn(account, stored, lead) {
  const kept = new Set(stored.contacts.map((c) => JSON.stringify(c)));
  return account.contacts.find((c) => !kept.has(JSON.stringify(c)) && ((c.email && addressKey(c.email) === addressKey(lead.email)) || (national(c.phone) && national(c.phone) === national(lead.phone))));
}

/** The systems a contact looks after, by label. */
export const handledBy = (account, contactId) => SYSTEMS.filter(([k]) => account.systems[k]?.by === contactId).map(([, label]) => label);
