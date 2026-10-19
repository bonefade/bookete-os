import { CHANNELS, DIRECTIONS, SEQUENCE_POLICY, OUTCOME_LABEL, SPOKEN_REASONS, OPT_OUT_REASON } from './constants.js';
import { optOutPatch } from './lead.js';
import { careNextStep, hasCancelled } from './customer.js';
import { ValidationError } from './errors.js';
import { addDays, isDate, dayLabel } from './dates.js';

/**
 * `mail` is the Gmail message an E-Mail activity is (contract with the web: gmailId, threadId, mailbox, subject, from,
 * to; and messageId, its Message-ID header, which an answer in its thread refers to). Only the server passes it, for a mail it sent or the sync found; nothing a client sends can set it.
 */
export function newActivityRecord(input, { id, now, today, mail = null }) {
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
    createdAt: now,
    ...(mail && { mail: { gmailId: mail.gmailId, threadId: mail.threadId, mailbox: mail.mailbox, subject: mail.subject, from: mail.from, to: mail.to, messageId: mail.messageId || "" } })
  };
}
/**
 * The id of the activity a Gmail message is logged as: the same for sendEmail and the sync, so a mail is logged once.
 * Per mailbox, since each has its own message ids.
 */
export async function mailActivityId(mailbox, gmailId) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(mailbox + ":" + gmailId)));
  return "gm_" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
/**
 * Whether `a`, logged on the lead, is the Gmail message `activity` holds found again: the same message (an entry that
 * took it), the same mail in the other mailbox (its Message-ID), or an E-Mail entered without Gmail that day and that
 * way. Every mail sent before 1.17.0 was logged so, and an answer entered by hand is too. An answer is entered after it
 * came, so a later one is not it; one of ours may be entered before it went ("Als gesendet eintragen", then sent from
 * Gmail). Such an entry takes the first mail found for it (recordMail), so it stands for one mail, never for more.
 */
export const sameMail = (a, activity) => a.channel === "E-Mail" && (a.mail
  ? a.mail.mailbox === activity.mail.mailbox && a.mail.gmailId === activity.mail.gmailId || !!activity.mail.messageId && a.mail.messageId === activity.mail.messageId
  : a.direction === activity.direction && a.date === activity.date && (a.direction === "out" || activity.createdAt <= a.createdAt));
/** A contact is logged once it happened: a date after today would give a first contact that has not been. */
export function assertHappened(activity, today) {
  if (activity.date > today) throw new ValidationError("date", "Das Datum liegt in der Zukunft");
}
export const byTimeline = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
/**
 * We spoke with them: a message from them, a visit, or a call that got through. A mail, a DM or a call not answered
 * is an attempt: it is logged, but only speaking with them makes a lead Kontaktiert.
 */
export const spokeWith = (a) => a.direction === "in" || a.channel === "Vor Ort" || (!!a.outcome && a.outcome !== "nicht-erreicht");
export function countTouches(acts) {
  const days = new Set();
  for (const a of [...acts].sort(byTimeline)) {
    if (spokeWith(a)) break;
    days.add(a.date);
  }
  return days.size;
}
/** Whether we have spoken with them at all. */
export const hasSpoken = (acts) => acts.some(spokeWith);
/** The date of the first contact: the earliest of these activities, or `since` if that is earlier. */
export const firstContactOf = (acts, since = null) => acts.reduce((d, a) => (!d || a.date < d ? a.date : d), since);
/** The first contact an old lead's activities give. One dated after today (1.3 took any date) is no contact yet. */
export const firstContactUntil = (acts, today) => firstContactOf(acts.filter((a) => a.date <= today));
export const lastChannel = (acts) => ([...acts].sort(byTimeline).at(-1) || {}).channel || null;
export function assertMayContact(lead, direction) {
  if (direction === "out" && lead.optOutAt) throw new ValidationError("optOutAt", "M\xF6chte nicht mehr kontaktiert werden (Opt-out seit " + lead.optOutAt + ")");
}
/**
 * What logging an activity changes on the lead. Speaking with them (spokeWith) dates the first contact and moves
 * neu to kontaktiert; it reopens a disqualified lead (they called back, or we work them again), but an opt-out
 * stays closed: their message is logged and nothing else changes. An attempt (a mail, a DM, a call not answered)
 * moves no status and plans nothing on a Neu or disqualified lead: a Neu lead has no date, and the call list offers
 * it again once callRetryDays have passed (callList). Only the newest contact plans what comes next: one
 * that came before another (logged later but dated earlier, or a mail the sync finds late) leaves the plan the later
 * one made. A message from them is to be answered today; the next step "Antworten" it sets ends with the next
 * outgoing contact; on a Kunde it then goes back to what its care plans (careNextStep), and a customer
 * who cancelled gets no follow-up from our contact.
 */
export function planAfterActivity(lead, acts, activity, today, policy = SEQUENCE_POLICY) {
  const all = [...acts, activity];
  const patch = {};
  // A contact logged later but dated earlier moves the first contact back. An opted-out lead's contact dates it too.
  const first = firstContactOf(all.filter(spokeWith), lead.contactedAt);
  if (first !== lead.contactedAt) patch.contactedAt = first;
  if (lead.optOutAt) return patch;
  const status = spokeWith(activity) && (lead.status === "neu" || lead.status === "disqualifiziert") ? "kontaktiert" : lead.status;
  if (status !== lead.status) patch.status = status;
  if (!acts.every((a) => byTimeline(a, activity) < 0) || status === "neu" || status === "disqualifiziert") return patch;
  if (activity.direction === "out") {
    if (status === "kontaktiert" && !hasSpoken(all)) {
      const n = countTouches(all);
      const idx = Math.min(n - 1, policy.cadence.length - 1);
      patch.followUp = addDays(activity.date, policy.cadence[idx]);
      patch.nextStep = "";
    } else if (careNextStep(lead)) {
      // A Kunde: its open step or check-in is its next step again, on its day, also once "Antworten" is answered.
      Object.assign(patch, careNextStep(lead));
    } else if (hasCancelled(lead)) {
      // A customer who cancelled stays out of Heute: our contact plans no follow-up.
      if (lead.nextStep === "Antworten") patch.nextStep = "";
    } else {
      if (!lead.followUp || lead.followUp <= activity.date) patch.followUp = addDays(activity.date, policy.defaultFollowUpDays);
      // The answer the reply rule asked for went out.
      if (lead.nextStep === "Antworten") patch.nextStep = "";
    }
  } else {
    patch.followUp = today;
    patch.nextStep = "Antworten";
  }
  return patch;
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const atTime = (time) => (time ? ` um ${time}` : "");
/**
 * A phone call and how it ended, as the activity to log: today's, or one on an earlier `day` entered later. Rückruf
 * and Termin need a day from today on and may have a time; Kein Interesse needs the reason why.
 */
export function callActivity({ outcome, date, time, reason, note, day }, today) {
  if (day && !(isDate(day) && day <= today)) throw new ValidationError("day", "Der Anruf liegt in der Zukunft");
  if (!OUTCOME_LABEL[outcome]) throw new ValidationError("outcome", "Wie ist das Gespr\xE4ch ausgegangen?");
  const dated = outcome === "rueckruf" || outcome === "termin";
  if (!dated && (date || time)) throw new ValidationError(date ? "date" : "time", "Datum und Uhrzeit geh\xF6ren nur zu R\xFCckruf und Termin");
  const at = dated ? agreedDate(date, time, today) : "";
  if (outcome === "kein-interesse" && !SPOKEN_REASONS.includes(reason)) throw new ValidationError("lostReason", "Bitte einen Grund w\xE4hlen");
  const head = outcome === "rueckruf" ? `R\xFCckruf am ${dayLabel(date)}${at}` : outcome === "termin" ? `Termin vereinbart: ${dayLabel(date)}${at}` : outcome === "kein-interesse" ? `Kein Interesse: ${reason}` : "Nicht erreicht";
  return { direction: "out", channel: "Telefon", date: day || today, outcome, reason: reason ?? null, text: [head, String(note ?? "").trim()].filter(Boolean).join("\n") };
}
// A day from today on, and an optional time: when we call back or meet.
function agreedDate(date, time, today) {
  if (!(isDate(date) && date >= today)) throw new ValidationError("date", "Bitte ein Datum ab heute w\xE4hlen");
  if (time && !TIME_RE.test(time)) throw new ValidationError("time", "Uhrzeit ung\xFCltig");
  return atTime(time);
}
/**
 * Agreeing on an appointment, on a call, by mail, by message or in person: Qualifiziert (a Kunde stays Kunde), with
 * the appointment's day from today on as the next step.
 */
export function planMeeting(lead, { date, time }, today) {
  return { ...(lead.status !== "kunde" && { status: "qualifiziert" }), followUp: date, nextStep: "Termin" + agreedDate(date, time, today) };
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
  if (result === "neuer-termin") return planMeeting(lead, { date, time }, today);
  throw new ValidationError("result", "Wie war der Termin?");
}
/**
 * What a call changes on the lead, on top of what any contact changes. Nicht erreicht: call again soon, and the
 * last attempt of the sequence closes the lead; a missed call does not move a date the sequence did not set (one
 * agreed with them or planned by hand). Rückruf and Termin set that date; Kein Interesse closes the lead with its
 * reason. A call never moves a customer out of Kunde.
 */
export function planAfterCall(lead, acts, activity, { date, time }, policy = SEQUENCE_POLICY) {
  // A call is logged on its day (callActivity): today, or the earlier day it was entered for.
  const patch = planAfterActivity(lead, acts, activity, activity.date, policy);
  const kunde = lead.status === "kunde";
  // A call entered for an earlier day, before a later contact: a missed one or a no plans nothing, as any contact does
  // (planAfterActivity), but an opt-out in it holds all the same, and so does a Rückruf or Termin agreed in it.
  const earlier = !acts.every((a) => byTimeline(a, activity) < 0);
  switch (activity.outcome) {
    case "nicht-erreicht": {
      if (earlier) return patch;
      if (sequenceExhausted({ ...lead, ...patch }, [...acts, activity], policy)) return { ...patch, status: "disqualifiziert", lostReason: "Nicht erreicht", nextStep: "" };
      // A Neu lead has no date: the call list offers it again after callRetryDays. A closed one stays as it was.
      if (lead.status === "neu" || lead.status === "disqualifiziert") return patch;
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
      return { ...patch, followUp: date, nextStep: "R\xFCckruf" + atTime(time) };
    case "termin":
      return { ...patch, ...planMeeting(lead, { date, time }, activity.date) };
    default: {
      if (earlier && activity.reason !== OPT_OUT_REASON) return patch;
      if (!kunde) return { ...patch, status: "disqualifiziert", lostReason: activity.reason, nextStep: "" };
      // The opt-out reason is an opt-out on a customer too.
      return activity.reason === OPT_OUT_REASON ? { ...patch, ...optOutPatch(activity.date, lead) } : patch;
    }
  }
}
/**
 * No more attempts: a lead in the sequence (Kontaktiert, never spoken with) after maxTouches days of contact; a Neu
 * lead after maxTouches days it was called and not reached, as a mail or a DM is no try to reach them by phone.
 */
export function sequenceExhausted(lead, acts, policy = SEQUENCE_POLICY) {
  if (lead.status === "neu") return unreachedCallDays(acts) >= policy.maxTouches;
  return lead.status === "kontaktiert" && !hasSpoken(acts) && countTouches(acts) >= policy.maxTouches;
}
/** The days we called and did not get through; a call logged without an outcome is not known to have. */
const unreachedCallDays = (acts) => new Set(acts.filter((a) => a.channel === "Telefon" && a.direction === "out" && !spokeWith(a)).map((a) => a.date)).size;
/** The day of the last call, if any: a Neu lead called is offered again callRetryDays after it. */
export const lastCallOn = (acts) => acts.filter((a) => a.channel === "Telefon" && a.direction === "out").reduce((d, a) => (a.date > d ? a.date : d), "") || null;
export function nextActionHint(lead, acts, policy = SEQUENCE_POLICY) {
  if (lead.optOutAt) return "";
  if (lead.nextStep) return lead.nextStep;
  if (lead.status === "neu") {
    const n = unreachedCallDays(acts);
    return n >= policy.maxTouches ? `Nicht erreicht nach ${n} Anrufen \u2013 abschlie\xDFen?` : "Erstkontakt";
  }
  if (lead.status === "kontaktiert" && !hasSpoken(acts)) {
    const n = countTouches(acts);
    return n >= policy.maxTouches ? `Keine Antwort nach ${n} Kontakten \u2013 abschlie\xDFen?` : `Nachfassen (Kontakt ${n + 1} von ${policy.maxTouches})`;
  }
  return "";
}
