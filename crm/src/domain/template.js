import { TEMPLATE_PURPOSES, PLACEHOLDERS } from './constants.js';
import { ValidationError } from './errors.js';
import { countTouches, hasReply } from './activity.js';

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
  if (hasReply(acts)) return "antwort";
  const n = countTouches(acts);
  return n === 0 ? "erstkontakt" : n === 1 ? "followup1" : "followup2";
}
export function defaultTemplate(lead, acts, templates) {
  const p = purposeFor(lead, acts);
  return templates.find((t) => t.purpose === p) || null;
}
