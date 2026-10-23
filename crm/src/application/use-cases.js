import { BACKUP_FORMAT } from "../domain/backup.js";
import { COLLECTIONS, SCHEMA_VERSION } from "../domain/constants.js";
import { newActivityRecord, assertMayContact, assertHappened, planAfterActivity, firstContactOf, callActivity, planAfterCall, meetingPatch, planMeeting, mailActivityId, byTimeline, sameMail, hasSpoken } from "../domain/activity.js";
import { normalizeLead, toolName, LEAD_FIELDS, isContact, transition, lostReasonPatch, followUpPatch, optOutPatch, clearOptOutPatch, getsUnsubscribeLink, heldToOptOuts, addressOptOutText } from "../domain/lead.js";
import { startCustomer, customerOf, customerPlan, customerAfter, normalizeCustomer, carePlansNextStep, isCareStep, careFromToday, rearrangesSteps, careForPackage } from "../domain/customer.js";
import { normalizeTemplate } from "../domain/template.js";
import { normalizeAccount, accountOf, mergeAccount, accountPatch, ownContactIn } from "../domain/account.js";
import { normalizeTodos, todosOf, todosAfter } from "../domain/todos.js";
import { normalizeOrders, ordersOf, ordersAfter, orderFromDeal, packageOf, packageOfLead } from "../domain/orders.js";
import { ValidationError, ConflictError } from "../domain/errors.js";
import { notesAfter, normalizeEntries } from "../domain/notes.js";

/**
 * The only write path. The web app (RPC) and agents (MCP) both call these,
 * so every business rule holds whoever writes. `actor` is recorded on each write.
 */
const lines = (a) => (a || []).map((s) => String(s).trim()).filter(Boolean);
const normalizeIcp = (icp) => ({ fit: lines(icp.fit), noFit: lines(icp.noFit), note: String(icp.note || "") });
const ATTEMPTS = 3;
const OPT_OUT_TEXT = "Opt-out: m\xF6chte keine Nachrichten mehr.";
// What undoCall sets back: everything a call changes on a lead (planAfterCall) but an opt-out, which stays.
/** The day 1.24.0 shipped: until then any contact, a mail included, dated a lead's first contact. */
const ATTEMPTS_DATED_UNTIL = "2026-10-19";
const CALL_FIELDS = ["status", "lostReason", "followUp", "nextStep", "contactedAt"];

/**
 * `pause(attempt)` waits before the retry after that attempt (retryPause in adapters/system.js, which the Worker passes).
 * Without one, the retry runs at once: still correct, only the writers that collided do not spread out.
 * `email` is the signed-in user's, who owns a customer they win ("" for a writer who is no user, the unsubscribe link);
 * `team` the users who may look after a customer (ALLOWED_EMAILS).
 */
export function createUseCases({ store, clock, ids, actor, email = "", team = [], mailer = null, pause = async () => {} }) {
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
  // Only someone of the team looks after a customer; an owner from elsewhere (an old backup) is nobody.
  const teamOwned = (c) => team.includes(c.owner) ? c : { ...c, owner: "" };
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
    // Notes given as text (an agent's update_lead or create_lead, the new-lead form) are one more note by whoever
    // writes, never a rewrite of the notes there are; none given (null, empty) changes none.
    let noteEntries = null;
    if ("notes" in patch) {
      const { notes: text, ...rest } = patch;
      patch = rest;
      if (typeof text === "string" && text.trim()) ({ noteEntries } = notesAfter(l, { add: text }, noteContext()));
    }
    let next = normalizeLead(patch, l, today);
    if (next.optOutAt && !l.optOutAt) {
      activity ||= newActivityRecord({ leadId: l.id, direction: "in", channel: "Sonstiges", date: today, text: optOutText }, { id: ids.newId(), now: clock.now(), today });
      next = normalizeLead({ ...patch, ...optOutPatch(next.optOutAt, next), contactedAt: firstContactOf([activity], next.contactedAt) }, l, today);
    }
    // The day a lead first becomes Kunde its care starts, owned by whoever won it; the first onboarding step is
    // its next step, unless the change gives one (a date or a text). Not after an opt-out, which leaves a Kunde
    // no follow-up.
    const customer = next.status === "kunde" && l.status !== "kunde" && !l.customer ? startCustomer(today, email) : null;
    if (customer && !next.optOutAt && !patch.followUp && !patch.nextStep) next = normalizeLead({ ...next, ...customerPlan(customer) }, l, today);
    // Kunde set back before any step was done was set by mistake: the care goes, so a real win later starts it anew,
    // and the step it planned goes too, so the lead shows it has no next step until a person plans one.
    const care = l.customer && normalizeCustomer(l.customer);
    const dropped = l.status === "kunde" && next.status !== "kunde" && !!care && !care.steps.some((s) => s.at);
    if (dropped && isCareStep(next.nextStep, care) && !("nextStep" in patch)) next = normalizeLead({ ...next, followUp: null, nextStep: "" }, l, today);
    const activityOps = activity ? [{ type: "put", collection: "activities", id: activity.id, data: activity, trashed }] : [];
    if (isNew) return [...activityOps, { type: "put", collection: "leads", id: l.id, data: { ...l, ...next, ...(customer && { customer }), ...(noteEntries && { noteEntries }) } }];
    const diff = { ...changed(l, next), ...(customer && { customer }), ...(dropped && { customer: null }), ...(noteEntries && { noteEntries }) };
    return activity || Object.keys(diff).length ? [...activityOps, patchOp(l, diff)] : [];
  }
  /** A reservation system typed as one a lead has already, whatever the case, is written as that one is spelled. */
  const knownTool = async (patch) => typeof patch.currentTool === "string" ? { ...patch, currentTool: toolName(patch.currentTool, await store.toolNames()) } : patch;
  const noteContext = () => ({ today: clock.today(), now: clock.now(), by: email, newId: ids.newId });
  /**
   * What writing a changed care does to the lead: the care itself, if it changed, and, where the change plans it (carePlansNextStep), the next step. Rearranged steps move
   * only a next step the care planned, so a Termin or a Rückruf a person planned stays; after an opt-out only its text
   * moves, as a Kunde then has no follow-up. A live customer's first check-in day, set by this change, is its next step
   * too, unless a person planned one.
   */
  const careDiff = (l, stored, before, customer, change) => {
    const carePlanned = !l.nextStep || l.nextStep === "Antworten" || isCareStep(l.nextStep, before);
    const startsCheckIns = customer.phase === "live" && !!customer.nextCheckIn && !stored.nextCheckIn && carePlanned;
    const replans = carePlansNextStep(before, customer, change) && (!rearrangesSteps(change) || carePlanned);
    const plan = replans || startsCheckIns ? customerPlan(customer) : {};
    if (l.optOutAt) delete plan.followUp;
    const careChanged = JSON.stringify(customer) !== JSON.stringify(l.customer && normalizeCustomer(l.customer));
    return { ...changed(l, normalizeLead(plan, l, clock.today())), ...(careChanged && { customer }) };
  };
  const changed = (l, next) => Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(l[k] ?? null)));
  // `l` itself is the base: its version symbol is not copied by a spread.
  const patchOp = (l, diff) => ({ type: "patch", collection: "leads", id: l.id, base: l, data: touch(diff) });
  /**
   * The common shape: read the lead, compute a patch from it, write it only if the lead is still as read. Says whether
   * anything changed. Back to Neu clears the first contact and the plan, as a Neu lead has neither, but only for a lead
   * nobody spoke with (triedOnly); any other is refused, whatever the patch says about its first contact.
   */
  const changeLead = (id, compute) => retrying(async () => {
    const l = await lead(id);
    let patch = await knownTool(compute(l));
    // Spoken with, the first contact stays whatever the patch says, so normalizeLead refuses Neu.
    if (patch.status === "neu" && l.status !== "neu" && l.contactedAt) patch = triedOnly(l, await store.activitiesOf(id)) ? { ...patch, contactedAt: null, followUp: null, nextStep: "" } : { ...patch, contactedAt: l.contactedAt };
    const ops = leadOps(l, patch);
    if (ops.length) await commit(ops);
    return ops.length > 0;
  });
  /**
   * A lead only tried: Kontaktiert, or closed as "Nicht erreicht" after the mails, with no conversation logged, and its
   * first contact the day of an attempt, as a mail dated it until 1.24.0 (ATTEMPTS_DATED_UNTIL); since then an attempt
   * dates nothing. A first contact with no entry that day, or a later one, was set by hand or by an agent for a
   * conversation held outside the CRM, which counts as speaking with them. An appointment or a win is one too, though
   * "Termin eintragen" and the meeting's outcome log no entry.
   */
  const triedOnly = (l, acts) => (l.status === "kontaktiert" || l.status === "disqualifiziert" && l.lostReason === "Nicht erreicht") && l.contactedAt <= ATTEMPTS_DATED_UNTIL && !hasSpoken(acts) && acts.some((a) => a.date === l.contactedAt);
  async function lead(id) {
    const found = await store.get("leads", id);
    if (!found) throw new ValidationError("id", "Betrieb nicht gefunden");
    return found;
  }
  /**
   * `sent`: sendEmail sent this mail; it passed assertAddressOpen before it went out and is logged as it happened.
   * Any other outgoing E-Mail logged here is refused where sending is. A Gmail message comes with its `mail`, the id
   * it is logged under (mailActivityId) and when it came (`at`); one already logged under that id is not logged
   * again (null), whoever came first: sendEmail or the sync. One the sync `found` is not logged either where the lead
   * holds it already (sameMail); an entry made without Gmail takes it and the time it came, so it stands for no other
   * mail, an answer to it goes into its thread, and it sorts where the mail came. `planOf` may be async.
   */
  const logContact = (id, input, planOf, { sent = false, activityId = null, at = null, mail = null, found = false } = {}) => retrying(async () => {
    const l = await lead(id);
    assertMayContact(l, input.direction);
    const today = clock.today();
    const activity = newActivityRecord({ ...input, leadId: id }, { id: activityId || ids.newId(), now: at || clock.now(), today, mail });
    assertHappened(activity, today);
    const acts = await store.activitiesOf(id);
    // The entry that is this message, else the earliest made without Gmail: each stands for one mail, the first found for it.
    const same = acts.filter((a) => a.id === activity.id || found && sameMail(a, activity));
    const held = same.find((a) => a.mail) ?? same.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))[0];
    if (held) {
      if (!held.mail) await commit([{ type: "patch", collection: "activities", id: held.id, base: held, data: { mail: activity.mail, createdAt: activity.createdAt } }]);
      return null;
    }
    if (!sent && activity.direction === "out" && activity.channel === "E-Mail") await assertAddressOpen(l);
    const plan = await planOf(l, acts, activity, today);
    await commit(leadOps(l, plan, { activity }));
    return { activity, plan };
  });
  const logActivity = (id, input) => logContact(id, input, planAfterActivity);
  /**
   * What a mail the sync found changes: what any contact does, but what a person set since the mail came stays, as
   * they decided it after the mail. A follow-up or next step set since stays; a status set since keeps the status and
   * the whole plan (a business closed since stays closed, with its reason). Only an answer of ours still ends
   * "Antworten" and dates the next follow-up, as it went out; it moves only a follow-up due by then, so a later one stays.
   */
  async function foundMailPlan(l, acts, activity, today) {
    const plan = planAfterActivity(l, acts, activity, today);
    if (!("status" in plan || "followUp" in plan || "nextStep" in plan)) return plan;
    const setAt = await store.planSetAt(l.id);
    const since = (field) => activity.createdAt < (setAt?.[field] ?? "");
    const answered = plan.nextStep === "" && l.nextStep === "Antworten";
    const kept = { status: since("status"), followUp: !answered && (since("followUp") || since("status")), nextStep: !answered && (since("status") || since("nextStep")) };
    return Object.fromEntries(Object.entries(plan).filter(([field]) => !kept[field]));
  }
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
   * incoming entries stay allowed. Not for a Kunde (heldToOptOuts): its service mail still goes out, unless the Kunde
   * itself opted out (assertMayContact). Fails closed: a failed query lets nothing through.
   */
  async function assertAddressOpen(l) {
    if (!l.email || !heldToOptOuts(l)) return;
    const holder = await store.optOutByAddress(l.email);
    if (holder) throw new ValidationError("email", addressOptOutText(holder.lead, holder.trashed));
  }

  return {
    async addLead(input) {
      const now = clock.now();
      // A Kontakt is one from the start (normalizeLead keeps the kind a record has).
      const empty = { id: ids.newId(), schemaVersion: SCHEMA_VERSION, ...LEAD_FIELDS, ...(input.kind === "kontakt" && { kind: "kontakt" }), createdAt: now, updatedAt: now };
      await commit(leadOps(empty, await knownTool(input), { isNew: true }));
      return empty.id;
    },
    /** Inline quick edit of a single field; same validation as the full form. */
    updateField: (id, key, value) => changeLead(id, () => ({ [key]: value })),
    /** A save that changes nothing leaves no history entry. */
    updateLead: (id, input) => changeLead(id, () => input),
    /** Moves the lead and its activities to the trash. Deleting a lead that is already gone does nothing. */
    deleteLead: (id) => retrying(async () => {
      const l = await store.get("leads", id);
      if (l) await commit([{ type: "remove", collection: "leads", id, base: l }]);
    }),
    /** Brings a lead back from the trash with the activities deleted together with it. */
    restoreLead: (id) => retrying(async () => {
      const l = await store.getDeleted("leads", id);
      if (!l) {
        if (await store.get("leads", id)) return;
        throw new ValidationError("id", "Nicht im Papierkorb");
      }
      await commit([{ type: "restore", collection: "leads", id, base: l }]);
    }),
    /** Erases a lead in the trash for good, all its activities and history included (a business's right to erasure). */
    purgeLead: (id) => retrying(async () => {
      const l = await store.getDeleted("leads", id);
      if (!l) {
        if (await store.get("leads", id)) throw new ValidationError("id", "Nur Betriebe im Papierkorb lassen sich endg\xFCltig l\xF6schen");
        return;
      }
      await store.purgeLead(l, actor);
    }),
    /** Status and, for disqualifiziert, the reason, validated together and written in one patch. */
    changeStatus: (id, status, reason) => changeLead(id, () => transition(status, reason)),
    setLostReason: (id, reason) => changeLead(id, (l) => lostReasonPatch(l, reason)),
    closeWithoutReply: (id) => changeLead(id, () => transition("disqualifiziert", "Nicht erreicht")),
    setFollowUp: (id, date) => changeLead(id, (l) => followUpPatch(l, date)),
    setNextStep: (id, text) => changeLead(id, () => ({ nextStep: String(text || "").trim() })),
    /**
     * One change to a lead's notes (notesAfter): a new one, by whoever writes, today; its text; or gone. From the notes
     * as they are now, so a note written meanwhile stays. Says whether anything changed.
     */
    changeNote: (id, change) => retrying(async () => {
      const l = await lead(id);
      const patch = notesAfter(l, change, noteContext());
      if (!patch) return false;
      await commit([patchOp(l, patch)]);
      return true;
    }),
    /**
     * Changes the given parts of a lead's Kundenakte. `before` is the Kundenakte as a form or an agent read it ({} for
     * none): if it changed since, nothing is saved, so a writer can never undo someone else's entry. Both sides are
     * compared in today's shape, so a Kundenakte stored before a part was added still saves. A contact added or changed
     * with the business's own email or phone is refused: that one is the lead's. Says whether anything changed.
     */
    saveAccount: (id, parts, before) => retrying(async () => {
      const l = await lead(id);
      // A Kontakt's Kundenakte holds its people only: we keep no systems of theirs.
      if (isContact(l) && Object.values(parts.systems || {}).some((v) => typeof v === "string" ? v.trim() : v && Object.values(v).some((x) => String(x ?? "").trim()))) throw new ValidationError("systems", "Ein Kontakt hat keine Systeme, nur Personen");
      const stored = accountOf(l);
      if (JSON.stringify(normalizeAccount(before, ids.newId)) !== JSON.stringify(stored)) {
        throw new ValidationError("account", "Die Kundenakte wurde inzwischen ge\xE4ndert. Bitte neu \xF6ffnen.");
      }
      const account = normalizeAccount(mergeAccount(stored, parts), ids.newId);
      if (JSON.stringify(account) === JSON.stringify(stored)) return false;
      const own = ownContactIn(account, stored, l);
      if (own) throw new ValidationError("contacts", `${own.name} hat die E-Mail oder Telefonnummer des Betriebs: die steht unter Kontakt, nicht in der Kundenakte`);
      await commit([patchOp(l, { account: accountPatch(l.account, account) })]);
      return true;
    }),
    logActivity,
    /**
     * One change to a Kunde's care (customerAfter): a step ticked or rearranged, the owner (one of the team), the phase
     * or a check-in. A care without a start day or, live, without a check-in day (a Kunde from before, or care stored
     * by 1.20.0) gets them from the day of its first change (careFromToday).
     */
    changeCustomer: (id, change) => retrying(async () => {
      if (change.owner && !team.includes(change.owner)) throw new ValidationError("owner", "Nur jemand aus dem Team kann einen Kunden betreuen");
      const l = await lead(id);
      const stored = customerOf(l);
      if (l.status !== "kunde" || !stored) throw new ValidationError("status", "Nur bei \u201EKunde\u201C");
      const before = careFromToday(stored, clock.today());
      const diff = careDiff(l, stored, before, customerAfter(before, change, { by: actor, today: clock.today(), newId: ids.newId }), change);
      if (!Object.keys(diff).length) return false;
      await commit([patchOp(l, diff)]);
      return true;
    }),
    /**
     * One change to a Kunde's Aufträge (ordersAfter), on the Aufträge as they are when it is written. The first write
     * stores them in place of the Vereinbarung of before, and from then on they give the package: a package picked
     * before 1.30.0 counts until then (packageOfLead) and goes with it. Where the change moves the package, the same
     * write gives the care the steps of the new package (careForPackage) and, as a care change does, the next step.
     * Says whether anything changed.
     */
    changeOrder: (id, change) => retrying(async () => {
      const l = await lead(id);
      if (l.status !== "kunde") throw new ValidationError("status", "Nur bei \u201EKunde\u201C");
      const before = ordersOf(l);
      const orders = ordersAfter(before, change, { newId: ids.newId });
      if (JSON.stringify(orders) === JSON.stringify(before)) return false;
      const from = packageOfLead(l), to = packageOf(orders);
      const stored = customerOf(l);
      const care = stored && from !== to ? careFromToday(stored, clock.today()) : null;
      const diff = care ? careDiff(l, stored, care, careForPackage(care, from, to, clock.today()), { package: to }) : {};
      // The package picked before goes: the care as written, or as stored, without it.
      const picked = !!l.customer && "package" in l.customer;
      const customer = diff.customer || (picked ? normalizeCustomer(l.customer) : null);
      await commit([patchOp(l, { orders, ...(l.deal !== undefined && { deal: null }), ...diff, ...(customer && { customer: { ...customer, ...(picked && { package: null }) } }) })]);
      return true;
    }),
    /** One change to a business's todos (todosAfter), on the todos as they are when it is written. Says whether anything changed. */
    changeTodo: (id, change) => retrying(async () => {
      const l = await lead(id);
      const before = todosOf(l);
      const todos = todosAfter(before, change, { today: clock.today(), newId: ids.newId });
      if (JSON.stringify(todos) === JSON.stringify(before)) return false;
      await commit([patchOp(l, { todos })]);
      return true;
    }),
    /** How an appointment went, on a Qualifiziert lead. */
    meetingOutcome: (id, meeting) => changeLead(id, (l) => meetingPatch(l, meeting, clock.today())),
    /**
     * An appointment agreed by mail, message or in person: the lead moves on as for a Termin on a call, and no call is
     * logged. Refused after an opt-out, as a call is: a Kunde would keep its status and take the date.
     */
    scheduleMeeting: (id, meeting) => changeLead(id, (l) => {
      assertMayContact(l, "out");
      return planMeeting(l, meeting, clock.today());
    }),
    /** A phone call and how it ended: logged, and the lead moved on by the outcome, in one write. */
    logCall: async (id, call) => logContact(id, callActivity(call, clock.today()), (l, acts, activity) => {
      if (isContact(l)) throw new ValidationError("outcome", "Ein Kontakt hat keine Anrufergebnisse: das Gespr\xE4ch eintragen");
      return planAfterCall(l, acts, activity, call);
    }),
    /**
     * Takes back a call logged by mistake: the call is erased (no restore of the lead brings it back, no Änderungen
     * entry keeps it) and the lead's CALL_FIELDS return to what they were before it. Only the lead's newest activity,
     * and only while nothing wrote the lead since the call; a call that recorded an opt-out cannot be taken back.
     */
    undoCall: (activityId) => retrying(async () => {
      const call = await store.get("activities", activityId);
      if (!call?.outcome) throw new ValidationError("activityId", "Anruf nicht gefunden");
      const l = await lead(call.leadId);
      const newest = (await store.activitiesOf(l.id)).sort(byTimeline).at(-1);
      const before = newest?.id === call.id ? await store.leadBefore(l, call) : null;
      if (!before) throw new ValidationError("activityId", "Nur der letzte Anruf l\xE4sst sich zur\xFCcknehmen, solange der Betrieb seitdem unver\xE4ndert ist.");
      if (l.optOutAt && !before.optOutAt) throw new ValidationError("activityId", "Ein Opt-out l\xE4sst sich nicht zur\xFCcknehmen.");
      // Checked against the lead before the call, so a first contact the call set may go again.
      const next = normalizeLead({ ...l, ...Object.fromEntries(CALL_FIELDS.map((k) => [k, before[k]])) }, before, clock.today());
      await commit([{ type: "discard", collection: "activities", id: call.id, base: call }, patchOp(l, changed(l, next))]);
      return true;
    }),
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
    /**
     * Sends from the signed-in user's Gmail, then logs the activity under the id the sync gives the same message.
     * `replyTo`: a mail of this lead it answers, in that mail's thread when the thread is in this user's mailbox (each
     * mailbox has its own threads); else it starts one. `signed`: with the user's Gmail signature.
     */
    async sendEmail(id, { subject, text, templateId, replyTo = null, signed = true }) {
      const l = await mailable(id);
      const answered = replyTo ? (await store.activitiesOf(id)).find((a) => a.id === replyTo && a.mail) : null;
      if (replyTo && !answered) throw new ValidationError("replyTo", "Die beantwortete E-Mail gibt es nicht mehr.");
      const inThread = answered && answered.mail.mailbox === mailer.mailbox;
      const sent = await mailer.send({ leadId: id, to: l.email, subject, text, serviceMail: !getsUnsubscribeLink(l), signed, ...(inThread && { thread: { threadId: answered.mail.threadId, messageId: answered.mail.messageId } }) });
      try {
        const mail = { gmailId: sent.id, threadId: sent.threadId, mailbox: mailer.mailbox, subject, from: mailer.mailbox, to: l.email, messageId: sent.messageId };
        const options = { sent: true, activityId: await mailActivityId(mailer.mailbox, sent.id), mail };
        return { ...(await logContact(id, { direction: "out", channel: "E-Mail", text, templateId }, planAfterActivity, options)), gmail: sent };
      } catch (e) {
        // The mail is out; say so instead of inviting a second send.
        throw new ValidationError("activity", `E-Mail wurde gesendet, aber nicht eingetragen (${e.message}). Bitte manuell eintragen.`);
      }
    },
    /**
     * A message the Gmail sync found in `mail.mailbox`, to or from this lead, dated `date` (the day it came, `at`).
     * Logged by the rules of any contact; an outgoing one is refused where sending is (an opt-out, a closed address),
     * so it is never logged as sent. An incoming one is always logged, also on an opted-out lead. Null when the lead
     * holds it already.
     */
    recordMail: async (leadId, { direction, date, at, text, mail }) => logContact(leadId, { direction, channel: "E-Mail", date, text }, foundMailPlan,
      { activityId: await mailActivityId(mail.mailbox, mail.gmailId), at, mail, found: true }),
    /** Agents prepare, people send: a Gmail draft with the user's signature, ready to send as it is; nothing logged. */
    async draftEmail(id, { subject, text }) {
      const l = await mailable(id);
      return mailer.draft({ leadId: id, to: l.email, subject, text, serviceMail: !getsUnsubscribeLink(l), signed: true });
    },
    /**
     * What "Mit Signatur" adds to a mail: whether the signed-in user has a Gmail signature (`has`) and its text ("" for
     * one that is only an image); null when Gmail cannot give it.
     */
    async signature() {
      const sig = mailer && await mailer.signature();
      return sig ? { has: !!sig.html, text: sig.text } : null;
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
      const tools = await store.toolNames();
      const normalize = {
        leads: (r) => {
          // The browser upgrades an old backup whole, with its activities (chunkBackup); one chunk alone could not.
          if (!(r.schemaVersion >= SCHEMA_VERSION)) throw new ValidationError("backup", "Format vor 1.4.0 \u2013 bitte die App neu laden und erneut importieren");
          // Normalized against its own status and kind: a record brought back is no status change, so it keeps its wonAt.
          const kind = r.kind === "kontakt" ? { kind: "kontakt" } : {};
          return { ...normalizeLead({ ...r, ...(!kind.kind && { currentTool: toolName(r.currentTool, tools) }) }, { ...LEAD_FIELDS, status: r.status, ...kind }, clock.today()), ...(r.account && { account: normalizeAccount(r.account, ids.newId) }), ...(r.customer && { customer: teamOwned(normalizeCustomer(r.customer)) }), ...(r.todos && { todos: normalizeTodos(r.todos, ids.newId) }), ...((r.orders || r.deal) && { orders: r.orders ? normalizeOrders(r.orders, ids.newId) : [orderFromDeal(r.deal)] }), ...(r.noteEntries && { noteEntries: normalizeEntries(r.noteEntries) }), schemaVersion: SCHEMA_VERSION, createdAt: r.createdAt || now, updatedAt: r.updatedAt || now };
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
