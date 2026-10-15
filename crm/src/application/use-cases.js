import { BACKUP_FORMAT } from "../domain/backup.js";
import { COLLECTIONS } from "../domain/constants.js";
import { newActivityRecord, assertMayContact, planAfterActivity } from "../domain/activity.js";
import { normalizeLead, newLeadRecord, transition, lostReasonPatch, followUpPatch, optOutPatch, clearOptOutPatch } from "../domain/lead.js";
import { normalizeTemplate } from "../domain/template.js";
import { ValidationError } from "../domain/errors.js";

/**
 * The only write path. The web app (RPC) and agents (MCP) both call these,
 * so every business rule holds whoever writes. `actor` is recorded on each write.
 */
export function createUseCases({ store, clock, ids, actor, mailer = null }) {
  const touch = (patch) => ({ ...patch, updatedAt: clock.now() });
  const commit = (ops) => store.commit(ops, actor);
  const patchLead = (id, patch) => commit([{ type: "patch", collection: "leads", id, data: touch(patch) }]);
  async function lead(id) {
    const found = await store.get("leads", id);
    if (!found) throw new ValidationError("id", "Betrieb nicht gefunden");
    return found;
  }
  async function logActivity(id, input) {
    const l = await lead(id);
    assertMayContact(l, input.direction);
    const activity = newActivityRecord({ ...input, leadId: id }, { id: ids.newId(), now: clock.now(), today: clock.today() });
    const plan = planAfterActivity(l, await store.activitiesOf(id), activity);
    const ops = [{ type: "put", collection: "activities", id: activity.id, data: activity }];
    if (Object.keys(plan).length) ops.push({ type: "patch", collection: "leads", id, data: touch(plan) });
    await commit(ops);
    return { activity, plan };
  }
  async function mailable(id) {
    if (!mailer) throw new ValidationError("gmail", "Gmail ist nicht verbunden. Bitte neu anmelden.");
    const l = await lead(id);
    assertMayContact(l, "out");
    if (!l.email) throw new ValidationError("email", "Keine E-Mail-Adresse hinterlegt");
    return l;
  }

  return {
    async addLead(input) {
      const record = newLeadRecord(input, { id: ids.newId(), now: clock.now() });
      await commit([{ type: "put", collection: "leads", id: record.id, data: record }]);
      return record.id;
    },
    /** Inline quick edit of a single field; same validation as the full form. */
    async updateField(id, key, value) {
      const l = await lead(id);
      const next = normalizeLead({ [key]: value }, l);
      if (String(next[key] ?? "") === String(l[key] ?? "")) return false;
      await patchLead(id, { [key]: next[key] });
      return true;
    },
    async updateLead(id, input) {
      await patchLead(id, normalizeLead(input, await lead(id)));
    },
    async deleteLead(id) {
      const acts = await store.activitiesOf(id);
      await commit([...acts.map((a) => ({ type: "remove", collection: "activities", id: a.id })), { type: "remove", collection: "leads", id }]);
    },
    changeStatus: async (id, status) => patchLead(id, transition(await lead(id), status)),
    setLostReason: async (id, reason) => patchLead(id, lostReasonPatch(await lead(id), reason)),
    closeWithoutReply: async (id) => patchLead(id, { ...transition(await lead(id), "kein-interesse"), lostReason: "Keine Antwort" }),
    setFollowUp: async (id, date) => (await lead(id), patchLead(id, followUpPatch(date))),
    setNextStep: async (id, text) => (await lead(id), patchLead(id, { nextStep: String(text || "").trim() })),
    logActivity,
    /** The business asked not to be contacted again: record it (dated) and close the lead. */
    async optOut(id, note) {
      await lead(id);
      const date = clock.today();
      const activity = newActivityRecord({
        leadId: id,
        direction: "in",
        channel: "Sonstiges",
        date,
        text: "Opt-out: m\xF6chte keine Nachrichten mehr." + (note ? " " + String(note).trim() : "")
      }, { id: ids.newId(), now: clock.now(), today: date });
      await commit([
        { type: "patch", collection: "leads", id, data: touch(optOutPatch(date)) },
        { type: "put", collection: "activities", id: activity.id, data: activity }
      ]);
    },
    clearOptOut: async (id) => patchLead(id, clearOptOutPatch(await lead(id))),
    async saveTemplate(id, input) {
      const t = normalizeTemplate(input);
      if (id) {
        await commit([{ type: "patch", collection: "templates", id, data: touch(t) }]);
        return id;
      }
      const newId = ids.newId();
      await commit([{ type: "put", collection: "templates", id: newId, data: { ...t, createdAt: clock.now(), updatedAt: clock.now() } }]);
      return newId;
    },
    deleteTemplate: (id) => commit([{ type: "remove", collection: "templates", id }]),
    saveIcp(icp) {
      const lines = (a) => (a || []).map((s) => String(s).trim()).filter(Boolean);
      return commit([{ type: "put", collection: "settings", id: "icp", data: { fit: lines(icp.fit), noFit: lines(icp.noFit), note: icp.note || "", updatedAt: clock.now() } }]);
    },
    /** Sends from the signed-in user's Gmail, then logs the activity. */
    async sendEmail(id, { subject, text, templateId }) {
      const l = await mailable(id);
      const sent = await mailer.send({ to: l.email, subject, text });
      try {
        return { ...(await logActivity(id, { direction: "out", channel: "E-Mail", text, templateId })), gmail: sent };
      } catch (e) {
        // The mail is out; say so instead of inviting a second send.
        throw new ValidationError("activity", `E-Mail wurde gesendet, aber nicht eingetragen (${e.message}). Bitte manuell eintragen.`);
      }
    },
    /** Agents prepare, people send: a Gmail draft, nothing logged. */
    async draftEmail(id, { subject, text }) {
      const l = await mailable(id);
      return mailer.draft({ to: l.email, subject, text });
    },
    /** Restores a backup from the Claude artifact or this app. Records are upserted by id. */
    async importBackup(backup) {
      if (backup?.format !== BACKUP_FORMAT) throw new ValidationError("backup", "Keine bookete-CRM-Sicherung");
      const ops = COLLECTIONS.flatMap((collection) => (backup.data?.[collection] || []).map((record) => {
        if (typeof record?.id !== "string" || !record.id) throw new ValidationError("backup", `Eintrag ohne id in ${collection}`);
        return { type: "put", collection, id: record.id, data: record };
      }));
      await commit(ops);
      return ops.length;
    }
  };
}
