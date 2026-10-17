import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { ValidationError } from "../src/domain/errors.js";
import { upgradeLead, isDue } from "../src/domain/lead.js";
import { sequenceExhausted, nextActionHint } from "../src/domain/activity.js";
import { STAGES, LOST_REASONS } from "../src/domain/constants.js";
import { chunkBackup } from "../src/domain/backup.js";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };
function setup() {
  const db = createD1();
  const store = createStore(db);
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)" });
  return { store, uc };
}
const rejects = (promise, field) => assert.rejects(promise, (e) => e instanceof ValidationError && e.field === field);
const mcp = async (context, name, args) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), context)).json()).result;

test("five statuses and seven reasons, none of them a catch-all", () => {
  assert.deepEqual(STAGES.map(([k]) => k), ["neu", "kontaktiert", "qualifiziert", "kunde", "disqualifiziert"]);
  assert.deepEqual(LOST_REASONS, ["Zufrieden mit aktueller L\xF6sung", "Kein Bedarf", "Zu klein", "Nicht unsere Zielgruppe", "Geschlossen / existiert nicht", "Nicht erreicht", "Keine Kontaktaufnahme gew\xFCnscht"]);
});

test("disqualifiziert needs a real reason on every write path", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone" });
  await rejects(uc.changeStatus(id, "disqualifiziert"), "lostReason");
  await rejects(uc.changeStatus(id, "disqualifiziert", "Sonstiges"), "lostReason");
  await rejects(uc.updateLead(id, { status: "disqualifiziert" }), "lostReason");
  await rejects(uc.updateField(id, "status", "disqualifiziert"), "lostReason");
  await rejects(uc.addLead({ name: "Neu zu", status: "disqualifiziert" }), "lostReason");
  assert.equal((await store.get("leads", id)).status, "neu");
  assert.equal(COMMANDS.changeStatus[0].safeParse({ id, status: "disqualifiziert", reason: "Sonstiges" }).success, false);
  // The new-lead form sends its empty "Grund wählen …" option; the rules, not the schema, answer it.
  const fromForm = COMMANDS.addLead[0].safeParse({ input: { name: "Form", status: "disqualifiziert", lostReason: "" } });
  assert.equal(fromForm.success, true);
  await rejects(uc.addLead(fromForm.data.input), "lostReason");
  assert.ok(await uc.addLead(COMMANDS.addLead[0].parse({ input: { name: "Form", status: "neu", lostReason: "" } }).input));
  const viaMcp = await mcp({ store, clock, uc }, "change_status", { id, status: "disqualifiziert" });
  assert.equal(viaMcp.isError, true);

  await uc.changeStatus(id, "disqualifiziert", "Zu klein");
  const l = await store.get("leads", id);
  assert.deepEqual([l.status, l.lostReason], ["disqualifiziert", "Zu klein"]);
  await uc.setLostReason(id, "Nicht unsere Zielgruppe");
  assert.equal((await store.get("leads", id)).lostReason, "Nicht unsere Zielgruppe");
  await uc.changeStatus(id, "kontaktiert");
  assert.equal((await store.get("leads", id)).lostReason, null);
  // A quick edit writes everything the rules derive, not only its own field.
  await uc.changeStatus(id, "disqualifiziert", "Zu klein");
  await uc.updateField(id, "status", "kontaktiert");
  assert.equal((await store.get("leads", id)).lostReason, null);
});

test("old statuses and reasons are refused on every write", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone" });
  await rejects(uc.changeStatus(id, "demo"), "status");
  await rejects(uc.updateLead(id, { status: "recherchiert" }), "status");
  assert.equal(COMMANDS.changeStatus[0].safeParse({ id, status: "kein-interesse" }).success, false);
  assert.equal(COMMANDS.updateLead[0].safeParse({ id, input: { status: "antwort" } }).success, false);
  // The MCP input schema itself refuses them: the use case is never reached.
  const unreachable = { changeStatus: () => assert.fail("the schema let a legacy value through") };
  for (const args of [{ id, status: "kein-interesse" }, { id, status: "disqualifiziert", lostReason: "Sonstiges" }])
    assert.equal((await mcp({ store, clock, uc: unreachable }, "change_status", args)).isError, true, JSON.stringify(args));
});

test("a disqualified lead has no follow-up, and setting one is refused", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", followUp: "2026-10-20" });
  await uc.changeStatus(id, "disqualifiziert", "Kein Bedarf");
  assert.equal((await store.get("leads", id)).followUp, null);
  await rejects(uc.setFollowUp(id, "2026-11-01"), "followUp");
  await uc.updateLead(id, { followUp: "2026-11-01" });
  assert.equal((await store.get("leads", id)).followUp, null);
});

test("contactedAt: set by the first contact, never by later ones, and Neu means never contacted", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone" });
  assert.equal((await store.get("leads", id)).contactedAt, null);
  await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Angerufen", date: "2026-10-10" });
  await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Nochmal", date: "2026-10-14" });
  const l = await store.get("leads", id);
  assert.deepEqual([l.status, l.contactedAt], ["kontaktiert", "2026-10-10"]);
  await rejects(uc.changeStatus(id, "neu"), "contactedAt");
  await rejects(uc.updateLead(id, { contactedAt: null }), "contactedAt");
  // A contact logged later but dated earlier moves the first contact back.
  await uc.logActivity(id, { direction: "in", channel: "Telefon", text: "Hat zurückgerufen", date: "2026-10-08" });
  assert.equal((await store.get("leads", id)).contactedAt, "2026-10-08");

  // A first contact can't lie in the future, on any write path.
  const later = await uc.addLead({ name: "Noch nicht" });
  await rejects(uc.updateLead(later, { contactedAt: "2026-10-16" }), "contactedAt");
  const viaMcp = await mcp({ store, clock, uc }, "update_lead", { id: later, fields: { contactedAt: "2099-01-01" } });
  assert.equal(viaMcp.isError, true);
  const rpc = (name, args) => COMMANDS[name][1](uc, COMMANDS[name][0].parse(args));
  await rejects(rpc("updateField", { id: later, key: "contactedAt", value: "2099-01-01" }), "contactedAt");
  // A contact dated after today has not happened yet, whatever the lead's status.
  await rejects(uc.logActivity(later, { direction: "out", channel: "Telefon", text: "Geplant", date: "2026-10-20" }), "date");
  await rejects(uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Geplant", date: "2026-10-20" }), "date");
  assert.deepEqual([(await store.get("leads", later)).status, (await store.get("leads", later)).contactedAt], ["neu", null]);

  // A first contact made outside the CRM: recording it moves a Neu lead to Kontaktiert.
  const outside = await uc.addLead({ name: "Vor Ort besucht" });
  await uc.updateLead(outside, { contactedAt: "2026-09-20" });
  const o = await store.get("leads", outside);
  assert.deepEqual([o.status, o.contactedAt], ["kontaktiert", "2026-09-20"]);
  await rejects(uc.updateLead(outside, { status: "neu" }), "contactedAt");

  // An appointment on the first call, without a logged activity, still counts as contact.
  const direct = await uc.addLead({ name: "Termin gleich" });
  await uc.changeStatus(direct, "qualifiziert");
  assert.equal((await store.get("leads", direct)).contactedAt, "2026-10-15");
});

test("a reply on Neu moves to Kontaktiert; any contact reopens a disqualified lead, but not an opt-out", async () => {
  const { store, uc } = setup();
  const fresh = await uc.addLead({ name: "Schreibt zuerst" });
  await uc.logActivity(fresh, { direction: "in", channel: "E-Mail", text: "Was kostet das?" });
  const f = await store.get("leads", fresh);
  assert.deepEqual([f.status, f.followUp, f.nextStep, f.contactedAt], ["kontaktiert", "2026-10-15", "Antworten", "2026-10-15"]);

  const closed = await uc.addLead({ name: "Ruft zurück" });
  await uc.changeStatus(closed, "disqualifiziert", "Nicht erreicht");
  await uc.logActivity(closed, { direction: "in", channel: "Telefon", text: "Ruft zurück" });
  const c = await store.get("leads", closed);
  assert.deepEqual([c.status, c.lostReason, c.followUp], ["kontaktiert", null, "2026-10-15"]);

  const out = await uc.addLead({ name: "Opt" });
  await uc.optOut(out);
  await uc.logActivity(out, { direction: "in", channel: "E-Mail", text: "Bitte nicht mehr" });
  const o = await store.get("leads", out);
  assert.deepEqual([o.status, o.lostReason, o.followUp], ["disqualifiziert", "Keine Kontaktaufnahme gew\xFCnscht", null]);
});

test("an opt-out allows only Kunde, or Disqualifiziert with the opt-out reason", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Opt" });
  await uc.optOut(id);
  await rejects(uc.changeStatus(id, "qualifiziert"), "status");
  await rejects(uc.setLostReason(id, "Zu klein"), "lostReason");
  await rejects(uc.updateLead(id, { lostReason: "Kein Bedarf" }), "lostReason");
  assert.equal((await store.get("leads", id)).lostReason, "Keine Kontaktaufnahme gew\xFCnscht");
  await uc.changeStatus(id, "kunde");
  assert.deepEqual([(await store.get("leads", id)).status, (await store.get("leads", id)).optOutAt], ["kunde", "2026-10-15"]);
});

test("picking the opt-out reason is an opt-out: no more outgoing contact", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Will nicht" });
  await uc.changeStatus(id, "disqualifiziert", "Keine Kontaktaufnahme gew\xFCnscht");
  assert.equal((await store.get("leads", id)).optOutAt, "2026-10-15");
  await rejects(uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Doch anrufen" }), "optOutAt");
  await uc.clearOptOut(id);
  const l = await store.get("leads", id);
  assert.deepEqual([l.status, l.lostReason, l.optOutAt], ["kontaktiert", null, null]);
});

test("a contact on an opted-out lead dates its first contact too", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Will nicht" });
  await uc.changeStatus(id, "disqualifiziert", "Keine Kontaktaufnahme gew\xFCnscht");
  await uc.logActivity(id, { direction: "in", channel: "Telefon", text: "Hat nochmal angerufen", date: "2026-10-12" });
  assert.deepEqual([(await store.get("leads", id)).contactedAt, (await store.get("leads", id)).optOutAt], ["2026-10-12", "2026-10-15"]);
});

test("the opt-out message is a contact: it dates the first contact, which lifting the opt-out keeps", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Will nicht" });
  await uc.optOut(id);
  assert.equal((await store.get("leads", id)).contactedAt, "2026-10-15");
  const later = createUseCases({ store, clock: { today: () => "2026-10-20", now: () => "2026-10-20T10:00:00.000Z" }, ids: { newId: () => "unused" }, actor: "jo@bookete.com (test)" });
  await later.clearOptOut(id);
  const l = await store.get("leads", id);
  assert.deepEqual([l.status, l.contactedAt], ["kontaktiert", "2026-10-15"]);
});

test("the fifth unanswered contact, not the fourth, offers to close as Nicht erreicht", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Still" });
  const offered = async () => {
    const [l, acts] = [await store.get("leads", id), await store.activitiesOf(id)];
    return [sequenceExhausted(l, acts), nextActionHint(l, acts)];
  };
  for (const date of ["2026-10-01", "2026-10-04", "2026-10-08", "2026-10-11"]) await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Nicht erreicht", date });
  assert.deepEqual(await offered(), [false, "Nachfassen (Kontakt 5 von 5)"]);
  await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Nicht erreicht", date: "2026-10-15" });
  assert.deepEqual(await offered(), [true, "Keine Antwort nach 5 Kontakten \u2013 abschlie\xDFen?"]);
});

test("closing a lead nobody answers gives Nicht erreicht", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Still" });
  await uc.closeWithoutReply(id);
  const l = await store.get("leads", id);
  assert.deepEqual([l.status, l.lostReason], ["disqualifiziert", "Nicht erreicht"]);
});

test("a Kunde keeps its follow-up and is due in Todos", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Aktivierung", status: "kunde", followUp: "2026-10-14" });
  const l = await store.get("leads", id);
  assert.equal(l.followUp, "2026-10-14");
  assert.equal(isDue(l, "2026-10-15"), true);
  await uc.setFollowUp(id, "2026-10-30");
  assert.equal((await store.get("leads", id)).followUp, "2026-10-30");
});

// Hand-written: what each pre-1.4.0 lead becomes. Migration 0003 must give the same rows.
export const UPGRADES = [
  [{ status: "recherchiert", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "neu", lostReason: null, contactedAt: null }],
  [{ status: "recherchiert", createdAt: "2026-09-24T08:00:00Z" }, "2026-09-30", { status: "kontaktiert", lostReason: null, contactedAt: "2026-09-30" }],
  [{ status: "kontaktiert", createdAt: "2026-09-24T08:00:00Z", followUp: "2026-10-20" }, null, { status: "kontaktiert", lostReason: null, contactedAt: "2026-09-24", followUp: "2026-10-20" }],
  [{ status: "antwort", createdAt: "2026-09-23T08:00:00Z" }, "2026-09-23", { status: "kontaktiert", lostReason: null, contactedAt: "2026-09-23" }],
  [{ status: "demo", createdAt: "2026-09-28T08:00:00Z", followUp: "2026-10-01" }, null, { status: "qualifiziert", lostReason: null, contactedAt: "2026-09-28", followUp: "2026-10-01" }],
  [{ status: "onboarding", createdAt: "2026-09-20T08:00:00Z", followUp: "2026-10-30" }, null, { status: "kunde", lostReason: null, contactedAt: "2026-09-20", followUp: "2026-10-30" }],
  [{ status: "kunde", createdAt: "2026-09-20T08:00:00Z" }, null, { status: "kunde", lostReason: null, contactedAt: "2026-09-20" }],
  [{ status: "kein-interesse", lostReason: "Zu wenig Reservierungen", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "disqualifiziert", lostReason: "Zu klein", contactedAt: null }],
  [{ status: "kein-interesse", lostReason: "Telefon reicht ihnen", createdAt: "2026-09-24T08:00:00Z" }, "2026-09-25", { status: "disqualifiziert", lostReason: "Kein Bedarf", contactedAt: "2026-09-25" }],
  [{ status: "kein-interesse", lostReason: "Keine Antwort", createdAt: "2026-09-23T08:00:00Z" }, null, { status: "kontaktiert", lostReason: null, contactedAt: "2026-09-23" }],
  [{ status: "kein-interesse", lostReason: "Hat schon ein Tool", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "neu", lostReason: null, contactedAt: null }],
  [{ status: "kein-interesse", lostReason: "Sonstiges", createdAt: "2026-09-24T08:00:00Z" }, "2026-10-02", { status: "kontaktiert", lostReason: null, contactedAt: "2026-10-02" }],
  [{ status: "kein-interesse", lostReason: "Sp\xE4ter nochmal", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "neu", lostReason: null, contactedAt: null }],
  [{ status: "kein-interesse", lostReason: null, createdAt: "2026-09-24T08:00:00Z" }, null, { status: "neu", lostReason: null, contactedAt: null }],
  [{ status: "kein-interesse", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", optOutAt: "2026-09-24", contactedAt: null }],
  [{ status: "kein-interesse", lostReason: "Hat schon ein Tool", optOutAt: "2026-10-01", createdAt: "2026-09-24T08:00:00Z" }, "2026-09-26", { status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", contactedAt: "2026-09-26" }],
  [{ status: "kunde", lostReason: null, optOutAt: "2026-10-01", followUp: "2026-10-20", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "kunde", lostReason: null, optOutAt: "2026-10-01", contactedAt: "2026-09-24", followUp: "2026-10-20" }],
  [{ status: "demo", optOutAt: "2026-10-01", followUp: "2026-10-20", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", optOutAt: "2026-10-01", contactedAt: "2026-09-24" }],
  [{ status: "kein-interesse", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", createdAt: "2026-09-24T08:00:00Z", updatedAt: "2026-10-03T09:00:00Z" }, null, { status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", optOutAt: "2026-10-03", contactedAt: null }],
  // Rows 1.4.0 wrote parts of before migration 0003: the new status and a stored contactedAt are kept.
  [{ status: "qualifiziert", createdAt: "2026-09-24T08:00:00Z", followUp: "2026-10-22" }, null, { status: "qualifiziert", lostReason: null, contactedAt: "2026-09-24", followUp: "2026-10-22" }],
  [{ status: "kontaktiert", contactedAt: "2026-10-05", createdAt: "2026-09-24T08:00:00Z" }, "2026-09-30", { status: "kontaktiert", lostReason: null, contactedAt: "2026-10-05" }],
  [{ status: "disqualifiziert", lostReason: "Geschlossen / existiert nicht", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "disqualifiziert", lostReason: "Geschlossen / existiert nicht", contactedAt: null }],
  [{ status: "kunde", lostReason: "Sonstiges", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "kunde", lostReason: null, contactedAt: "2026-09-24" }],
  [{ status: "neu", createdAt: "2026-09-24T08:00:00Z" }, null, { status: "neu", lostReason: null, contactedAt: null }],
];

test("upgradeLead turns every pre-1.4.0 lead into a 1.4.0 lead, and leaves a current one alone", () => {
  for (const [old, firstContact, want] of UPGRADES) {
    const got = upgradeLead({ name: "X", schemaVersion: 2, followUp: null, ...old }, firstContact);
    assert.deepEqual({ status: got.status, lostReason: got.lostReason ?? null, contactedAt: got.contactedAt ?? null, followUp: got.followUp ?? null, optOutAt: got.optOutAt ?? null, schemaVersion: got.schemaVersion },
      { followUp: null, optOutAt: old.optOutAt ?? null, ...want, schemaVersion: 3 }, JSON.stringify(old));
  }
  const current = { name: "X", schemaVersion: 3, status: "neu", contactedAt: null };
  assert.equal(upgradeLead(current), current);
  // 1.3 writing after 0003 (out of order, or a rollback) leaves an old status on a current row: it is upgraded all the same.
  const rolledBack = upgradeLead({ name: "X", schemaVersion: 3, status: "kein-interesse", lostReason: "Sonstiges", createdAt: "2026-09-24T08:00:00Z" });
  assert.deepEqual([rolledBack.status, rolledBack.lostReason], ["neu", null]);
});

test("updateField checks the value by its field at the boundary", () => {
  const parse = (key, value) => COMMANDS.updateField[0].safeParse({ id: "L1", key, value }).success;
  assert.deepEqual([parse("status", "kein-interesse"), parse("lostReason", "Sonstiges"), parse("fit", 7), parse("optOutAt", "2026-10-01")], [false, false, false, false]);
  assert.deepEqual([parse("status", "kontaktiert"), parse("lostReason", "Zu klein"), parse("fit", "2"), parse("notes", "Ja"), parse("followUp", null)], [true, true, true, true, true]);
});

test("an activity an old backup has dated after today is no first contact", () => {
  const old = { format: "bookete-crm-backup", data: { leads: [{ id: "B1", name: "Alt", status: "recherchiert", schemaVersion: 2 }], activities: [{ id: "A9", leadId: "B1", direction: "out", channel: "Telefon", date: "2026-11-05", text: "Anrufen" }] } };
  const [leads] = chunkBackup(old, "2026-10-15");
  assert.deepEqual([leads.data.leads[0].status, leads.data.leads[0].contactedAt], ["neu", null]);
});

test("an old backup is upgraded in the browser with its activities; the server refuses an old lead", async () => {
  const { store, uc } = setup();
  const old = { format: "bookete-crm-backup", data: {
    leads: [
      { id: "B1", name: "Alt nein", status: "kein-interesse", lostReason: "Sonstiges", schemaVersion: 2, createdAt: "2026-09-24T08:00:00Z" },
      { id: "B2", name: "Alt angeschrieben", status: "recherchiert", schemaVersion: 2, createdAt: "2026-09-24T08:00:00Z" },
    ],
    // The earliest contact, a reply, is not the first in the file.
    activities: [
      { id: "A1", leadId: "B2", direction: "out", channel: "E-Mail", date: "2026-09-30", text: "Hallo" },
      { id: "A2", leadId: "B2", direction: "in", channel: "Telefon", date: "2026-09-27", text: "Hat angerufen" },
    ],
  } };
  await rejects(uc.importBackup({ ...old, data: { leads: old.data.leads } }), "backup");
  for (const chunk of chunkBackup(old, "2026-10-15")) await uc.importBackup(chunk);
  const b1 = await store.get("leads", "B1"), b2 = await store.get("leads", "B2");
  assert.deepEqual([b1.status, b1.lostReason, b1.schemaVersion], ["neu", null, 3]);
  assert.deepEqual([b2.status, b2.contactedAt], ["kontaktiert", "2026-09-27"]);
});

test("a backup taken before 0003 had run is upgraded again on import, with its activities", async () => {
  // 1.4.0 read the old row without its activities, so its backup holds it as Neu and still marked as not yet upgraded.
  const backup = { format: "bookete-crm-backup", data: {
    leads: [{ id: "L1", name: "Alt", status: "neu", contactedAt: null, schemaVersion: 2, createdAt: "2026-09-24T08:00:00Z" }],
    activities: [{ id: "A1", leadId: "L1", direction: "in", channel: "Telefon", date: "2026-09-27", text: "Hat angerufen" }],
  } };
  const { store, uc } = setup();
  for (const chunk of chunkBackup(backup, "2026-10-15")) await uc.importBackup(chunk);
  const l = await store.get("leads", "L1");
  assert.deepEqual([l.status, l.contactedAt, l.schemaVersion], ["kontaktiert", "2026-09-27", 3]);
});
