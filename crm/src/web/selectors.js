import { REGIONS, OTHER_REGION, regionOf } from '../domain/region.js';
import { RESERVATION_TOOLS } from '../domain/constants.js';
import { byTimeline } from '../domain/activity.js';
import { groupByLead } from '../domain/stats.js';

let cacheKey = null;
let cacheVal = null;
export function activitiesByLead(state) {
  if (state.data.activities !== cacheKey) {
    cacheKey = state.data.activities;
    cacheVal = groupByLead(state.data.activities);
    for (const list of cacheVal.values()) list.sort(byTimeline);
  }
  return cacheVal;
}
export const actsOf = (state, leadId) => activitiesByLead(state).get(leadId) || [];
export const currentLead = (state) => state.data.leads.find((l) => l.id === state.ui.leadId) || null;
export const icpOf = (state) => state.data.settings.find((s) => s.id === "icp") || null;
export const isReady = (state) => state.status.leads && state.status.activities;
export function scoped(state, leads = state.data.leads, { ignoreTool = false } = {}) {
  const { region, onlyEmail, tool } = state.ui;
  return leads.filter((l) => (region === "alle" || regionOf(l) === region) && (!onlyEmail || !!l.email) && (ignoreTool || tool === "alle" || (l.currentTool || "unbekannt") === tool));
}
export function toolCounts(state) {
  const m = {};
  for (const l of scoped(state, state.data.leads, { ignoreTool: true })) {
    const t = l.currentTool || "unbekannt";
    m[t] = (m[t] || 0) + 1;
  }
  return RESERVATION_TOOLS.filter((t) => m[t] || t === state.ui.tool).map((t) => [t, m[t] || 0]).sort((a, b) => b[1] - a[1]);
}
export function regionCounts(state) {
  const m = {};
  for (const l of state.data.leads) {
    const r = regionOf(l);
    m[r] = (m[r] || 0) + 1;
  }
  return [...REGIONS, OTHER_REGION].filter((r) => m[r]).map((r) => [r, m[r]]);
}
