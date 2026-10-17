import { CHANNELS, DIRECTIONS, SEQUENCE_POLICY, OUTCOME_LABEL, SPOKEN_REASONS, OPT_OUT_REASON } from './constants.js';
import { optOutPatch } from './lead.js';
import { ValidationError } from './errors.js';
import { addDays, isDate, dayLabel } from './dates.js';

export function newActivityRecord(input, { id, now, today }) {
  const text = String(input.text ?? "").trim();
  if (!input.leadId) throw new ValidationError("leadId", "Lead fehlt");
  if (!text) throw new ValidationError("text", "Bitte Text eingeben");
  if (!DIRECTIONS.has(input.direction)) throw new ValidationError("direction", "Richtung ung\xFCltig");
  const outcome = input.outcome ?? null, reason = input.reason ?? null;
  if (outcome !== null && !(OUTCOME_LABEL[outcome] && input.direction === "out" && input.channel === "Telefon")) throw new ValidationError("outcome", "Ein Gespr\xE4chsergebnis geh\xF6rt nur zu einem Anruf");
  if (reason !== null && !(outcome === "kein-interesse" && SPOKEN_REASONS.includes(reason))) throw new ValidationError("lostReason", "Ein Grund geh\xF6rt nur zu \u201EKein Interesse\u201C");
  return {
    id,
    leadId: input.leadId,
    date: isDate(input.date) ? input.date : today,
    channel: CHANNELS.includes(input.channel) ? input.channel : "Sonstiges",
    direction: input.direction,
    text,
    templateId: input.templateId || null,
    outcome,
    reason,
    createdAt: now
  };
}
/** A contact is logged once it happened: a date after today would give a first contact that has not been. */
export function assertHappened(activity, today) {
  if (activity.date > today) throw new ValidationError("date", "Das Datum liegt in der Zukunft");
}
export const byTimeline = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
/** They answered: a message from them, or a call in which we spoke to them. */
export const isReply = (a) => a.direction === "in" || (!!a.outcome && a.outcome !== "nicht-erreicht");
export function countTouches(acts) {
  const days = new Set();
  for (const a of [...acts].sort(byTimeline)) {
    if (isReply(a)) break;
    days.add(a.date);
  }
  return days.size;
}
export const hasReply = (acts) => acts.some(isReply);
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
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const atTime = (time) => (time ? ` um ${time}` : "");
/**
 * A phone call today and how it ended, as the activity to log. Rückruf and Termin need a day from today on and
 * may have a time; Kein Interesse needs the reason why.
 */
export function callActivity({ outcome, date, time, reason, note }, today) {
  if (!OUTCOME_LABEL[outcome]) throw new ValidationError("outcome", "Wie ist das Gespr\xE4ch ausgegangen?");
  const dated = outcome === "rueckruf" || outcome === "termin";
  if (!dated && (date || time)) throw new ValidationError(date ? "date" : "time", "Datum und Uhrzeit geh\xF6ren nur zu R\xFCckruf und Termin");
  const at = dated ? agreedDate(date, time, today) : "";
  if (outcome === "kein-interesse" && !SPOKEN_REASONS.includes(reason)) throw new ValidationError("lostReason", "Bitte einen Grund w\xE4hlen");
  const head = outcome === "rueckruf" ? `R\xFCckruf am ${dayLabel(date)}${at}` : outcome === "termin" ? `Termin vereinbart: ${dayLabel(date)}${at}` : outcome === "kein-interesse" ? `Kein Interesse: ${reason}` : "Nicht erreicht";
  return { direction: "out", channel: "Telefon", date: today, outcome, reason: reason ?? null, text: [head, String(note ?? "").trim()].filter(Boolean).join("\n") };
}
// A day from today on, and an optional time: when we call back or meet.
function agreedDate(date, time, today) {
  if (!(isDate(date) && date >= today)) throw new ValidationError("date", "Bitte ein Datum ab heute w\xE4hlen");
  if (time && !TIME_RE.test(time)) throw new ValidationError("time", "Uhrzeit ung\xFCltig");
  return atTime(time);
}
/** An appointment that has come: a qualified lead whose next step is the Termin and whose day is here or past. */
export const meetingDue = (lead, today) => lead.status === "qualifiziert" && !!lead.followUp && lead.followUp <= today && /^Termin\b/.test(lead.nextStep || "");
/** How the appointment went: they became a customer, it ended without a deal (and why), or a new appointment. */
export function meetingPatch(lead, { result, reason, date, time }, today) {
  if (lead.status !== "qualifiziert") throw new ValidationError("status", "Nur bei \u201EQualifiziert\u201C");
  if (reason && result !== "kein-abschluss") throw new ValidationError("lostReason", "Ein Grund geh\xF6rt nur zu \u201EKein Abschluss\u201C");
  if ((date || time) && result !== "neuer-termin") throw new ValidationError(date ? "date" : "time", "Datum und Uhrzeit geh\xF6ren nur zu \u201ENeuer Termin\u201C");
  if (result === "kunde") return { status: "kunde", followUp: null, nextStep: "" };
  if (result === "kein-abschluss") {
    if (!SPOKEN_REASONS.includes(reason)) throw new ValidationError("lostReason", "Bitte einen Grund w\xE4hlen");
    return { status: "disqualifiziert", lostReason: reason, nextStep: "" };
  }
  if (result === "neuer-termin") return { followUp: date, nextStep: "Termin" + agreedDate(date, time, today) };
  throw new ValidationError("result", "Wie war der Termin?");
}
/**
 * What a call changes on the lead, on top of what any contact changes. Nicht erreicht: call again soon, and the
 * last attempt of the sequence closes the lead; a missed call does not move a date the sequence did not set (one
 * agreed with them or planned by hand). Rückruf and Termin set that date; Kein Interesse closes the lead with its
 * reason. A call never moves a customer out of Kunde.
 */
export function planAfterCall(lead, acts, activity, { date, time }, policy = SEQUENCE_POLICY) {
  const patch = planAfterActivity(lead, acts, activity, policy);
  const at = atTime(time);
  const kunde = lead.status === "kunde";
  switch (activity.outcome) {
    case "nicht-erreicht": {
      if (sequenceExhausted({ ...lead, ...patch }, [...acts, activity], policy)) return { ...patch, status: "disqualifiziert", lostReason: "Nicht erreicht", nextStep: "" };
      // The sequence sets dates only on Kontaktiert, and with no next step.
      const bySequence = lead.status === "kontaktiert" && !lead.nextStep;
      if (lead.followUp > activity.date && !bySequence) {
        const { followUp: _followUp, nextStep: _nextStep, ...kept } = patch;
        return kept;
      }
      // A customer's next step (say, onboarding) still stands when we did not get through.
      return { ...patch, followUp: addDays(activity.date, policy.callRetryDays), ...(!kunde && { nextStep: "" }) };
    }
    case "rueckruf":
      return { ...patch, followUp: date, nextStep: "R\xFCckruf" + at };
    case "termin":
      return { ...patch, ...(!kunde && { status: "qualifiziert" }), followUp: date, nextStep: "Termin" + at };
    default: {
      if (!kunde) return { ...patch, status: "disqualifiziert", lostReason: activity.reason, nextStep: "" };
      // The opt-out reason is an opt-out on a customer too.
      return activity.reason === OPT_OUT_REASON ? { ...patch, ...optOutPatch(activity.date, lead) } : patch;
    }
  }
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
