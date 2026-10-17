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
/** A contact is logged once it happened: a date after today would give a first contact that has not been. */
export function assertHappened(activity, today) {
  if (activity.date > today) throw new ValidationError("date", "Das Datum liegt in der Zukunft");
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
/** The date of the first contact: the earliest of these activities, either way, or `since` if that is earlier. */
export const firstContactOf = (acts, since = null) => acts.reduce((d, a) => (!d || a.date < d ? a.date : d), since);
/** The first contact an old lead's activities give. One dated after today (1.3 took any date) is no contact yet. */
export const firstContactUntil = (acts, today) => firstContactOf(acts.filter((a) => a.date <= today));
export const lastChannel = (acts) => ([...acts].sort(byTimeline).at(-1) || {}).channel || null;
export function assertMayContact(lead, direction) {
  if (direction === "out" && lead.optOutAt) throw new ValidationError("optOutAt", "M\xF6chte nicht mehr kontaktiert werden (Opt-out seit " + lead.optOutAt + ")");
}
/**
 * What logging an activity changes on the lead. Any contact, either way, dates the first contact and moves
 * neu to kontaktiert; it reopens a disqualified lead (they called back, or we work them again), but an opt-out
 * stays closed: their message is logged and nothing else changes.
 */
export function planAfterActivity(lead, acts, activity, policy = SEQUENCE_POLICY) {
  const all = [...acts, activity];
  const patch = {};
  // A contact logged later but dated earlier moves the first contact back. An opted-out lead's contact dates it too.
  const first = firstContactOf(all, lead.contactedAt);
  if (first !== lead.contactedAt) patch.contactedAt = first;
  if (lead.optOutAt) return patch;
  const status = lead.status === "neu" || lead.status === "disqualifiziert" ? "kontaktiert" : lead.status;
  if (status !== lead.status) patch.status = status;
  if (activity.direction === "out") {
    if (status === "kontaktiert" && !hasReply(all)) {
      const n = countTouches(all);
      const idx = Math.min(n - 1, policy.cadence.length - 1);
      patch.followUp = addDays(activity.date, policy.cadence[idx]);
      patch.nextStep = "";
    } else if (!lead.followUp || lead.followUp <= activity.date) {
      patch.followUp = addDays(activity.date, policy.defaultFollowUpDays);
    }
  } else {
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
  if (lead.status === "neu") return "Erstkontakt";
  if (lead.status === "kontaktiert" && !hasReply(acts)) {
    const n = countTouches(acts);
    return n >= policy.maxTouches ? `Keine Antwort nach ${n} Kontakten \u2013 abschlie\xDFen?` : `Nachfassen (Kontakt ${n + 1} von ${policy.maxTouches})`;
  }
  return "";
}
