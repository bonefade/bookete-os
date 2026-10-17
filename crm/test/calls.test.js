import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { ValidationError } from "../src/domain/errors.js";
import { countTouches, hasReply, meetingDue } from "../src/domain/activity.js";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };
function setup() {
  const store = createStore(createD1());
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)" });
  return { store, uc };
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
  // The fifth attempt without getting through closes only a lead in the sequence.
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
  assert.deepEqual(shape(await store.get("leads", id)), ["kunde", null, "", null]);
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
