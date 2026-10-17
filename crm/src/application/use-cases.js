import { BACKUP_FORMAT } from "../domain/backup.js";
import { COLLECTIONS, SCHEMA_VERSION } from "../domain/constants.js";
import { newActivityRecord, assertMayContact, assertHappened, planAfterActivity, firstContactOf, callActivity, planAfterCall, meetingPatch } from "../domain/activity.js";
import { normalizeLead, LEAD_FIELDS, newLeadRecord, transition, lostReasonPatch, followUpPatch, optOutPatch, clearOptOutPatch, getsUnsubscribeLink } from "../domain/lead.js";
import { normalizeTemplate } from "../domain/template.js";
import { normalizeAccount, accountOf, mergeAccount } from "../domain/account.js";
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
  /**
   * Every change to a stored lead's fields goes through here (the Kundenakte has its own rules, normalizeAccount,
   * and saveAccount writes it with the same guard): the patch runs through normalizeLead on the read lead and
   * every field that differs is written, so what the rules derive (a cleared reason, contactedAt, an opt-out)
   * holds on every path. Empty when nothing changes.
   */
  const leadDiff = (l, patch) => {
    const next = normalizeLead(patch, l, clock.today());
    return Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(l[k] ?? null)));
  };
  // `l` itself is the base: its version symbol is not copied by a spread.
  const patchOp = (l, diff) => ({ type: "patch", collection: "leads", id: l.id, base: l, data: touch(diff) });
  /** The common shape: read the lead, compute a patch from it, write the diff only if the lead is still as read. Says whether anything changed. */
  const changeLead = (id, compute) => retrying(async () => {
    const l = await lead(id);
    const diff = leadDiff(l, compute(l));
    if (Object.keys(diff).length) await commit([patchOp(l, diff)]);
    return Object.keys(diff).length > 0;
  });
  async function lead(id) {
    const found = await store.get("leads", id);
    if (!found) throw new ValidationError("id", "Betrieb nicht gefunden");
    return found;
  }
  // The lead is always written (at least updatedAt), so a concurrent opt-out, status change or delete is never missed.
  const logContact = (id, input, planOf) => retrying(async () => {
    const l = await lead(id);
    assertMayContact(l, input.direction);
    const activity = newActivityRecord({ ...input, leadId: id }, { id: ids.newId(), now: clock.now(), today: clock.today() });
    assertHappened(activity, clock.today());
    const plan = planOf(l, await store.activitiesOf(id), activity);
    await commit([
      { type: "put", collection: "activities", id: activity.id, data: activity },
      patchOp(l, leadDiff(l, plan)),
    ]);
    return { activity, plan };
  });
  const logActivity = (id, input) => logContact(id, input, planAfterActivity);
  /** The opt-out, dated, and how it reached us in the Verlauf, in one write. */
  /** `trashed`: the lead is in the Papierkorb; the entry goes there with it, so a restore brings both back. */
  async function recordOptOut(l, text, { trashed = false } = {}) {
    const date = clock.today();
    const activity = newActivityRecord({ leadId: l.id, direction: "in", channel: "Sonstiges", date, text }, { id: ids.newId(), now: clock.now(), today: date });
    // Their message is a contact like any other: it dates the first contact, as planAfterActivity does.
    await commit([
      patchOp(l, leadDiff(l, { ...optOutPatch(date, l), contactedAt: firstContactOf([activity], l.contactedAt) })),
      { type: "put", collection: "activities", id: activity.id, data: activity, trashed }
    ]);
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
      const record = newLeadRecord(input, { id: ids.newId(), now: clock.now(), today: clock.today() });
      await commit([{ type: "put", collection: "leads", id: record.id, data: record }]);
      return record.id;
    },
    /** Inline quick edit of a single field; same validation as the full form. */
    updateField: (id, key, value) => changeLead(id, () => ({ [key]: value })),
    /** A save that changes nothing leaves no history entry. */
    updateLead: (id, input) => changeLead(id, () => input),
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
    /** Status and, for disqualifiziert, the reason, validated together and written in one patch. */
    changeStatus: (id, status, reason) => changeLead(id, () => transition(status, reason)),
    setLostReason: (id, reason) => changeLead(id, (l) => lostReasonPatch(l, reason)),
    closeWithoutReply: (id) => changeLead(id, () => transition("disqualifiziert", "Nicht erreicht")),
    setFollowUp: (id, date) => changeLead(id, (l) => followUpPatch(l, date)),
    setNextStep: (id, text) => changeLead(id, () => ({ nextStep: String(text || "").trim() })),
    /**
     * Changes the given parts of a lead's Kundenakte. `before` is the Kundenakte as a form or an agent read it ({} for
     * none): if it changed since, nothing is saved, so a writer can never undo someone else's entry. Both sides are
     * compared in today's shape, so a Kundenakte stored before a part was added still saves. Says whether anything changed.
     */
    saveAccount: (id, parts, before) => retrying(async () => {
      const l = await lead(id);
      const stored = accountOf(l);
      if (JSON.stringify(normalizeAccount(before, ids.newId)) !== JSON.stringify(stored)) {
        throw new ValidationError("account", "Die Kundenakte wurde inzwischen ge\xE4ndert. Bitte neu \xF6ffnen.");
      }
      const account = normalizeAccount(mergeAccount(stored, parts), ids.newId);
      if (JSON.stringify(account) === JSON.stringify(stored)) return false;
      await commit([patchOp(l, { account })]);
      return true;
    }),
    logActivity,
    /** How an appointment went, on a Qualifiziert lead. */
    meetingOutcome: (id, meeting) => changeLead(id, (l) => meetingPatch(l, meeting, clock.today())),
    /** A phone call and how it ended: logged, and the lead moved on by the outcome, in one write. */
    logCall: async (id, call) => logContact(id, callActivity(call, clock.today()), (l, acts, activity) => planAfterCall(l, acts, activity, call)),
    /** The business asked not to be contacted again: record it (dated) and close the lead. */
    optOut: (id, note) => retrying(async () => recordOptOut(await lead(id), "Opt-out: m\xF6chte keine Nachrichten mehr." + (note ? " " + String(note).trim() : ""))),
    /**
     * The recipient used the link in a mail. Once is enough: a lead already opted out stays as it is.
     * A lead in the Papierkorb is opted out there, so a restore cannot make it mailable again.
     */
    unsubscribe: (id) => retrying(async () => {
      const live = await store.get("leads", id);
      const l = live || await store.getDeleted("leads", id);
      if (l && !l.optOutAt) await recordOptOut(l, "Opt-out \xFCber den Abmeldelink in einer E-Mail.", { trashed: !live });
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
      const sent = await mailer.send({ leadId: id, to: l.email, subject, text, serviceMail: !getsUnsubscribeLink(l) });
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
      return mailer.draft({ leadId: id, to: l.email, subject, text, serviceMail: !getsUnsubscribeLink(l) });
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
        leads: (r) => {
          // The browser upgrades an old backup whole, with its activities (chunkBackup); one chunk alone could not.
          if (!(r.schemaVersion >= SCHEMA_VERSION)) throw new ValidationError("backup", "Format vor 1.4.0 \u2013 bitte die App neu laden und erneut importieren");
          // Normalized against its own status: a record brought back is no status change, so it keeps its wonAt.
          return { ...normalizeLead(r, { ...LEAD_FIELDS, status: r.status }, clock.today()), ...(r.account && { account: normalizeAccount(r.account, ids.newId) }), schemaVersion: SCHEMA_VERSION, createdAt: r.createdAt || now, updatedAt: r.updatedAt || now };
        },
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
