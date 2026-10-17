import { hasReply, isReply } from './activity.js';
import { weekStart } from './dates.js';

export function groupByLead(activities) {
  const m = new Map();
  for (const a of activities) {
    if (!m.has(a.leadId)) m.set(a.leadId, []);
    m.get(a.leadId).push(a);
  }
  return m;
}
export function outreachStats(leads, actsByLead) {
  const acts = (l) => actsByLead.get(l.id) || [];
  const contacted = leads.filter((l) => acts(l).some((a) => a.direction === "out")).length;
  const replied = leads.filter((l) => hasReply(acts(l))).length;
  return { contacted, replied, replyRate: contacted ? replied / contacted : null };
}
/** Disqualified leads by reason, most first; each has a reason. */
export function lostBreakdown(leads) {
  const out = {};
  for (const l of leads) if (l.status === "disqualifiziert") out[l.lostReason] = (out[l.lostReason] || 0) + 1;
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
}
export function templateUsage(activities) {
  const out = {};
  for (const a of activities) if (a.templateId) out[a.templateId] = (out[a.templateId] || 0) + 1;
  return out;
}
/**
 * Calling this week, Monday to today: calls, those we got through, appointments made, leads that became Kunde, and
 * the reasons calls ended with Kein Interesse, most first (three).
 */
export function weekNumbers(leads, activities, today) {
  const from = weekStart(today);
  const thisWeek = (d) => !!d && d >= from && d <= today;
  const calls = activities.filter((a) => a.direction === "out" && a.channel === "Telefon" && thisWeek(a.date));
  const reasons = {};
  for (const a of calls) if (a.reason) reasons[a.reason] = (reasons[a.reason] || 0) + 1;
  return {
    from,
    calls: calls.length,
    reached: calls.filter(isReply).length,
    meetings: calls.filter((a) => a.outcome === "termin").length,
    customers: leads.filter((l) => thisWeek(l.wonAt)).length,
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}
