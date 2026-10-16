import { hasReply } from './activity.js';

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
export function lostBreakdown(leads) {
  const out = {};
  for (const l of leads) if (l.status === "kein-interesse") {
    const r = l.lostReason || "ohne Grund";
    out[r] = (out[r] || 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
}
export function templateUsage(activities) {
  const out = {};
  for (const a of activities) if (a.templateId) out[a.templateId] = (out[a.templateId] || 0) + 1;
  return out;
}
