import { CHANNELS, DIRECTIONS, SEQUENCE_POLICY } from './constants.js';
import { ValidationError } from './errors.js';
import { addDays, isDate } from './dates.js';

export function newActivityRecord(input, { id, now, today }) {
  const text = String(input.text ?? "").trim();
  if (!input.leadId) throw new ValidationError("leadId", "Lead fehlt");
  if (!text) throw new ValidationError("text", "Bitte Text eingeben");
  if (!DIRECTIONS.has(input.direction)) throw new ValidationError("direction", "Richtung ung\xFCltig");
  return {
    id,
    leadId: input.leadId,
    date: isDate(input.date) ? input.date : today,
    channel: CHANNELS.includes(input.channel) ? input.channel : "Sonstiges",
    direction: input.direction,
    text,
    templateId: input.templateId || null,
    createdAt: now
  };
}
export const byTimeline = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
export function countTouches(acts) {
  const days = new Set();
  for (const a of [...acts].sort(byTimeline)) {
    if (a.direction === "in") break;
    days.add(a.date);
  }
  return days.size;
}
export const hasReply = (acts) => acts.some((a) => a.direction === "in");
export const lastChannel = (acts) => ([...acts].sort(byTimeline).at(-1) || {}).channel || null;
export function assertMayContact(lead, direction) {
  if (direction === "out" && lead.optOutAt) throw new ValidationError("optOutAt", "M\xF6chte nicht mehr kontaktiert werden (Opt-out seit " + lead.optOutAt + ")");
}
export function planAfterActivity(lead, acts, activity, policy = SEQUENCE_POLICY) {
  const all = [...acts, activity];
  const patch = {};
  if (activity.direction === "out") {
    const status = lead.status === "recherchiert" ? "kontaktiert" : lead.status;
    if (status !== lead.status) patch.status = status;
    if (status === "kontaktiert" && !hasReply(all)) {
      const n = countTouches(all);
      const idx = Math.min(n - 1, policy.cadence.length - 1);
      patch.followUp = addDays(activity.date, policy.cadence[idx]);
      patch.nextStep = "";
    } else if (!lead.followUp || lead.followUp <= activity.date) {
      patch.followUp = addDays(activity.date, policy.defaultFollowUpDays);
    }
  } else {
    if (lead.status === "kontaktiert" || lead.status === "recherchiert") patch.status = "antwort";
    patch.followUp = activity.date;
    patch.nextStep = "Antworten";
  }
  return patch;
}
export function sequenceExhausted(lead, acts, policy = SEQUENCE_POLICY) {
  return lead.status === "kontaktiert" && !hasReply(acts) && countTouches(acts) >= policy.maxTouches;
}
export function nextActionHint(lead, acts, policy = SEQUENCE_POLICY) {
  if (lead.optOutAt) return "";
  if (lead.nextStep) return lead.nextStep;
  if (lead.status === "recherchiert") return "Erstkontakt schreiben";
  if (lead.status === "kontaktiert" && !hasReply(acts)) {
    const n = countTouches(acts);
    return n >= policy.maxTouches ? `Keine Antwort nach ${n} Kontakten \u2013 abschlie\xDFen?` : `Nachfassen (Kontakt ${n + 1} von ${policy.maxTouches})`;
  }
  if (lead.status === "antwort") return "Antworten";
  return "";
}
