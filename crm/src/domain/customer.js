import { ValidationError } from './errors.js';
import { addDays, daysBetween, isDate } from './dates.js';
import { isEmail, oneLine as line } from './lead.js';

/**
 * A customer's care after the deal: the phase, who looks after them, the onboarding steps and, once live, the
 * check-ins. The sales status stays Kunde in every phase. It lives on the lead record next to the Kundenakte, so the
 * write guard, history, trash, erase and backup cover it. As there, empty is "", never null, and steps and check-ins
 * are lists: the store writes a patch as RFC 7396, which drops a null nested in an object and keeps a key a patch
 * leaves out.
 */
export const PHASES = [["onboarding", "Onboarding"], ["live", "Live"], ["gekuendigt", "Gek\xFCndigt"]];
export const PHASE_LABEL = Object.fromEntries(PHASES);
/** Why a customer cancelled; one is required, as a reason is for Disqualifiziert. */
export const CANCEL_REASONS = ["Preis", "Zu wenig Nutzen", "Anderes Tool", "Betrieb geschlossen", "Sonstiges"];
/** What a customer agreed on; it decides which onboarding steps it takes. One from before is bookete. */
export const PACKAGES = [["bookete", "bookete"], ["website", "Website"], ["beides", "bookete + Website"]];
export const PACKAGE_LABEL = Object.fromEntries(PACKAGES);
/** The onboarding's groups: the steps every customer takes, then bookete's and the website's. */
export const STEP_GROUPS = [["allgemein", "Allgemein"], ["bookete", "bookete"], ["website", "Website"]];
/** The onboarding, in the order steps are due: [id, what, the day after the start it is due, group]. "live" ends it. */
export const ONBOARDING = [
  ["vertrag", "Vertrag unterschrieben", 0, "allgemein"],
  ["abo", "Abo abgeschlossen", 1, "allgemein"],
  ["konto", "bookete-Konto angelegt", 1, "bookete"],
  ["inhalte", "Inhalte & Fotos erhalten", 3, "website"],
  ["widget", "Widget auf der Website", 4, "bookete"],
  ["domain", "Domain & DNS gekl\xE4rt", 5, "website"],
  ["google", "Google-Profil verkn\xFCpft", 7, "bookete"],
  ["entwurf", "Entwurf abgenommen", 8, "website"],
  ["team", "Team eingeschult", 10, "bookete"],
  ["online", "Website online", 11, "website"],
  ["uebergabe", "Account \xFCbergeben", 12, "allgemein"],
  ["live", "Live", 14, "allgemein"],
];
const GROUPS_OF = { bookete: ["allgemein", "bookete"], website: ["allgemein", "website"], beides: ["allgemein", "bookete", "website"] };
/** The steps a customer's package takes, in the order they are due. */
const stepsOf = (c) => ONBOARDING.filter(([, , , group]) => GROUPS_OF[c.package].includes(group));
/** How a check-in went. "unzufrieden" puts the customer on Achtung until the next check-in. */
export const CHECK_IN_RESULTS = [["gut", "Gut"], ["fragen", "Offene Fragen"], ["unzufrieden", "Unzufrieden"]];
export const RESULT_LABEL = Object.fromEntries(CHECK_IN_RESULTS);
/** The next step a check-in due gives a live customer. */
export const CHECK_IN = "Check-in";
/** The check-in rhythm after going live: the first after 14 days, the second 90 days after going live, then quarterly. */
export const CHECK_IN_DAYS = { first: 14, second: 90, then: 90 };
/** Days a step or check-in may be late before the customer needs attention. */
export const LATE = { step: 3, checkIn: 7 };
const KEEP_CHECK_INS = 40;
const STEP_IDS = new Set(ONBOARDING.map(([id]) => id));
const CARE_STEPS = new Set([...ONBOARDING.map(([, title]) => title), CHECK_IN]);
/** Whether a next step is one the care set: a step's title or the check-in. */
export const isCareStep = (text) => CARE_STEPS.has(text);

/** A new customer, from the day they became one; `owner` is the user who won them, when known. */
export const startCustomer = (since, owner = "") => normalizeCustomer({ phase: "onboarding", since, owner });

/**
 * A stored customer in today's shape. `package` is what it agreed on. `steps` lists the steps done or skipped, in
 * onboarding order, each with when and by whom (`skipped` says why it was not needed); a step not listed is open. A
 * step done that its package no longer takes stays stored, so picking the package back brings it back. `checkIns` lists the check-ins, oldest
 * first, the last 40; `nextCheckIn` is the day the next one is due, while live.
 */
export function normalizeCustomer(input) {
  const c = input || {};
  const phase = PHASE_LABEL[c.phase] ? c.phase : "onboarding";
  const held = new Map((Array.isArray(c.steps) ? c.steps : []).filter((s) => STEP_IDS.has(s?.id) && isDate(s.at)).map((s) => [s.id, s]));
  const steps = ONBOARDING.filter(([id]) => held.has(id)).map(([id]) => {
    const s = held.get(id);
    return { id, at: s.at, by: line(s.by, 200), ...(s.skipped && { skipped: line(s.skipped, 200) }) };
  });
  const checkIns = (Array.isArray(c.checkIns) ? c.checkIns : []).filter((x) => isDate(x?.at) && RESULT_LABEL[x.result])
    .map((x) => ({ at: x.at, result: x.result, by: line(x.by, 200), note: line(x.note, 500) }))
    .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).slice(-KEEP_CHECK_INS);
  return {
    phase,
    package: PACKAGE_LABEL[c.package] ? c.package : "bookete",
    since: isDate(c.since) ? c.since : "",
    owner: isEmail(line(c.owner, 200)) ? line(c.owner, 200) : "",
    steps,
    liveAt: phase !== "onboarding" && isDate(c.liveAt) ? c.liveAt : "",
    // Gekündigt always has a reason; one an old backup lacks is "Sonstiges".
    cancelReason: phase !== "gekuendigt" ? "" : CANCEL_REASONS.includes(c.cancelReason) ? c.cancelReason : "Sonstiges",
    checkIns,
    nextCheckIn: phase === "live" && isDate(c.nextCheckIn) ? c.nextCheckIn : "",
  };
}

/**
 * A Kunde's care. One won before customers were stored has none: it is Live where the Kundenakte has a service live,
 * else in Onboarding with no step done, for a person to tick once. Its steps and check-ins have no day yet: they
 * count from the day its care is first stored (careFromToday), so a customer won months ago is not overdue at once.
 * Null for a lead that never was Kunde.
 */
export function customerOf(lead) {
  if (lead.customer) return normalizeCustomer(lead.customer);
  if (lead.status !== "kunde") return null;
  const live = (lead.account?.services || []).find((s) => s.state === "live");
  return normalizeCustomer(live ? { phase: "live", liveAt: live.goLive || lead.wonAt || "" } : { phase: "onboarding" });
}
/**
 * A care with what it needs to plan: one from before starts today, and a live one without a check-in day (from before,
 * or stored by 1.20.0, before check-ins) gets its first 14 days from today, never from a go-live months back.
 */
export const careFromToday = (c, today) => normalizeCustomer({
  ...c,
  since: c.since || today,
  nextCheckIn: c.nextCheckIn || (c.phase === "live" ? addDays(today, CHECK_IN_DAYS.first) : ""),
});

/** The onboarding steps its package takes, with their group, when each is due and, once done or skipped, when, by whom and why. */
export const onboardingOf = (c) => stepsOf(c).map(([id, title, day, group]) => ({ id, title, group, due: c.since ? addDays(c.since, day) : null, ...c.steps.find((s) => s.id === id) }));
/** The first step neither done nor skipped, if any. */
export const openStep = (c) => onboardingOf(c).find((s) => !s.at);

/** The lead's next step a customer's care gives: the open step on its day in onboarding, the check-in once live. */
export function customerPlan(c) {
  const step = c.phase === "onboarding" ? openStep(c) : null;
  if (step) return { followUp: step.due, nextStep: step.title };
  if (c.phase === "live" && c.nextCheckIn) return { followUp: c.nextCheckIn, nextStep: CHECK_IN };
  return { followUp: null, nextStep: "" };
}
/**
 * Whether a change to the care sets the lead's next step (customerPlan); else the next step stays as a person or a
 * contact planned it. A new phase always does: the onboarding's open step, the first check-in, or none for
 * Gekündigt, which drops the customer from Heute. So does a step changed in onboarding and a check-in once live.
 * So does a new package in onboarding where it changes the open step. The owner, the same phase again, and a step
 * ticked after the onboarding leave it.
 */
export function carePlansNextStep(before, after, change) {
  if (after.phase !== before.phase) return true;
  if ("package" in change) return after.phase === "onboarding" && openStep(before)?.id !== openStep(after)?.id;
  return after.phase === "onboarding" && "step" in change || after.phase === "live" && "checkIn" in change;
}
/**
 * The next step a Kunde's care takes back after our own contact: the open step in onboarding, the check-in once live,
 * each on its day, so a step or check-in due stays due however much we write with them. Only where the care planned
 * the next step, or "Antworten" asked for this contact, or none is planned: a Termin, a Rückruf or a step a person
 * typed stays. Null where the care plans nothing: not a Kunde, cancelled, nothing open or due, or a care not yet
 * stored, whose steps have no day.
 */
export function careNextStep(lead) {
  const c = lead.status === "kunde" ? customerOf(lead) : null;
  const plan = c && (c.phase === "onboarding" ? c.since && openStep(c) : c.phase === "live" && c.nextCheckIn) ? customerPlan(c) : null;
  return plan && (!lead.nextStep || lead.nextStep === "Antworten" || isCareStep(lead.nextStep)) ? plan : null;
}
/** A customer who cancelled: out of Heute, so our own contact plans no follow-up for it. */
export const hasCancelled = (lead) => lead.status === "kunde" && customerOf(lead)?.phase === "gekuendigt";

/**
 * Why a customer needs attention now, or "": a step 3 days late in onboarding; once live, an unhappy last check-in
 * or a check-in a week late. Cancelled customers need none.
 */
export function attentionOf(c, today) {
  if (c.phase === "onboarding") {
    const step = openStep(c);
    return step?.due && daysBetween(step.due, today) >= LATE.step ? "Onboarding h\xE4ngt" : "";
  }
  if (c.phase !== "live") return "";
  // An unhappy check-in from before going live again is past.
  const last = c.checkIns.at(-1);
  if (last?.result === "unzufrieden" && !(c.liveAt && last.at < c.liveAt)) return "Unzufrieden";
  return c.nextCheckIn && daysBetween(c.nextCheckIn, today) >= LATE.checkIn ? "Check-in \xFCberf\xE4llig" : "";
}
/**
 * When the next check-in is due after one on `today`: the second 90 days after going live (a week from now at the
 * earliest, as a late first one is no reason to call again at once), then every 90 days.
 */
export function checkInAfter(c, today) {
  if (c.checkIns.length === 1 && c.liveAt) {
    const second = addDays(c.liveAt, CHECK_IN_DAYS.second);
    return daysBetween(today, second) >= 7 ? second : addDays(today, CHECK_IN_DAYS.then);
  }
  return addDays(today, CHECK_IN_DAYS.then);
}

/**
 * One change to a customer, as a person makes it on its page: a step done or open again (`done: false`), skipped with
 * why (`skip`), the package, the owner, the phase (Gekündigt with a reason), or a check-in with how it went (`checkIn`, a `note`,
 * and `next`, the day of the next one: required after "unzufrieden", else by the rhythm). Ticking "Live" makes it
 * live; opening it again goes back to onboarding. Going live plans the first check-in. `by` and `today` stamp a
 * step or check-in.
 */
export function customerAfter(c, change, { by, today }) {
  const next = { ...c };
  if ("step" in change) {
    if (!STEP_IDS.has(change.step)) throw new ValidationError("step", "Unbekannter Schritt");
    if (c.phase === "gekuendigt") throw new ValidationError("phase", "Gek\xFCndigt – erst wieder aufnehmen");
    // Going live is the end of the onboarding, never a step to leave out.
    if (change.step === "live" && change.skip !== undefined) throw new ValidationError("step", "„Live“ entf\xE4llt nicht");
    if (!stepsOf(c).some(([id]) => id === change.step)) throw new ValidationError("step", "Der Schritt geh\xF6rt nicht zum Paket");
    next.steps = c.steps.filter((s) => s.id !== change.step);
    if (change.done !== false) next.steps.push({ id: change.step, at: today, by, ...(change.skip !== undefined && { skipped: line(change.skip, 200) || "entf\xE4llt" }) });
    // Ticking Live ends the onboarding; on a customer already live it keeps the day it went live.
    if (change.step === "live") Object.assign(next, change.done === false ? { phase: "onboarding", liveAt: "" } : { phase: "live", liveAt: c.phase === "live" && c.liveAt || today });
  } else if ("package" in change) {
    if (!PACKAGE_LABEL[change.package]) throw new ValidationError("package", "Unbekanntes Paket");
    if (c.phase === "gekuendigt") throw new ValidationError("phase", "Gek\xFCndigt – erst wieder aufnehmen");
    next.package = change.package;
  } else if ("owner" in change) {
    if (change.owner && !isEmail(change.owner)) throw new ValidationError("owner", "Unbekannte Person");
    next.owner = change.owner || "";
  } else if ("phase" in change) {
    if (!PHASE_LABEL[change.phase]) throw new ValidationError("phase", "Unbekannte Phase");
    if (change.phase === "gekuendigt" && !CANCEL_REASONS.includes(change.reason)) throw new ValidationError("cancelReason", "Bitte einen Grund w\xE4hlen");
    if (change.phase !== "gekuendigt" && change.reason) throw new ValidationError("cancelReason", "Ein Grund geh\xF6rt nur zu „Gek\xFCndigt“");
    next.phase = change.phase;
    next.cancelReason = change.reason || "";
    // Live from onboarding keeps a go-live day it has; live again after a cancellation starts today.
    if (change.phase === "live") next.liveAt = c.phase === "gekuendigt" ? today : c.liveAt || today;
  } else if ("checkIn" in change) {
    if (c.phase !== "live") throw new ValidationError("phase", "Check-ins erst ab „Live“");
    if (!RESULT_LABEL[change.checkIn]) throw new ValidationError("checkIn", "Wie war der Check-in?");
    if (change.next && !(isDate(change.next) && change.next > today)) throw new ValidationError("next", "Der n\xE4chste Check-in liegt nach heute");
    if (change.checkIn === "unzufrieden" && !change.next) throw new ValidationError("next", "Wann melden wir uns wieder?");
    next.checkIns = [...c.checkIns, { at: today, result: change.checkIn, by, note: line(change.note, 500) }];
    next.nextCheckIn = change.next || checkInAfter({ ...c, checkIns: next.checkIns }, today);
  } else throw new ValidationError("change", "Keine \xC4nderung");
  // A customer going live gets its first check-in 14 days after it went live; one live already keeps its day.
  if (next.phase === "live" && !next.nextCheckIn) next.nextCheckIn = addDays(next.liveAt || today, CHECK_IN_DAYS.first);
  return normalizeCustomer(next);
}
