import { REGIONS, OTHER_REGION, regionOf } from '../domain/region.js';
import { RESERVATION_TOOLS } from '../domain/constants.js';
import { meetingDue } from '../domain/activity.js';
import { isPipeline, isDue, takesFollowUp, lacksNextStep, addressKey, addressOpen } from '../domain/lead.js';
import { timelinesByLead } from '../domain/stats.js';
import { customerOf, attentionOf } from '../domain/customer.js';
import { dueTodo } from '../domain/todos.js';

let cacheKey = null;
let cacheVal = null;
export function activitiesByLead(state) {
  if (state.data.activities !== cacheKey) {
    cacheKey = state.data.activities;
    cacheVal = timelinesByLead(state.data.activities);
  }
  return cacheVal;
}
export const actsOf = (state, leadId) => activitiesByLead(state).get(leadId) || [];
export const currentLead = (state) => state.data.leads.find((l) => l.id === state.ui.leadId) || null;
export const icpOf = (state) => state.data.settings.find((s) => s.id === "icp") || null;
export const isReady = (state) => state.status.leads && state.status.activities;
let closedKey = null;
let closedVal = null;
/** Whether mail may go to this lead, by the leads loaded (addressOpen). */
export function mailOpen(state, l) {
  if (state.data.leads !== closedKey) {
    closedKey = state.data.leads;
    closedVal = new Set(state.data.leads.filter((x) => x.optOutAt && x.email).map((x) => addressKey(x.email)));
  }
  return addressOpen(l, closedVal);
}
/** The shared filters, by their key in the UI state; "alle" lets every lead through. */
const FILTERS = {
  region: (l, v) => regionOf(l) === v,
  tool: (l, v) => (l.currentTool || "unbekannt") === v,
  contact: (l, v, state) => v === "telefon" ? !!l.phone : mailOpen(state, l)
};
/** The leads the shared filters let through; `ignore` leaves one of them out, so its own choices can be counted. */
export function scoped(state, leads = state.data.leads, ignore = null) {
  return leads.filter((l) => Object.entries(FILTERS).every(([k, pass]) => k === ignore || state.ui[k] === "alle" || pass(l, state.ui[k], state)));
}
function countBy(leads, keyOf) {
  const m = {};
  for (const l of leads) m[keyOf(l)] = (m[keyOf(l)] || 0) + 1;
  return m;
}
export function toolCounts(state) {
  const m = countBy(scoped(state, state.data.leads, "tool"), (l) => l.currentTool || "unbekannt");
  return RESERVATION_TOOLS.filter((t) => m[t] || t === state.ui.tool).map((t) => [t, m[t] || 0]).sort((a, b) => b[1] - a[1]);
}
export function regionCounts(state) {
  const m = countBy(scoped(state, state.data.leads, "region"), regionOf);
  return [...REGIONS, OTHER_REGION].filter((r) => m[r] || r === state.ui.region).map((r) => [r, m[r] || 0]);
}
export function contactCounts(state) {
  const leads = scoped(state, state.data.leads, "contact");
  return [["telefon", "mit Telefon"], ["email", "mit E-Mail"]].map(([k, label]) => [k, label, leads.filter((l) => FILTERS.contact(l, k, state)).length]);
}
/**
 * Who to call, in order: open businesses with a phone number that are due (by date, then fit), then new ones not
 * yet planned (by fit). An appointment that has come is no call, and an opted-out business is never on it.
 */
export function callList(state, today) {
  const callable = scoped(state).filter((l) => isPipeline(l) && l.phone && !meetingDue(l, today));
  const due = callable.filter((l) => isDue(l, today)).sort((a, b) => a.followUp < b.followUp ? -1 : a.followUp > b.followUp ? 1 : b.fit - a.fit);
  const fresh = callable.filter((l) => l.status === "neu" && !l.followUp).sort((a, b) => b.fit - a.fit || a.name.localeCompare(b.name, "de"));
  return [...due, ...fresh];
}
/** New businesses not yet planned, the best first; those with an address before those without. */
export const freshLeads = (state) => scoped(state).filter((l) => l.status === "neu" && !l.followUp).sort((a, b) => b.fit - a.fit || mailOpen(state, b) - mailOpen(state, a));
/** Their message is the newest on the lead: a reply to answer. Not on an opted-out lead, which is not answered from here. */
export const awaitsAnswer = (state, l) => takesFollowUp(l) && !l.optOutAt && actsOf(state, l.id).at(-1)?.direction === "in";
/**
 * Heute as one queue, in the order to work it: new replies (newest first), customers who need attention, then what is
 * overdue, then what is due today (a next step or a todo, dueOn) and the leads in work with no next step. A lead shows once, in the first section
 * it belongs to. "Meine" (the default) leaves out the customers someone else on the team looks after.
 */
export function todayQueue(state, today) {
  const leads = scoped(state).filter((l) => state.ui.hAll || !othersCustomer(state, l));
  const lastDate = (l) => actsOf(state, l.id).at(-1).date;
  const replies = leads.filter((l) => awaitsAnswer(state, l)).sort((a, b) => lastDate(b).localeCompare(lastDate(a)));
  const answered = new Set(replies.map((l) => l.id));
  // Customers who need attention come right after the answers: an unhappy customer or a stuck onboarding before new sales.
  const attention = leads.filter((l) => !answered.has(l.id) && l.status === "kunde" && attentionOf(customerOf(l), today)).sort((a, b) => a.name.localeCompare(b.name, "de"));
  const shown = new Set([...answered, ...attention.map((l) => l.id)]);
  const due = leads.filter((l) => !shown.has(l.id) && dueOn(l, today)).sort((a, b) => dueOn(a, today) < dueOn(b, today) ? -1 : dueOn(a, today) > dueOn(b, today) ? 1 : b.fit - a.fit);
  const unplanned = leads.filter((l) => !shown.has(l.id) && !dueOn(l, today) && lacksNextStep(l)).sort((a, b) => b.fit - a.fit);
  return { replies, attention, overdue: due.filter((l) => dueOn(l, today) < today), today: [...due.filter((l) => dueOn(l, today) === today), ...unplanned] };
}
/** The day a business is due by, if it is due today or before: its next step or its first todo due, whichever is earlier. */
export function dueOn(l, today) {
  const todo = dueTodo(l, today)?.due;
  const next = isDue(l, today) ? l.followUp : null;
  return todo && next ? (todo < next ? todo : next) : todo || next;
}
/** The todo a business is due by, when that todo is due on or before its next step: Heute shows it, and "Später" moves it. */
export function dueByTodo(l, today) {
  const todo = dueTodo(l, today);
  return todo && !(isDue(l, today) && l.followUp < todo.due) ? todo : null;
}
/** A customer someone else on the team looks after: Heute leaves it out unless it shows everyone's ("Alle"). */
export const othersCustomer = (state, l) => {
  const owner = l.status === "kunde" ? customerOf(l)?.owner : "";
  return !!owner && owner !== state.me?.email;
};
export const queueList = (state, today) => Object.values(todayQueue(state, today)).flat();
/** The leads a round works through, freshly computed, so one dealt with drops out by itself. */
export const roundList = (state, today, list) => list === "calls" ? callList(state, today) : list === "fresh" ? freshLeads(state) : queueList(state, today);
