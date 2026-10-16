import { ValidationError } from '../domain/errors.js';
import { chunkBackup } from '../domain/backup.js';

const toLogin = () => location.assign("/auth/login?next=" + encodeURIComponent(location.pathname));

async function call(url, init) {
  const res = await fetch(url, init);
  if (res.status === 401) toLogin();
  const body = await res.json().catch(() => ({}));
  if (res.status >= 400 && res.status < 500) throw new ValidationError(body.field || "input", body.error || "Ung\xFCltige Eingabe");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return body;
}

/** Same calls as the old in-browser use cases; the server now runs them. `onWrite` fires after each successful write. */
export function createApi(onWrite) {
  const rpc = async (name, args) => {
    const { result } = await call("/api/rpc/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    onWrite();
    return result;
  };
  return {
    me: () => call("/api/me"),
    changes: (since) => call("/api/sync?since=" + since),
    addLead: (input) => rpc("addLead", { input }),
    updateField: (lead, key, value) => rpc("updateField", { id: lead.id, key, value }),
    updateLead: (lead, input) => rpc("updateLead", { id: lead.id, input }),
    deleteLead: (lead) => rpc("deleteLead", { id: lead.id }),
    changeStatus: (lead, status) => rpc("changeStatus", { id: lead.id, status }),
    setLostReason: (lead, reason) => rpc("setLostReason", { id: lead.id, reason }),
    closeWithoutReply: (lead) => rpc("closeWithoutReply", { id: lead.id }),
    setFollowUp: (lead, date) => rpc("setFollowUp", { id: lead.id, date }),
    setNextStep: (lead, text) => rpc("setNextStep", { id: lead.id, text }),
    logActivity: (lead, _acts, input) => rpc("logActivity", { id: lead.id, input }),
    optOut: (lead, note) => rpc("optOut", { id: lead.id, note }),
    clearOptOut: (lead) => rpc("clearOptOut", { id: lead.id }),
    saveTemplate: (id, input) => rpc("saveTemplate", { id, input }),
    deleteTemplate: (id) => rpc("deleteTemplate", { id }),
    saveIcp: (icp) => rpc("saveIcp", { icp: { fit: icp.fit, noFit: icp.noFit, note: icp.note } }),
    sendEmail: (lead, msg) => rpc("sendEmail", { id: lead.id, ...msg }),
    async importBackup(backup) {
      let added = 0;
      for (const chunk of chunkBackup(backup)) added += await rpc("importBackup", { backup: chunk });
      return added;
    },
  };
}
