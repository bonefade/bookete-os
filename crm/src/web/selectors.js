import { REGIONS, OTHER_REGION, regionOf } from '../domain/region.js';
import { RESERVATION_TOOLS } from '../domain/constants.js';
import { meetingDue } from '../domain/activity.js';
import { isPipeline, isDue } from '../domain/lead.js';
import { timelinesByLead } from '../domain/stats.js';

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
/** The shared filters, by their key in the UI state; "alle" lets every lead through. */
const FILTERS = {
  region: (l, v) => regionOf(l) === v,
  tool: (l, v) => (l.currentTool || "unbekannt") === v,
  contact: (l, v) => v === "telefon" ? !!l.phone : !!l.email
};
/** The leads the shared filters let through; `ignore` leaves one of them out, so its own choices can be counted. */
export function scoped(state, leads = state.data.leads, ignore = null) {
  return leads.filter((l) => Object.entries(FILTERS).every(([k, pass]) => k === ignore || state.ui[k] === "alle" || pass(l, state.ui[k])));
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
  return [["telefon", "mit Telefon"], ["email", "mit E-Mail"]].map(([k, label]) => [k, label, leads.filter((l) => FILTERS.contact(l, k)).length]);
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
