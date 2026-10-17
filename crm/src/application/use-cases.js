import { BACKUP_FORMAT } from "../domain/backup.js";
import { COLLECTIONS, SCHEMA_VERSION } from "../domain/constants.js";
import { newActivityRecord, assertMayContact, assertHappened, planAfterActivity, firstContactOf, callActivity, planAfterCall, meetingPatch } from "../domain/activity.js";
import { normalizeLead, LEAD_FIELDS, transition, lostReasonPatch, followUpPatch, optOutPatch, clearOptOutPatch, getsUnsubscribeLink, addressOptOutText } from "../domain/lead.js";
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
const OPT_OUT_TEXT = "Opt-out: m\xF6chte keine Nachrichten mehr.";

/**
 * `pause(attempt)` waits before the retry after that attempt (retryPause in adapters/system.js, which the Worker passes).
 * Without one, the retry runs at once: still correct, only the writers that collided do not spread out.
 */
export function createUseCases({ store, clock, ids, actor, mailer = null, pause = async () => {} }) {
  /**
   * Read, decide, commit. A write that names its read as `base` fails with ConflictError if someone wrote the
   * record in between; then the whole step runs again on fresh state, after a pause, so writers that collided
   * do not all read and commit again at the same moment. After ATTEMPTS the ConflictError reaches the caller.
   */
  async function retrying(step) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt === ATTEMPTS) throw e;
      }
      await pause(attempt);
    }
  }
  const touch = (patch) => ({ ...patch, updatedAt: clock.now() });
  const commit = (ops, unchanged) => store.commit(ops, actor, unchanged);
  /**
   * Every change to a lead's fields goes through here, and every lead addLead creates; only importBackup writes a
   * lead without it, one the CRM never held, through normalizeLead alone. The Kundenakte has its own rules
   * (normalizeAccount), and saveAccount writes it with the same guard. The patch runs through normalizeLead on the
   * read lead and every field that differs is written, so what the rules derive (a cleared reason, contactedAt, an
   * opt-out) holds on every path. `isNew`: `l` is the empty lead addLead starts from, written whole. `activity` is
   * a contact logged in the same write; with one, the lead is always written (at least updatedAt), so a concurrent
   * opt-out, status change or delete is never missed. No ops when nothing changes.
   *
   * A patch that opts the lead out is the opt-out, whichever way it comes (the Opt-out button, the reason
   * "Keine Kontaktaufnahme gewünscht" picked anywhere, a call, the link): it closes the lead as optOutPatch does
   * and says in the Verlauf how the opt-out reached us (`optOutText`), unless the activity logged with it does (a call).
   * That entry is their message, a contact like any other: it dates the first contact, as planAfterActivity does.
   * `trashed`: the lead is in the Papierkorb; the entry goes there with it, so a restore brings both back.
   */
  function leadOps(l, patch, { activity = null, optOutText = OPT_OUT_TEXT, trashed = false, isNew = false } = {}) {
    const today = clock.today();
    let next = normalizeLead(patch, l, today);
    if (next.optOutAt && !l.optOutAt) {
      activity ||= newActivityRecord({ leadId: l.id, direction: "in", channel: "Sonstiges", date: today, text: optOutText }, { id: ids.newId(), now: clock.now(), today });
      next = normalizeLead({ ...patch, ...optOutPatch(next.optOutAt, next), contactedAt: firstContactOf([activity], next.contactedAt) }, l, today);
    }
    const activityOps = activity ? [{ type: "put", collection: "activities", id: activity.id, data: activity, trashed }] : [];
    if (isNew) return [...activityOps, { type: "put", collection: "leads", id: l.id, data: { ...l, ...next } }];
    const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(l[k] ?? null)));
    return activity || Object.keys(diff).length ? [...activityOps, patchOp(l, diff)] : [];
  }
  // `l` itself is the base: its version symbol is not copied by a spread.
  const patchOp = (l, diff) => ({ type: "patch", collection: "leads", id: l.id, base: l, data: touch(diff) });
  /** The common shape: read the lead, compute a patch from it, write it only if the lead is still as read. Says whether anything changed. */
  const changeLead = (id, compute) => retrying(async () => {
    const l = await lead(id);
    const ops = leadOps(l, compute(l));
    if (ops.length) await commit(ops);
    return ops.length > 0;
  });
  async function lead(id) {
    const found = await store.get("leads", id);
    if (!found) throw new ValidationError("id", "Betrieb nicht gefunden");
    return found;
  }
  /**
   * `sent`: sendEmail sent this mail; it passed assertAddressOpen before it went out and is logged as it happened.
   * Any other outgoing E-Mail logged here is refused where sending is.
   */
  const logContact = (id, input, planOf, { sent = false } = {}) => retrying(async () => {
    const l = await lead(id);
    assertMayContact(l, input.direction);
    const activity = newActivityRecord({ ...input, leadId: id }, { id: ids.newId(), now: clock.now(), today: clock.today() });
    assertHappened(activity, clock.today());
    if (!sent && activity.direction === "out" && activity.channel === "E-Mail") await assertAddressOpen(l);
    const plan = planOf(l, await store.activitiesOf(id), activity);
    await commit(leadOps(l, plan, { activity }));
    return { activity, plan };
  });
  const logActivity = (id, input) => logContact(id, input, planAfterActivity);
  /** The opt-out, dated today. Once is enough: a lead already opted out stays as it is. */
  const recordOptOut = async (l, optOutText, trashed = false) => {
    if (!l.optOutAt) await commit(leadOps(l, optOutPatch(clock.today(), l), { optOutText, trashed }));
  };
  async function mailable(id) {
    if (!mailer) throw new ValidationError("gmail", "Gmail ist nicht verbunden. Bitte neu anmelden.");
    const l = await lead(id);
    assertMayContact(l, "out");
    if (!l.email) throw new ValidationError("email", "Keine E-Mail-Adresse hinterlegt");
    await assertAddressOpen(l);
    return l;
  }
  /**
   * Any lead's opt-out closes its address to mail: none is sent, drafted or logged as sent. Calls, other channels and
   * incoming entries stay allowed. Only for a lead that gets the Abmeldelink: a Kunde's service mail still goes out,
   * unless the Kunde itself opted out (assertMayContact). Fails closed: a failed query lets nothing through.
   */
  async function assertAddressOpen(l) {
    if (!l.email || !getsUnsubscribeLink(l)) return;
    const holder = await store.optOutByAddress(l.email);
    if (holder) throw new ValidationError("email", addressOptOutText(holder.lead, holder.trashed));
  }

  return {
    async addLead(input) {
      const now = clock.now();
      const empty = { id: ids.newId(), schemaVersion: SCHEMA_VERSION, ...LEAD_FIELDS, createdAt: now, updatedAt: now };
      await commit(leadOps(empty, input, { isNew: true }));
      return empty.id;
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
    optOut: (id, note) => retrying(async () => recordOptOut(await lead(id), OPT_OUT_TEXT + (note ? " " + String(note).trim() : ""))),
    /**
     * The recipient used the link in a mail. A lead in the Papierkorb is opted out there, so a restore cannot
     * make it mailable again.
     */
    unsubscribe: (id) => retrying(async () => {
      const live = await store.get("leads", id);
      const l = live || await store.getDeleted("leads", id);
      if (l) await recordOptOut(l, "Opt-out \xFCber den Abmeldelink in einer E-Mail.", !live);
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
        return { ...(await logContact(id, { direction: "out", channel: "E-Mail", text, templateId }, planAfterActivity, { sent: true })), gmail: sent };
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
     * opt-out nor bring back something deleted. An activity goes where its lead is: into the Papierkorb with a
     * deleted lead, so a restore brings both back, and nowhere once the lead is erased. Re-running an import is
     * safe; the client sends it in chunks.
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
      const ops = [], known = {}, leadsAsRead = new Map();
      for (const collection of COLLECTIONS) {
        known[collection] = await store.ids(collection);
        const records = (backup.data?.[collection] || []).filter((r) => !known[collection].has(r.id) && (collection !== "settings" || r.id === "icp"));
        const held = collection === "activities" && records.length ? await store.heldLeads([...new Set(records.map((r) => r.leadId))]) : new Map();
        for (const record of records) {
          try {
            const { id: _id, ...data } = normalize[collection](record);
            const lead = held.get(data.leadId);
            // An erased lead stays erased: none of its activities comes back.
            if (collection === "activities" && !lead && known.leads.has(data.leadId)) continue;
            if (lead) leadsAsRead.set(lead.lead.id, { collection: "leads", id: lead.lead.id, base: lead.lead });
            ops.push({ type: "put", collection, id: record.id, data, trashed: lead?.trashed });
          } catch (e) {
            throw new ValidationError("backup", `${collection} ${record.id}: ${e.message}`);
          }
        }
      }
      // Commits only while each lead is still as read, so an erase in between cannot leave an activity behind.
      // Not retried: a chunk's writes take most of D1's queries per request; the conflict asks to run the import again, which is safe.
      await commit(ops, [...leadsAsRead.values()]);
      return ops.length;
    }
  };
}
