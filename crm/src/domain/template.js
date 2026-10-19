import { TEMPLATE_PURPOSES, PLACEHOLDERS } from './constants.js';
import { ValidationError } from './errors.js';
import { countTouches, hasSpoken } from './activity.js';

export const PURPOSES = new Set(TEMPLATE_PURPOSES.map(([k]) => k));
export const RE = new RegExp(`\\{(${PLACEHOLDERS.join("|")})\\}`, "g");
export function normalizeTemplate(input) {
  const name = String(input.name ?? "").trim();
  const body = String(input.body ?? "");
  if (!name) throw new ValidationError("name", "Name fehlt");
  if (!body.trim()) throw new ValidationError("body", "Text fehlt");
  return { name, body, purpose: PURPOSES.has(input.purpose) ? input.purpose : "sonstiges" };
}
export function fillTemplate(body, lead) {
  const values = { Betrieb: lead.name, Ort: lead.city, Aufh\u00E4nger: lead.hook, Person: (lead.person || "").split(/[ (]/)[0] };
  const missing = new Set();
  const text = body.replace(RE, (m, k) => values[k] ? values[k] : (missing.add(k), m));
  return { text, missing: [...missing] };
}
export function purposeFor(lead, acts) {
  if (hasSpoken(acts)) return "antwort";
  const n = countTouches(acts);
  return n === 0 ? "erstkontakt" : n === 1 ? "followup1" : "followup2";
}
export function defaultTemplate(lead, acts, templates) {
  const p = purposeFor(lead, acts);
  return templates.find((t) => t.purpose === p) || null;
}
/** The call script until one is saved as a template (purpose leitfaden). */
export const DEFAULT_SCRIPT = `Einstieg
Gr\xFC\xDF Gott, hier ist \u2026 von bookete. Spreche ich mit der Chefin oder dem Chef von {Betrieb}?
Ganz kurz: Wir helfen Gasth\xE4usern und Restaurants, Tischreservierungen online anzunehmen, damit im Service nicht st\xE4ndig das Telefon l\xE4utet.

Zwei Fragen
1. Wie nehmt ihr Reservierungen heute an?
2. Wie viele sind das pro Woche, ungef\xE4hr?

Ziel: ein Termin
Darf ich es euch in 15 Minuten zeigen, vor Ort oder per Video? Passt euch eher Mittwoch oder Donnerstag?

Typische Einw\xE4nde
\u201EWir haben schon ein System.\u201C \u2013 Was gef\xE4llt euch daran, und was fehlt euch?
\u201EDas Telefon reicht uns.\u201C \u2013 Wie oft l\xE4utet es, wenn im Service gerade viel los ist?
\u201EKeine Zeit.\u201C \u2013 Verstehe. Wann passt es besser? Ich rufe gern zur\xFCck.
\u201ESchicken Sie mir was per Mail.\u201C \u2013 Mache ich gern. An welche Adresse? Und darf ich n\xE4chste Woche kurz nachfragen?`;
/**
 * The script for a call to this lead: the oldest leitfaden template, else the default, filled with the lead's fields.
 * The oldest, so every device shows the same one whatever order its templates arrived in.
 */
export function callScript(lead, templates) {
  const template = templates.filter((t) => t.purpose === "leitfaden").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] || null;
  return { template, text: fillTemplate(template ? template.body : DEFAULT_SCRIPT, lead).text };
}
