import { ValidationError } from '../domain/errors.js';
import { chunkBackup } from '../domain/backup.js';

const toLogin = () => location.assign("/auth/login?next=" + encodeURIComponent(location.pathname + location.hash));

async function call(url, init) {
  const res = await fetch(url, init);
  if (res.status === 401) toLogin();
  const body = await res.json().catch(() => ({}));
  if (res.status >= 400 && res.status < 500) throw new ValidationError(body.field || "input", body.error || "Ung\xFCltige Eingabe");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return body;
}

/**
 * Runs `run` one at a time. Calls made while it runs share one more run after it, so whoever awaits a call waits for
 * a run that started after the call.
 */
export function coalesced(run) {
  let running = null, next = null;
  const start = () => (running = run().finally(() => (running = null)));
  const after = () => ((next = null), start());
  return () => next || (running ? (next = running.then(after, after)) : start());
}
/**
 * Same calls as the old in-browser use cases; the server now runs them. After each successful write the call awaits
 * `onWrite` (the sync), so the screen drawn next shows the write: a form reopened at once holds what was just saved.
 * A write asked for again while the same one is on its way (a double tap) is not sent twice: both get its answer.
 */
export function createApi(onWrite) {
  const inFlight = new Map();
  const send = async (name, body) => {
    const { result } = await call("/api/rpc/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    await onWrite();
    return result;
  };
  const rpc = (name, args) => {
    const body = JSON.stringify(args);
    const key = name + " " + body;
    if (!inFlight.has(key)) inFlight.set(key, send(name, body).finally(() => inFlight.delete(key)));
    return inFlight.get(key);
  };
  return {
    me: () => call("/api/me"),
    changes: (since) => call("/api/sync?since=" + since),
    history: (lead) => call("/api/history?id=" + encodeURIComponent(lead.id)),
    trash: (before) => call("/api/trash" + (before ? "?before=" + before : "")),
    addLead: (input) => rpc("addLead", { input }),
    updateField: (lead, key, value) => rpc("updateField", { id: lead.id, key, value }),
    updateLead: (lead, input) => rpc("updateLead", { id: lead.id, input }),
    deleteLead: (lead) => rpc("deleteLead", { id: lead.id }),
    restoreLead: (id) => rpc("restoreLead", { id }),
    purgeLead: (id) => rpc("purgeLead", { id }),
    changeStatus: (lead, status, reason) => rpc("changeStatus", { id: lead.id, status, reason }),
    setLostReason: (lead, reason) => rpc("setLostReason", { id: lead.id, reason }),
    closeWithoutReply: (lead) => rpc("closeWithoutReply", { id: lead.id }),
    setFollowUp: (lead, date) => rpc("setFollowUp", { id: lead.id, date }),
    setNextStep: (lead, text) => rpc("setNextStep", { id: lead.id, text }),
    logActivity: (lead, _acts, input) => rpc("logActivity", { id: lead.id, input }),
    logCall: (lead, call) => rpc("logCall", { id: lead.id, ...call }),
    meetingOutcome: (lead, meeting) => rpc("meetingOutcome", { id: lead.id, ...meeting }),
    optOut: (lead, note) => rpc("optOut", { id: lead.id, note }),
    clearOptOut: (lead) => rpc("clearOptOut", { id: lead.id }),
    saveTemplate: (id, input) => rpc("saveTemplate", { id, input }),
    deleteTemplate: (id) => rpc("deleteTemplate", { id }),
    saveIcp: (icp) => rpc("saveIcp", { icp: { fit: icp.fit, noFit: icp.noFit, note: icp.note } }),
    saveAccount: (lead, account, before) => rpc("saveAccount", { id: lead.id, account, before }),
    sendEmail: (lead, msg) => rpc("sendEmail", { id: lead.id, ...msg }),
    async importBackup(backup, today) {
      let added = 0;
      for (const chunk of chunkBackup(backup, today)) added += await rpc("importBackup", { backup: chunk });
      return added;
    },
  };
}
