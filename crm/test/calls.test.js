import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { ValidationError } from "../src/domain/errors.js";
import { countTouches, hasReply, meetingDue } from "../src/domain/activity.js";
import { BACKUP_FORMAT } from "../src/domain/backup.js";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };
function setup() {
  const db = createD1();
  const store = createStore(db);
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)" });
  return { db, store, uc };
}
const rejects = (promise, field) => assert.rejects(promise, (e) => e instanceof ValidationError && e.field === field);
const mcp = async (context, name, args) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), context)).json()).result;
const shape = (l) => [l.status, l.followUp, l.nextStep, l.lostReason];

test("Nicht erreicht: Kontaktiert, call again in two days; the fifth unanswered attempt closes the lead", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  const { activity } = await uc.logCall(id, { outcome: "nicht-erreicht", note: "Mailbox" });
  assert.deepEqual([activity.channel, activity.direction, activity.outcome, activity.text], ["Telefon", "out", "nicht-erreicht", "Nicht erreicht\nMailbox"]);
  assert.deepEqual(shape(await store.get("leads", id)), ["kontaktiert", "2026-10-17", "", null]);
  // Earlier attempts on other days, e.g. emails: the fifth contact without an answer is the last.
  for (const date of ["2026-10-01", "2026-10-05", "2026-10-09"]) await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Hallo", date });
  await uc.logCall(id, { outcome: "nicht-erreicht" });
  assert.deepEqual(shape(await store.get("leads", id)), ["kontaktiert", "2026-10-17", "", null]);
  const later = setup();
  const l = await later.uc.addLead({ name: "Post", phone: "+43 2" });
  for (const date of ["2026-10-01", "2026-10-05", "2026-10-09", "2026-10-12"]) await later.uc.logActivity(l, { direction: "out", channel: "Telefon", text: "Angerufen", date });
  await later.uc.logCall(l, { outcome: "nicht-erreicht" });
  assert.deepEqual(shape(await later.store.get("leads", l)), ["disqualifiziert", null, "", "Nicht erreicht"]);
});

test("Rückruf and Termin need a date from today on; Termin qualifies the lead", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  await rejects(uc.logCall(id, { outcome: "rueckruf" }), "date");
  await rejects(uc.logCall(id, { outcome: "rueckruf", date: "2026-10-14" }), "date");
  await rejects(uc.logCall(id, { outcome: "rueckruf", date: "2026-10-20", time: "25:00" }), "time");
  assert.equal((await store.activitiesOf(id)).length, 0);
  await uc.logCall(id, { outcome: "rueckruf", date: "2026-10-20", time: "11:30" });
  assert.deepEqual(shape(await store.get("leads", id)), ["kontaktiert", "2026-10-20", "R\xFCckruf um 11:30", null]);
  await uc.logCall(id, { outcome: "termin", date: "2026-10-22" });
  const l = await store.get("leads", id);
  assert.deepEqual(shape(l), ["qualifiziert", "2026-10-22", "Termin", null]);
  assert.deepEqual((await store.activitiesOf(id)).map((a) => a.text), ["R\xFCckruf am 20.10.2026 um 11:30", "Termin vereinbart: 22.10.2026"]);
});

test("an appointment agreed by mail or in person qualifies the lead like a Termin on a call, and logs no call", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", email: "krone@example.at" });
  await uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Gerne am Dienstag" });
  const before = (await store.activitiesOf(id)).length;
  await rejects(uc.scheduleMeeting(id, {}), "date");
  await rejects(uc.scheduleMeeting(id, { date: "2026-10-14" }), "date");
  await rejects(uc.scheduleMeeting(id, { date: "2026-10-20", time: "9 Uhr" }), "time");
  await uc.scheduleMeeting(id, { date: "2026-10-20", time: "15:00" });
  assert.deepEqual(shape(await store.get("leads", id)), ["qualifiziert", "2026-10-20", "Termin um 15:00", null]);
  assert.equal((await store.activitiesOf(id)).length, before);
  assert.equal(meetingDue(await store.get("leads", id), "2026-10-20"), true);
  // A first appointment met in person dates the first contact; a customer stays Kunde.
  const met = await uc.addLead({ name: "Post" });
  await uc.scheduleMeeting(met, { date: "2026-10-15" });
  assert.deepEqual([...shape(await store.get("leads", met)), (await store.get("leads", met)).contactedAt], ["qualifiziert", "2026-10-15", "Termin", null, "2026-10-15"]);
  const kunde = await uc.addLead({ name: "Linde", status: "kunde" });
  await uc.scheduleMeeting(kunde, { date: "2026-10-22" });
  assert.deepEqual(shape(await store.get("leads", kunde)), ["kunde", "2026-10-22", "Termin", null]);
  // After an opt-out nobody may contact them, a Kunde included.
  await uc.optOut(kunde);
  await rejects(uc.scheduleMeeting(kunde, { date: "2026-10-23" }), "optOutAt");
  assert.equal(COMMANDS.scheduleMeeting[0].safeParse({ id: "a", date: "2026-10-20", outcome: "termin" }).success, false);
});

test("Kein Interesse needs a reason and disqualifies with it; the opt-out reason is an opt-out", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  await rejects(uc.logCall(id, { outcome: "kein-interesse" }), "lostReason");
  await rejects(uc.logCall(id, { outcome: "kein-interesse", reason: "Sonstiges" }), "lostReason");
  await uc.logCall(id, { outcome: "kein-interesse", reason: "Zu klein" });
  assert.deepEqual(shape(await store.get("leads", id)), ["disqualifiziert", null, "", "Zu klein"]);
  assert.deepEqual((await store.activitiesOf(id)).map((a) => [a.outcome, a.reason, a.text]), [["kein-interesse", "Zu klein", "Kein Interesse: Zu klein"]]);
  const no = await uc.addLead({ name: "Post", phone: "+43 2" });
  await uc.logCall(no, { outcome: "kein-interesse", reason: "Keine Kontaktaufnahme gew\xFCnscht" });
  assert.equal((await store.get("leads", no)).optOutAt, "2026-10-15");
  await rejects(uc.logCall(no, { outcome: "nicht-erreicht" }), "optOutAt");
  await rejects(uc.logCall(id, { outcome: "vielleicht" }), "outcome");
});

test("a call we got through counts as an answer: the sequence stops counting", () => {
  const out = (date, outcome = null) => ({ direction: "out", channel: "Telefon", date, outcome, createdAt: date });
  assert.equal(hasReply([out("2026-10-01", "nicht-erreicht")]), false);
  assert.equal(hasReply([out("2026-10-01", "rueckruf")]), true);
  assert.equal(countTouches([out("2026-10-01"), out("2026-10-02", "nicht-erreicht"), out("2026-10-03", "termin"), out("2026-10-04")]), 2);
});

test("RPC and MCP log a call through one schema", async () => {
  const { store, uc } = setup();
  const call = COMMANDS.logCall[0];
  assert.equal(call.safeParse({ id: "a", outcome: "rueckruf", date: "2026-10-20", time: "11:30" }).success, true);
  assert.equal(call.safeParse({ id: "a", outcome: "vielleicht" }).success, false);
  assert.equal(call.safeParse({ id: "a", outcome: "kein-interesse", reason: "Sonstiges" }).success, false);
  assert.equal(call.safeParse({ id: "a", outcome: "nicht-erreicht", status: "kunde" }).success, false);
  // After a conversation, "Nicht erreicht" is no reason, and the published schema does not offer it.
  assert.equal(call.safeParse({ id: "a", outcome: "kein-interesse", reason: "Nicht erreicht" }).success, false);
  const { result: listed } = await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), {})).json();
  const reasons = listed.tools.find((t) => t.name === "log_call").inputSchema.properties.reason.enum;
  assert.ok(reasons.includes("Zu klein") && !reasons.includes("Nicht erreicht"), reasons.join());
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  const r = await mcp({ store, clock, uc }, "log_call", { id, outcome: "termin", date: "2026-10-22", time: "10:00" });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(shape(await store.get("leads", id)), ["qualifiziert", "2026-10-22", "Termin um 10:00", null]);
});

test("a missed call keeps a date agreed with them; a Termin with a customer leaves them Kunde", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  await uc.logCall(id, { outcome: "termin", date: "2026-10-22", time: "10:00" });
  await uc.logCall(id, { outcome: "nicht-erreicht" });
  assert.deepEqual(shape(await store.get("leads", id)), ["qualifiziert", "2026-10-22", "Termin um 10:00", null]);
  // Qualified before 1.7.0, or by a status change, with only plain outgoing calls and no answer logged.
  const before = await uc.addLead({ name: "Post", phone: "+43 2", status: "qualifiziert", followUp: "2026-10-22", nextStep: "Termin um 10:00" });
  await uc.logActivity(before, { direction: "out", channel: "Telefon", text: "Angerufen", date: "2026-10-10" });
  await uc.logCall(before, { outcome: "nicht-erreicht" });
  assert.deepEqual(shape(await store.get("leads", before)), ["qualifiziert", "2026-10-22", "Termin um 10:00", null]);
  // A next step set by hand on a lead still in the sequence keeps its date too.
  const planned = await uc.addLead({ name: "Linde", phone: "+43 3" });
  await uc.logActivity(planned, { direction: "out", channel: "E-Mail", text: "Hallo", date: "2026-10-14" });
  await uc.setFollowUp(planned, "2026-10-21");
  await uc.setNextStep(planned, "Vor 15 Uhr anrufen");
  await uc.logCall(planned, { outcome: "nicht-erreicht" });
  assert.deepEqual(shape(await store.get("leads", planned)), ["kontaktiert", "2026-10-21", "Vor 15 Uhr anrufen", null]);
});

test("a call never moves a customer out of Kunde", async () => {
  const { store, uc } = setup();
  const kunde = async () => {
    const id = await uc.addLead({ name: "Post", phone: "+43 2", status: "kunde", nextStep: "Onboarding" });
    for (const date of ["2026-10-01", "2026-10-05", "2026-10-09", "2026-10-12"]) await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Angerufen", date });
    return id;
  };
  const after = async (call) => {
    const id = await kunde();
    await uc.logCall(id, call);
    const acts = await store.activitiesOf(id);
    assert.equal(acts.at(-1).outcome, call.outcome);
    return store.get("leads", id);
  };
  assert.deepEqual(shape(await after({ outcome: "termin", date: "2026-10-20" })), ["kunde", "2026-10-20", "Termin", null]);
  assert.deepEqual(shape(await after({ outcome: "rueckruf", date: "2026-10-20" })), ["kunde", "2026-10-20", "R\xFCckruf", null]);
  // The fifth attempt without getting through closes only a lead in the sequence. The next step typed for the
  // customer is no onboarding step, so the onboarding leaves it.
  assert.deepEqual(shape(await after({ outcome: "nicht-erreicht" })), ["kunde", "2026-10-17", "Onboarding", null]);
  assert.deepEqual(shape(await after({ outcome: "kein-interesse", reason: "Zu klein" })), ["kunde", "2026-10-19", "Onboarding", null]);
  // A customer who asks not to be called again is opted out, and stays Kunde with its next step.
  const no = await after({ outcome: "kein-interesse", reason: "Keine Kontaktaufnahme gew\xFCnscht" });
  assert.deepEqual([...shape(no), no.optOutAt], ["kunde", null, "Onboarding", null, "2026-10-15"]);
});

test("an outcome belongs to a call and its reason to Kein Interesse, on every write path", async () => {
  const { uc } = setup();
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  // We spoke to them, so they were reached.
  await rejects(uc.logCall(id, { outcome: "kein-interesse", reason: "Nicht erreicht" }), "lostReason");
  await rejects(uc.logCall(id, { outcome: "nicht-erreicht", date: "2026-10-20" }), "date");
  await rejects(uc.logCall(id, { outcome: "nicht-erreicht", time: "10:00" }), "time");
  const backup = (a) => ({ format: "bookete-crm-backup", schemaVersion: 3, data: { leads: [], activities: [{ id: "a1", leadId: id, date: "2026-10-01", direction: "out", text: "x", ...a }], templates: [], settings: [] } });
  const refused = (a, why) => assert.rejects(uc.importBackup(backup(a)), (e) => e instanceof ValidationError && e.field === "backup" && e.message.includes(why));
  await refused({ channel: "E-Mail", outcome: "termin" }, "Gespr\xE4chsergebnis");
  await refused({ channel: "Telefon", outcome: "rueckruf", reason: "Zu klein" }, "Grund");
  assert.equal(await uc.importBackup(backup({ channel: "Telefon", outcome: "kein-interesse", reason: "Zu klein" })), 1);
});

test("on the appointment's day: Kunde, no deal with a reason, or a new appointment", async () => {
  const { store, uc } = setup();
  const today = "2026-10-15";
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  await uc.logCall(id, { outcome: "termin", date: today, time: "10:00" });
  const l = await store.get("leads", id);
  assert.equal(meetingDue(l, today), true);
  assert.equal(meetingDue(l, "2026-10-14"), false);
  assert.equal(meetingDue({ ...l, nextStep: "Angebot schicken" }, today), false);
  await rejects(uc.meetingOutcome(id, { result: "kein-abschluss" }), "lostReason");
  await rejects(uc.meetingOutcome(id, { result: "neuer-termin", date: "2026-10-14" }), "date");
  await uc.meetingOutcome(id, { result: "neuer-termin", date: "2026-10-29", time: "09:30" });
  assert.deepEqual(shape(await store.get("leads", id)), ["qualifiziert", "2026-10-29", "Termin um 09:30", null]);
  await uc.meetingOutcome(id, { result: "kunde" });
  // A new customer's next step is the first of its onboarding, due the day it was won.
  assert.deepEqual(shape(await store.get("leads", id)), ["kunde", "2026-10-15", "Vertrag unterschrieben", null]);
  await rejects(uc.meetingOutcome(id, { result: "kunde" }), "status");
  const no = await uc.addLead({ name: "Post", status: "qualifiziert" });
  await uc.meetingOutcome(no, { result: "kein-abschluss", reason: "Kein Bedarf" });
  assert.deepEqual(shape(await store.get("leads", no)), ["disqualifiziert", null, "", "Kein Bedarf"]);
  assert.equal(COMMANDS.meetingOutcome[0].safeParse({ id: "a", result: "vielleicht" }).success, false);
  assert.equal(COMMANDS.meetingOutcome[0].safeParse({ id: "a", result: "kein-abschluss", reason: "Nicht erreicht" }).success, false);
  // A field that does not belong to the answer is refused, not ignored.
  const open = await uc.addLead({ name: "Linde", status: "qualifiziert" });
  await rejects(uc.meetingOutcome(open, { result: "kunde", reason: "Zu klein" }), "lostReason");
  await rejects(uc.meetingOutcome(open, { result: "kunde", date: "2026-10-20" }), "date");
  await rejects(uc.meetingOutcome(open, { result: "kein-abschluss", reason: "Zu klein", time: "10:00" }), "time");
  await rejects(uc.meetingOutcome(open, { result: "neuer-termin", date: "2026-10-20", reason: "Zu klein" }), "lostReason");
  assert.equal((await store.get("leads", open)).status, "qualifiziert");
});

test("a call logged by mistake is taken back: the lead is as before it, and nothing brings the call back", async () => {
  const { db, store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  await uc.setNextStep(id, "Anrufen");
  const before = await store.get("leads", id);
  const { activity } = await uc.logCall(id, { outcome: "termin", date: "2026-10-22" });
  assert.deepEqual(shape(await store.get("leads", id)), ["qualifiziert", "2026-10-22", "Termin", null]);
  assert.equal(COMMANDS.undoCall[0].safeParse({ activityId: activity.id }).success, true);
  assert.equal(await uc.undoCall(activity.id), true);
  const l = await store.get("leads", id);
  assert.deepEqual([...shape(l), l.contactedAt], [...shape(before), null]);
  assert.deepEqual(await store.activitiesOf(id), []);
  await uc.deleteLead(id);
  await uc.restoreLead(id);
  assert.deepEqual(await store.activitiesOf(id), []);
  assert.equal(await store.get("activities", activity.id), null);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM history WHERE collection = 'activities' AND id = ?").bind(activity.id).first()).n, 0);
  await rejects(uc.undoCall(activity.id), "activityId");
});

test("only the newest call is taken back, only while the lead is unchanged since, and never an opt-out", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", phone: "+43 1" });
  const first = (await uc.logCall(id, { outcome: "nicht-erreicht" })).activity;
  const second = (await uc.logCall(id, { outcome: "rueckruf", date: "2026-10-20" })).activity;
  await rejects(uc.undoCall(first.id), "activityId");
  await uc.undoCall(second.id);
  assert.deepEqual(shape(await store.get("leads", id)), ["kontaktiert", "2026-10-17", "", null]);
  // The undo wrote the lead: the call before it stays.
  await rejects(uc.undoCall(first.id), "activityId");
  const changed = (await uc.logCall(id, { outcome: "nicht-erreicht" })).activity;
  await uc.setNextStep(id, "Mittags anrufen");
  await rejects(uc.undoCall(changed.id), "activityId");
  const mail = (await uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Hallo" })).activity;
  await rejects(uc.undoCall(mail.id), "activityId");
  // An import adds an activity without writing its lead: the call is no longer the newest.
  const last = (await uc.logCall(id, { outcome: "nicht-erreicht" })).activity;
  await uc.importBackup({ format: BACKUP_FORMAT, data: { activities: [{ id: "B1", leadId: id, date: "2026-10-15", direction: "in", channel: "E-Mail", text: "Alt", createdAt: "2026-10-15T11:00:00.000Z" }] } });
  await rejects(uc.undoCall(last.id), "activityId");
  const closed = await uc.addLead({ name: "Post", phone: "+43 2" });
  const optOut = (await uc.logCall(closed, { outcome: "kein-interesse", reason: "Keine Kontaktaufnahme gew\xFCnscht" })).activity;
  await assert.rejects(uc.undoCall(optOut.id), { message: "Ein Opt-out l\xE4sst sich nicht zur\xFCcknehmen." });
  assert.ok((await store.get("leads", closed)).optOutAt);
});

test("MCP records an appointment's outcome by the web's rules, and hasEmail is false where no mail may go", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", email: "info@krone.at", status: "qualifiziert" });
  let r = await mcp({ store, clock, uc }, "meeting_outcome", { id, result: "kein-abschluss" });
  assert.ok(r.isError, JSON.stringify(r));
  r = await mcp({ store, clock, uc }, "meeting_outcome", { id, result: "kein-abschluss", reason: "Kein Bedarf" });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(shape(await store.get("leads", id)), ["disqualifiziert", null, "", "Kein Bedarf"]);
  const old = await uc.addLead({ name: "Alte Krone", email: " Info@Krone.at" });
  await uc.optOut(old);
  await uc.deleteLead(old);
  const customer = await uc.addLead({ name: "Kunde Krone", email: "info@krone.at", status: "kunde", contactedAt: "2026-10-01" });
  const open = await uc.addLead({ name: "Linde", email: "linde@example.at" });
  const former = await uc.addLead({ name: "Ex", email: "ex@example.at", status: "kunde", contactedAt: "2026-10-01" });
  await uc.optOut(former);
  const { leads } = JSON.parse((await mcp({ store, clock, uc }, "search_leads", { query: "" })).content[0].text);
  assert.deepEqual(Object.fromEntries(leads.map((l) => [l.id, l.hasEmail])), { [id]: false, [customer]: true, [open]: true, [former]: false });
});
