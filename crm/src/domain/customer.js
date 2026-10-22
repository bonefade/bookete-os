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
/** What a customer agreed on; it decides which standard steps its onboarding starts with. One from before is bookete. */
export const PACKAGES = [["bookete", "bookete"], ["website", "Website"], ["beides", "bookete + Website"]];
export const PACKAGE_LABEL = Object.fromEntries(PACKAGES);
/** The onboarding's groups: the steps every customer takes, then bookete's and the website's. */
export const STEP_GROUPS = [["allgemein", "Allgemein"], ["bookete", "bookete"], ["website", "Website"]];
/**
 * The standard onboarding a customer's own steps start from, in the order steps are due: [id, what, the day after the
 * start it is due, group]. "live" ends it.
 */
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
const STANDARD = new Map(ONBOARDING.map(([id, title, day, group]) => [id, { title, day, group }]));
const GROUP_LABEL = Object.fromEntries(STEP_GROUPS);
export const STEP_LIMIT = 40;
/** The standard steps of the given groups, open, each due its day after `since` ("" without one). */
const standardSteps = (groups, since) => ONBOARDING.filter(([, , , group]) => groups.includes(group)).map(([id, title, day, group]) => ({ id, title, group, due: since ? addDays(since, day) : "", at: "", by: "" }));
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
const CARE_STEPS = new Set([...ONBOARDING.map(([, title]) => title), CHECK_IN]);
/** Whether a next step is one the care set: the check-in, a standard step's title or the title of one of this customer's steps. */
export const isCareStep = (text, c) => CARE_STEPS.has(text) || !!c?.steps.some((s) => s.title === text);

/** A new customer, from the day they became one; `owner` is the user who won them, when known. */
export const startCustomer = (since, owner = "") => normalizeCustomer({ phase: "onboarding", since, owner });

/** A stored step in today's shape: open while `at` is "", done or (with `skipped`, why) left out on that day. */
function normalizeStep(s) {
  const at = isDate(s.at) ? s.at : "";
  return { id: line(s.id, 100), title: line(s.title, 200), group: GROUP_LABEL[s.group] ? s.group : "", due: isDate(s.due) ? s.due : "", at, by: at ? line(s.by, 200) : "", ...(at && s.skipped && { skipped: line(s.skipped, 200) }) };
}
/**
 * A customer's own steps, in its order, "Live" last, at most 40 (a longer list, only from a backup made by hand,
 * keeps its first 39 and Live). Before 1.29.0 only the steps done or skipped were stored and the
 * package gave the rest: such a list becomes the package's standard steps with those merged in (a step done that the
 * package no longer took, hidden then, is left out; the history keeps it). A list of today's shape always holds Live.
 */
function stepsFrom(list, pkg, since) {
  const stored = Array.isArray(list) ? list.filter((s) => s && typeof s === "object") : [];
  if (!stored.some((s) => typeof s.title === "string")) {
    const held = new Map(stored.filter((s) => isDate(s.at)).map((s) => [s.id, s]));
    return standardSteps(GROUPS_OF[pkg], since).map((s) => held.has(s.id) ? normalizeStep({ ...s, ...held.get(s.id), title: s.title, group: s.group, due: s.due }) : s);
  }
  const seen = new Set();
  const steps = stored.map(normalizeStep).filter((s) => s.id && s.title && !seen.has(s.id) && seen.add(s.id));
  const live = steps.find((s) => s.id === "live") || standardSteps(["allgemein"], since).find((s) => s.id === "live");
  return [...steps.filter((s) => s !== live).slice(0, STEP_LIMIT - 1), live];
}

/**
 * A stored customer in today's shape. `package` is what it agreed on. `steps` is its own onboarding, in its order:
 * each step with its title, the standard group it came from ("" for one a person added), the day it is due ("" for
 * none) and, once done or skipped, when and by whom (`skipped` says why it was not needed). `checkIns` lists the
 * check-ins, oldest first, the last 40; `nextCheckIn` is the day the next one is due, while live.
 */
export function normalizeCustomer(input) {
  const c = input || {};
  const phase = PHASE_LABEL[c.phase] ? c.phase : "onboarding";
  const pkg = PACKAGE_LABEL[c.package] ? c.package : "bookete";
  const since = isDate(c.since) ? c.since : "";
  const steps = stepsFrom(c.steps, pkg, since);
  const checkIns = (Array.isArray(c.checkIns) ? c.checkIns : []).filter((x) => isDate(x?.at) && RESULT_LABEL[x.result])
    .map((x) => ({ at: x.at, result: x.result, by: line(x.by, 200), note: line(x.note, 500) }))
    .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).slice(-KEEP_CHECK_INS);
  return {
    phase,
    package: pkg,
    since,
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
 * A Kunde's care. One won before customers were stored has none: it is in Onboarding with no step done, for a person
 * to tick once or set Live. Its steps and check-ins have no day yet: they count from the day its care is first stored
 * (careFromToday), so a customer won months ago is not overdue at once. Null for a lead that never was Kunde.
 */
export function customerOf(lead) {
  if (lead.customer) return normalizeCustomer(lead.customer);
  return lead.status === "kunde" ? normalizeCustomer({ phase: "onboarding" }) : null;
}
/**
 * A care with what it needs to plan: one from before starts today, its standard steps due from today, and a live one
 * without a check-in day (from before, or stored by 1.20.0, before check-ins) gets its first 14 days from today, never
 * from a go-live months back.
 */
export const careFromToday = (c, today) => normalizeCustomer({
  ...c,
  since: c.since || today,
  steps: c.since ? c.steps : c.steps.map((s) => s.due || !STANDARD.has(s.id) ? s : { ...s, due: addDays(today, STANDARD.get(s.id).day) }),
  nextCheckIn: c.nextCheckIn || (c.phase === "live" ? addDays(today, CHECK_IN_DAYS.first) : ""),
});

/** The first step neither done nor skipped, if any. */
export const openStep = (c) => c.steps.find((s) => !s.at);

/** The lead's next step a customer's care gives: the open step on its day in onboarding, the check-in once live. */
export function customerPlan(c) {
  const step = c.phase === "onboarding" ? openStep(c) : null;
  if (step) return { followUp: step.due, nextStep: step.title };
  if (c.phase === "live" && c.nextCheckIn) return { followUp: c.nextCheckIn, nextStep: CHECK_IN };
  return { followUp: null, nextStep: "" };
}
/** The changes to the list of steps itself, beside a step done, opened again or skipped. */
const STEP_EDITS = ["addStep", "removeStep", "moveStep", "editStep"];
/** Whether a change rearranges the steps (a new package, a step added, removed, moved or edited) rather than ticking one. */
export const rearrangesSteps = (change) => "package" in change || STEP_EDITS.some((k) => k in change);
/**
 * Whether a change to the care sets the lead's next step (customerPlan); else the next step stays as a person or a
 * contact planned it. A new phase always does: the onboarding's open step, the first check-in, or none for
 * Gekündigt, which drops the customer from Heute. So does a step ticked in onboarding and a check-in once live.
 * So does a rearrangement of the steps in onboarding where it changes the open step, its title or its day. The
 * owner, the same phase again, and a step ticked after the onboarding leave it.
 */
export function carePlansNextStep(before, after, change) {
  if (after.phase !== before.phase) return true;
  if (rearrangesSteps(change)) return after.phase === "onboarding" && JSON.stringify(customerPlan(before)) !== JSON.stringify(customerPlan(after));
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
  return plan && (!lead.nextStep || lead.nextStep === "Antworten" || isCareStep(lead.nextStep, c)) ? plan : null;
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
 * The steps for another package: the standard steps of a group it adds come in where their day puts them among the
 * standard steps there; the open standard steps of a group it drops go. A group both take is left as the person made
 * it, so a step removed by hand stays gone. Steps done or skipped, and those a person added, stay.
 */
function stepsForPackage(c, pkg) {
  const groups = GROUPS_OF[pkg], had = GROUPS_OF[c.package];
  const steps = c.steps.filter((s) => s.at || !s.group || groups.includes(s.group));
  const added = groups.filter((g) => !had.includes(g));
  for (const s of standardSteps(added, c.since).filter((s) => !steps.some((x) => x.id === s.id))) {
    const day = STANDARD.get(s.id).day;
    const after = steps.findLastIndex((x) => x.id !== "live" && STANDARD.has(x.id) && STANDARD.get(x.id).day <= day);
    steps.splice(after + 1, 0, s);
  }
  return steps;
}
/** The step `id` of a customer, or a refusal; "Live" ends the onboarding, so it is never removed, moved, renamed or left out. */
function stepOf(c, id, { notLive } = {}) {
  const step = c.steps.find((s) => s.id === id);
  if (!step) throw new ValidationError("step", "Unbekannter Schritt");
  if (notLive && id === "live") throw new ValidationError("step", notLive);
  return step;
}
const stepTitle = (v) => {
  const title = line(v, 200);
  if (!title) throw new ValidationError("title", "Wie hei\xDFt der Schritt?");
  return title;
};
const dueDay = (v) => {
  if (v && !isDate(v)) throw new ValidationError("due", "Datum ung\xFCltig");
  return v || "";
};

/**
 * One change to a customer, as a person makes it on its page: a step done or open again (`done: false`), skipped with
 * why (`skip`); a step added before Live (`addStep`, its title, and a `due` day or none), removed (`removeStep`), moved
 * one place `up` or down (`moveStep`), or given another title or day (`editStep`); the package, the owner, the phase
 * (Gekündigt with a reason), or a check-in with how it went (`checkIn`, a `note`, and `next`, the day of the next one:
 * required after "unzufrieden", else by the rhythm). Ticking "Live" makes it live; opening it again goes back to
 * onboarding. Going live plans the first check-in. `by` and `today` stamp a step or check-in; `newId` names an added step.
 */
export function customerAfter(c, change, { by, today, newId }) {
  const next = { ...c };
  if (("step" in change || rearrangesSteps(change)) && c.phase === "gekuendigt") throw new ValidationError("phase", "Gek\xFCndigt – erst wieder aufnehmen");
  if ("step" in change) {
    // Going live is the end of the onboarding, never a step to leave out.
    const step = stepOf(c, change.step, change.skip !== undefined && { notLive: "„Live“ entf\xE4llt nicht" });
    const { skipped: _skipped, ...open } = step;
    const done = change.done === false ? { ...open, at: "", by: "" } : { ...open, at: today, by, ...(change.skip !== undefined && { skipped: line(change.skip, 200) || "entf\xE4llt" }) };
    next.steps = c.steps.map((s) => s === step ? done : s);
    // Ticking Live ends the onboarding; on a customer already live it keeps the day it went live.
    if (change.step === "live") Object.assign(next, change.done === false ? { phase: "onboarding", liveAt: "" } : { phase: "live", liveAt: c.phase === "live" && c.liveAt || today });
  } else if ("addStep" in change) {
    next.steps = [...c.steps.slice(0, -1), { id: newId(), title: stepTitle(change.addStep), group: "", due: dueDay(change.due), at: "", by: "" }, c.steps.at(-1)];
  } else if ("removeStep" in change) {
    const step = stepOf(c, change.removeStep, { notLive: "„Live“ beendet das Onboarding und bleibt" });
    next.steps = c.steps.filter((s) => s !== step);
  } else if ("moveStep" in change) {
    const step = stepOf(c, change.moveStep, { notLive: "„Live“ bleibt der letzte Schritt" });
    const from = c.steps.indexOf(step), to = from + (change.up ? -1 : 1);
    // Live stays last: a step moves among the steps before it.
    if (to < 0 || to >= c.steps.length - 1) return normalizeCustomer(c);
    next.steps = [...c.steps];
    [next.steps[from], next.steps[to]] = [next.steps[to], next.steps[from]];
  } else if ("editStep" in change) {
    const step = stepOf(c, change.editStep, "title" in change && { notLive: "„Live“ beh\xE4lt seinen Namen" });
    next.steps = c.steps.map((s) => s === step ? { ...s, ...("title" in change && { title: stepTitle(change.title) }), ...("due" in change && { due: dueDay(change.due) }) } : s);
  } else if ("package" in change) {
    if (!PACKAGE_LABEL[change.package]) throw new ValidationError("package", "Unbekanntes Paket");
    next.package = change.package;
    next.steps = stepsForPackage(c, change.package);
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
  if (next.steps.length > STEP_LIMIT) throw new ValidationError("step", `H\xF6chstens ${STEP_LIMIT} Schritte`);
  // A customer going live gets its first check-in 14 days after it went live; one live already keeps its day.
  if (next.phase === "live" && !next.nextCheckIn) next.nextCheckIn = addDays(next.liveAt || today, CHECK_IN_DAYS.first);
  return normalizeCustomer(next);
}
