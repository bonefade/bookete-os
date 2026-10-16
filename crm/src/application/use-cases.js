import { BACKUP_FORMAT } from "../domain/backup.js";
import { COLLECTIONS } from "../domain/constants.js";
import { newActivityRecord, assertMayContact, planAfterActivity } from "../domain/activity.js";
import { SCHEMA_VERSION } from "../domain/constants.js";
import { normalizeLead, newLeadRecord, transition, lostReasonPatch, followUpPatch, optOutPatch, clearOptOutPatch } from "../domain/lead.js";
import { normalizeTemplate } from "../domain/template.js";
import { ValidationError, ConflictError } from "../domain/errors.js";

/**
 * The only write path. The web app (RPC) and agents (MCP) both call these,
 * so every business rule holds whoever writes. `actor` is recorded on each write.
 */
const lines = (a) => (a || []).map((s) => String(s).trim()).filter(Boolean);
const normalizeIcp = (icp) => ({ fit: lines(icp.fit), noFit: lines(icp.noFit), note: String(icp.note || "") });
const ATTEMPTS = 3;
/**
 * Read, decide, commit. A write that names its read as `base` fails with ConflictError if someone wrote the
 * record in between; then the whole step runs again on fresh state. After ATTEMPTS the ConflictError reaches the caller.
 */
async function retrying(step) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt === ATTEMPTS) throw e;
    }
  }
}

export function createUseCases({ store, clock, ids, actor, mailer = null }) {
  const touch = (patch) => ({ ...patch, updatedAt: clock.now() });
  const commit = (ops) => store.commit(ops, actor);
  const patchLead = (base, patch) => commit([{ type: "patch", collection: "leads", id: base.id, base, data: touch(patch) }]);
  /** The common shape: read the lead, compute a patch from it, write the patch only if the lead is still as read. */
  const changeLead = (id, compute) => retrying(async () => {
    const l = await lead(id);
    await patchLead(l, compute(l));
  });
  async function lead(id) {
    const found = await store.get("leads", id);
    if (!found) throw new ValidationError("id", "Betrieb nicht gefunden");
    return found;
  }
  // The lead is always written (at least updatedAt), so a concurrent opt-out, status change or delete is never missed.
  const logActivity = (id, input) => retrying(async () => {
    const l = await lead(id);
    assertMayContact(l, input.direction);
    const activity = newActivityRecord({ ...input, leadId: id }, { id: ids.newId(), now: clock.now(), today: clock.today() });
    const plan = planAfterActivity(l, await store.activitiesOf(id), activity);
    await commit([
      { type: "put", collection: "activities", id: activity.id, data: activity },
      { type: "patch", collection: "leads", id, base: l, data: touch(plan) },
    ]);
    return { activity, plan };
  });
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
    updateField: (id, key, value) => retrying(async () => {
      const l = await lead(id);
      const next = normalizeLead({ [key]: value }, l);
      if (String(next[key] ?? "") === String(l[key] ?? "")) return false;
      await patchLead(l, { [key]: next[key] });
      return true;
    }),
    /** Writes only the fields whose normalized value differs, so a save that changes nothing leaves no history entry. */
    updateLead: (id, input) => retrying(async () => {
      const l = await lead(id);
      const next = normalizeLead(input, l);
      const patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(l[k] ?? null)));
      if (Object.keys(patch).length) await patchLead(l, patch);
    }),
    /** Moves the lead and its activities to the trash. Deleting a lead that is already gone does nothing. */
    deleteLead: (id) => retrying(async () => {
      const l = await store.get("leads", id);
      if (!l) return;
      const acts = await store.activitiesOf(id);
      await commit([...acts.map((a) => ({ type: "remove", collection: "activities", id: a.id, base: a })), { type: "remove", collection: "leads", id, base: l }]);
    }),
    /** Brings a lead back from the trash with the activities deleted together with it. */
    restoreLead: (id) => retrying(async () => {
      const l = await store.getDeleted("leads", id);
      if (!l) {
        if (await store.get("leads", id)) return;
        throw new ValidationError("id", "Nicht im Papierkorb");
      }
      const acts = await store.activitiesOf(id, { deleted: true });
      await commit([{ type: "restore", collection: "leads", id, base: l }, ...acts.map((a) => ({ type: "restore", collection: "activities", id: a.id, base: a }))]);
    }),
    /** Erases a lead in the trash for good, all its activities and history included (a business's right to erasure). */
    purgeLead: (id) => retrying(async () => {
      const l = await store.getDeleted("leads", id);
      if (!l) {
        if (await store.get("leads", id)) throw new ValidationError("id", "Nur Betriebe im Papierkorb lassen sich endg\xFCltig l\xF6schen");
        return;
      }
      await store.purgeLead(l, actor, await store.activitiesOf(id));
    }),
    /** Status and, for kein-interesse, the reason, validated together and written in one patch. */
    changeStatus: (id, status, reason) => changeLead(id, (l) => {
      const patch = transition(l, status);
      return reason ? { ...patch, ...lostReasonPatch({ ...l, ...patch }, reason) } : patch;
    }),
    setLostReason: (id, reason) => changeLead(id, (l) => lostReasonPatch(l, reason)),
    closeWithoutReply: (id) => changeLead(id, (l) => ({ ...transition(l, "kein-interesse"), lostReason: "Keine Antwort" })),
    setFollowUp: (id, date) => changeLead(id, () => followUpPatch(date)),
    setNextStep: (id, text) => changeLead(id, () => ({ nextStep: String(text || "").trim() })),
    logActivity,
    /** The business asked not to be contacted again: record it (dated) and close the lead. */
    optOut: (id, note) => retrying(async () => {
      const l = await lead(id);
      const date = clock.today();
      const activity = newActivityRecord({
        leadId: id,
        direction: "in",
        channel: "Sonstiges",
        date,
        text: "Opt-out: m\xF6chte keine Nachrichten mehr." + (note ? " " + String(note).trim() : "")
      }, { id: ids.newId(), now: clock.now(), today: date });
      await commit([
        { type: "patch", collection: "leads", id, base: l, data: touch(optOutPatch(date)) },
        { type: "put", collection: "activities", id: activity.id, data: activity }
      ]);
    }),
    clearOptOut: (id) => changeLead(id, clearOptOutPatch),
    async saveTemplate(id, input) {
      const t = normalizeTemplate(input);
      if (id) {
        await retrying(async () => {
          const base = await store.get("templates", id);
          if (!base) throw new ValidationError("id", "Vorlage nicht gefunden");
          await commit([{ type: "patch", collection: "templates", id, base, data: touch(t) }]);
        });
        return id;
      }
      const newId = ids.newId();
      await commit([{ type: "put", collection: "templates", id: newId, data: { ...t, createdAt: clock.now(), updatedAt: clock.now() } }]);
      return newId;
    },
    deleteTemplate: (id) => retrying(async () => {
      const base = await store.get("templates", id);
      if (base) await commit([{ type: "remove", collection: "templates", id, base }]);
    }),
    saveIcp: (icp) => commit([{ type: "put", collection: "settings", id: "icp", data: { ...normalizeIcp(icp), updatedAt: clock.now() } }]),
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
    /**
     * Restores records from a backup (the Claude artifact's or this app's). Only records the CRM has never
     * held are added, each through the same normalization as a normal write: an import can neither clear an
     * opt-out nor bring back something deleted. Re-running an import is safe; the client sends it in chunks.
     */
    async importBackup(backup) {
      if (backup?.format !== BACKUP_FORMAT) throw new ValidationError("backup", "Keine bookete-CRM-Sicherung");
      const now = clock.now();
      const normalize = {
        leads: (r) => ({ ...normalizeLead(r), schemaVersion: SCHEMA_VERSION, createdAt: r.createdAt || now, updatedAt: r.updatedAt || now }),
        activities: (r) => newActivityRecord(r, { id: r.id, now: r.createdAt || now, today: clock.today() }),
        templates: (r) => ({ ...normalizeTemplate(r), createdAt: r.createdAt || now, updatedAt: r.updatedAt || now }),
        settings: (r) => ({ ...normalizeIcp(r), updatedAt: r.updatedAt || now }),
      };
      const ops = [];
      for (const collection of COLLECTIONS) {
        const known = await store.ids(collection);
        for (const record of backup.data?.[collection] || []) {
          if (known.has(record.id) || (collection === "settings" && record.id !== "icp")) continue;
          try {
            const { id: _id, ...data } = normalize[collection](record);
            ops.push({ type: "put", collection, id: record.id, data });
          } catch (e) {
            throw new ValidationError("backup", `${collection} ${record.id}: ${e.message}`);
          }
        }
      }
      await commit(ops);
      return ops.length;
    }
  };
}
