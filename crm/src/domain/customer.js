import { ValidationError } from './errors.js';
import { addDays, isDate } from './dates.js';
import { isEmail } from './lead.js';

/**
 * A customer's care after the deal: the phase, who looks after them, and the onboarding steps. The sales status
 * stays Kunde in every phase. It lives on the lead record next to the Kundenakte, so the write guard, history,
 * trash, erase and backup cover it. As there, empty is "", never null, and the steps are a list: the store writes a
 * patch as RFC 7396, which drops a null nested in an object and keeps a key a patch leaves out.
 */
export const PHASES = [["onboarding", "Onboarding"], ["live", "Live"], ["gekuendigt", "Gek\xFCndigt"]];
export const PHASE_LABEL = Object.fromEntries(PHASES);
/** Why a customer cancelled; one is required, as a reason is for Disqualifiziert. */
export const CANCEL_REASONS = ["Preis", "Zu wenig Nutzen", "Anderes Tool", "Betrieb geschlossen", "Sonstiges"];
/** The standard onboarding, the same for every customer: [id, what, the day after the start it is due]. "live" ends it. */
export const ONBOARDING = [
  ["vertrag", "Vertrag unterschrieben", 0],
  ["abo", "Abo abgeschlossen", 1],
  ["konto", "bookete-Konto angelegt", 1],
  ["widget", "Widget auf der Website", 4],
  ["google", "Google-Profil verkn\xFCpft", 7],
  ["team", "Team eingeschult", 10],
  ["live", "Live", 14],
];
const STEP_IDS = new Set(ONBOARDING.map(([id]) => id));
const STEP_TITLES = new Set(ONBOARDING.map(([, title]) => title));
/** Whether a next step is one the onboarding set: a step's title. */
export const isStepTitle = (text) => STEP_TITLES.has(text);
const line = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A new customer, from the day they became one; `owner` is the user who won them, when known. */
export const startCustomer = (since, owner = "") => normalizeCustomer({ phase: "onboarding", since, owner });

/**
 * A stored customer in today's shape. `steps` lists the steps done or skipped, in onboarding order, each with when and
 * by whom (`skipped` says why it was not needed); a step not listed is open.
 */
export function normalizeCustomer(input) {
  const c = input || {};
  const phase = PHASE_LABEL[c.phase] ? c.phase : "onboarding";
  const held = new Map((Array.isArray(c.steps) ? c.steps : []).filter((s) => STEP_IDS.has(s?.id) && isDate(s.at)).map((s) => [s.id, s]));
  const steps = ONBOARDING.filter(([id]) => held.has(id)).map(([id]) => {
    const s = held.get(id);
    return { id, at: s.at, by: line(s.by, 200), ...(s.skipped && { skipped: line(s.skipped, 200) }) };
  });
  return {
    phase,
    since: isDate(c.since) ? c.since : "",
    owner: isEmail(line(c.owner, 200)) ? line(c.owner, 200) : "",
    steps,
    liveAt: phase !== "onboarding" && isDate(c.liveAt) ? c.liveAt : "",
    // Gekündigt always has a reason; one an old backup lacks is "Sonstiges".
    cancelReason: phase !== "gekuendigt" ? "" : CANCEL_REASONS.includes(c.cancelReason) ? c.cancelReason : "Sonstiges",
  };
}

/**
 * A Kunde's care. One won before customers were stored has none: it is Live where the Kundenakte has a service live,
 * else in Onboarding with no step done, for a person to tick once. Its steps have no day yet (`since` is ""): they
 * count from the day its care is first stored, so a customer won months ago is not overdue at once. Null for a
 * lead that never was Kunde.
 */
export function customerOf(lead) {
  if (lead.customer) return normalizeCustomer(lead.customer);
  if (lead.status !== "kunde") return null;
  const live = (lead.account?.services || []).find((s) => s.state === "live");
  return normalizeCustomer(live ? { phase: "live", liveAt: live.goLive || lead.wonAt || "" } : { phase: "onboarding" });
}

/** The onboarding steps with when each is due and, once done or skipped, when, by whom and why. */
export const onboardingOf = (c) => ONBOARDING.map(([id, title, day]) => ({ id, title, due: c.since ? addDays(c.since, day) : null, ...c.steps.find((s) => s.id === id) }));
/** The first step neither done nor skipped, if any. */
export const openStep = (c) => onboardingOf(c).find((s) => !s.at);

/** The lead's next step a customer's care gives: in onboarding, the first open step on its day; else none of its own. */
export function customerPlan(c) {
  const step = c.phase === "onboarding" ? openStep(c) : null;
  return step ? { followUp: step.due, nextStep: step.title } : { followUp: null, nextStep: "" };
}
/**
 * Whether a change to the care sets the lead's next step (customerPlan); else the next step stays as a person or a
 * contact planned it. In onboarding the open step is the next step, so a step changed there sets it, and so does
 * entering the onboarding; leaving it for Live or Gekündigt ends it, and Gekündigt drops the customer from Heute.
 * The owner, the same phase again, and a step changed after the onboarding leave it.
 */
export function carePlansNextStep(before, after, change) {
  if (after.phase !== before.phase) return after.phase !== "live" || before.phase === "onboarding";
  return after.phase === "onboarding" && "step" in change;
}
/**
 * The next step a Kunde's onboarding takes back after our own contact: its open step on its day, so a step due stays
 * due however much we write with them. Only where the onboarding planned the next step, or "Antworten" asked for this
 * contact, or none is planned: a Termin, a Rückruf or a step a person typed stays. Null where the care plans nothing:
 * not a Kunde, not in onboarding, no open step, or a care not yet stored, whose steps have no day.
 */
export function onboardingNextStep(lead) {
  const c = lead.status === "kunde" ? customerOf(lead) : null;
  if (!(c && c.phase === "onboarding" && c.since && openStep(c))) return null;
  return !lead.nextStep || lead.nextStep === "Antworten" || isStepTitle(lead.nextStep) ? customerPlan(c) : null;
}
/** A customer who cancelled: out of Heute, so our own contact plans no follow-up for it. */
export const hasCancelled = (lead) => lead.status === "kunde" && customerOf(lead)?.phase === "gekuendigt";

/**
 * One change to a customer, as a person makes it on its page: a step done or open again (`done: false`), skipped with
 * why (`skip`), the owner, or the phase (Gekündigt with a reason). Ticking "Live" makes it live; opening it again goes
 * back to onboarding. `by` and `today` stamp a step.
 */
export function customerAfter(c, change, { by, today }) {
  const next = { ...c };
  if ("step" in change) {
    if (!STEP_IDS.has(change.step)) throw new ValidationError("step", "Unbekannter Schritt");
    if (c.phase === "gekuendigt") throw new ValidationError("phase", "Gek\xFCndigt – erst wieder aufnehmen");
    // Going live is the end of the onboarding, never a step to leave out.
    if (change.step === "live" && change.skip !== undefined) throw new ValidationError("step", "\u201ELive\u201C entf\xE4llt nicht");
    next.steps = c.steps.filter((s) => s.id !== change.step);
    if (change.done !== false) next.steps.push({ id: change.step, at: today, by, ...(change.skip !== undefined && { skipped: line(change.skip, 200) || "entf\xE4llt" }) });
    // Ticking Live ends the onboarding; on a customer already live it keeps the day it went live.
    if (change.step === "live") Object.assign(next, change.done === false ? { phase: "onboarding", liveAt: "" } : { phase: "live", liveAt: c.phase === "live" && c.liveAt || today });
  } else if ("owner" in change) {
    if (change.owner && !isEmail(change.owner)) throw new ValidationError("owner", "Unbekannte Person");
    next.owner = change.owner || "";
  } else if ("phase" in change) {
    if (!PHASE_LABEL[change.phase]) throw new ValidationError("phase", "Unbekannte Phase");
    if (change.phase === "gekuendigt" && !CANCEL_REASONS.includes(change.reason)) throw new ValidationError("cancelReason", "Bitte einen Grund w\xE4hlen");
    if (change.phase !== "gekuendigt" && change.reason) throw new ValidationError("cancelReason", "Ein Grund geh\xF6rt nur zu „Gek\xFCndigt“");
    next.phase = change.phase;
    next.cancelReason = change.reason || "";
    if (change.phase === "live") next.liveAt = c.liveAt || today;
  } else throw new ValidationError("change", "Keine \xC4nderung");
  return normalizeCustomer(next);
}
