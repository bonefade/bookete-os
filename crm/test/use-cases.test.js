import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { ValidationError } from "../src/domain/errors.js";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };

function setup({ mailer = null } = {}) {
  const store = createStore(createD1());
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)", mailer });
  return { store, uc };
}

function fakeMailer() {
  const sent = [];
  return { sent, send: async (msg) => (sent.push(msg), { id: "m1", threadId: "t1" }), draft: async (msg) => (sent.push({ draft: msg }), { draftId: "d1" }) };
}

const rejects = (promise, field) => assert.rejects(promise, (e) => e instanceof ValidationError && e.field === field);

test("first outgoing message moves the lead to kontaktiert with a follow-up 3 days later", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Gasthaus Krone" });
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Hallo" });
  const lead = await store.get("leads", id);
  assert.equal(lead.status, "kontaktiert");
  assert.equal(lead.followUp, "2026-10-18");
});

test("an opt-out blocks outgoing contact, reopening and direct edits on every write path", async () => {
  const mailer = fakeMailer();
  const { store, uc } = setup({ mailer });
  const id = await uc.addLead({ name: "Café Opt", email: "cafe@example.at" });
  await uc.optOut(id, "per Mail");

  await rejects(uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Nochmal" }), "optOutAt");
  await rejects(uc.changeStatus(id, "kontaktiert"), "status");
  await rejects(uc.updateLead(id, { status: "qualifiziert" }), "status");
  await rejects(uc.updateField(id, "status", "neu"), "status");
  await rejects(uc.sendEmail(id, { subject: "Hi", text: "x" }), "optOutAt");
  await rejects(uc.draftEmail(id, { subject: "Hi", text: "x" }), "optOutAt");
  assert.equal(mailer.sent.length, 0);

  const lead = await store.get("leads", id);
  assert.equal(lead.status, "disqualifiziert");
  assert.equal(lead.optOutAt, "2026-10-15");
  // An incoming message is still allowed: the business may write back.
  await uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Doch Interesse" });
});

test("a cleared follow-up reads back as null, not missing", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Bar Null", followUp: "2026-10-20" });
  await uc.setFollowUp(id, "");
  assert.equal((await store.get("leads", id)).followUp, null);
});

test("sendEmail sends first, then logs the activity with the same text", async () => {
  const mailer = fakeMailer();
  const { store, uc } = setup({ mailer });
  const id = await uc.addLead({ name: "Heuriger Mail", email: "heuriger@example.at" });
  const res = await uc.sendEmail(id, { subject: "Tische", text: "Grüß Gott" });
  assert.deepEqual(mailer.sent, [{ to: "heuriger@example.at", subject: "Tische", text: "Grüß Gott" }]);
  assert.equal(res.gmail.threadId, "t1");
  const acts = await store.activitiesOf(id);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].channel, "E-Mail");
  assert.equal(acts[0].text, "Grüß Gott");
});

test("drafts are created but never logged as sent", async () => {
  const mailer = fakeMailer();
  const { store, uc } = setup({ mailer });
  const id = await uc.addLead({ name: "Draft Wirt", email: "wirt@example.at" });
  assert.deepEqual(await uc.draftEmail(id, { subject: "S", text: "T" }), { draftId: "d1" });
  assert.equal((await store.activitiesOf(id)).length, 0);
  assert.equal((await store.get("leads", id)).status, "neu");
});

test("without Gmail, sending fails before anything happens", async () => {
  const { uc } = setup();
  const id = await uc.addLead({ name: "Kein Gmail", email: "x@example.at" });
  await rejects(uc.sendEmail(id, { subject: "S", text: "T" }), "gmail");
});

test("deleting a lead moves it and its activities to the trash in one transaction, and sync reports both", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Weg" });
  await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Angerufen" });
  const { seq } = await store.changes(0);
  await uc.deleteLead(id);
  assert.equal(await store.get("leads", id), null);
  assert.deepEqual(await store.activitiesOf(id), []);
  const after = await store.changes(seq);
  assert.deepEqual(after.changes.map((c) => [c.collection, c.deleted]), [["activities", true], ["leads", true]]);
  assert.equal((await store.changes(0)).changes.length, 0);
});

test("importing a backup adds new records, normalized, and is safe to repeat", async () => {
  const { store, uc } = setup();
  const backup = {
    format: "bookete-crm-backup",
    schemaVersion: 2,
    data: {
      leads: [{ id: "L1", name: "Alt", status: "kontaktiert", schemaVersion: 3, fit: '"><img src=x onerror=alert(1)>' }],
      activities: [{ id: "A1", leadId: "L1", date: "2026-10-01", channel: "Instagram", direction: "out", text: "Hi" }],
      templates: [],
      settings: [{ id: "icp", fit: ["Gasthaus"], noFit: [] }],
    },
  };
  assert.equal(await uc.importBackup(backup), 3);
  assert.equal(await uc.importBackup(backup), 0);
  const lead = await store.get("leads", "L1");
  assert.equal(lead.fit, 2);
  assert.equal(lead.followUp, null);
  assert.deepEqual((await store.get("settings", "icp")).fit, ["Gasthaus"]);
  await rejects(uc.importBackup({ format: "other" }), "backup");
  // A lead from before 1.4.0 is refused even where its status still exists: only the browser can upgrade it, with its activities.
  await rejects(uc.importBackup({ format: "bookete-crm-backup", data: { leads: [{ id: "L2", name: "Alt", status: "kontaktiert", schemaVersion: 2 }] } }), "backup");
});

test("an import can neither clear an opt-out nor bring back a deleted lead", async () => {
  const { store, uc } = setup();
  const kept = await uc.addLead({ name: "Opt" });
  await uc.optOut(kept);
  const gone = await uc.addLead({ name: "Weg" });
  await uc.deleteLead(gone);
  const backup = { format: "bookete-crm-backup", data: { leads: [{ id: kept, name: "Opt", status: "kontaktiert" }, { id: gone, name: "Weg" }] } };
  assert.equal(await uc.importBackup(backup), 0);
  assert.equal((await store.get("leads", kept)).optOutAt, "2026-10-15");
  assert.equal(await store.get("leads", gone), null);
});

test("a failing write rolls back the whole commit", async () => {
  const { store } = setup();
  await assert.rejects(store.commit([
    { type: "put", collection: "leads", id: "ok", data: { name: "Ok" } },
    { type: "put", collection: "not-a-collection", id: "bad", data: {} },
  ], "test"));
  assert.equal(await store.get("leads", "ok"), null);
  assert.equal((await store.changes(0)).seq, 0);
});

test("when Gmail fails, nothing is logged", async () => {
  const mailer = { send: async () => { throw new ValidationError("gmail", "Gmail-Fehler 500"); } };
  const { store, uc } = setup({ mailer });
  const id = await uc.addLead({ name: "Fail", email: "f@example.at" });
  await rejects(uc.sendEmail(id, { subject: "S", text: "T" }), "gmail");
  assert.equal((await store.activitiesOf(id)).length, 0);
  assert.equal((await store.get("leads", id)).status, "neu");
});

test("a status with an invalid reason changes nothing", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Halb" });
  await rejects(uc.changeStatus(id, "kunde", "Zu klein"), "lostReason");
  assert.equal((await store.get("leads", id)).status, "neu");
  await uc.changeStatus(id, "disqualifiziert", "Zu klein");
  assert.equal((await store.get("leads", id)).lostReason, "Zu klein");
});

test("every write records who made it", async () => {
  const db = createD1();
  const store = createStore(db);
  const uc = createUseCases({ store, clock, ids: { newId: () => "x1" }, actor: "partner@bookete.com (mcp)" });
  await uc.addLead({ name: "Wer" });
  assert.equal((await db.prepare("SELECT updated_by FROM docs").first()).updated_by, "partner@bookete.com (mcp)");
});

test("every version of a lead is kept with who wrote it, old and new", async () => {
  const db = createD1();
  const store = createStore(db);
  const as = (actor) => createUseCases({ store, clock, ids: { newId: () => "L1" }, actor });
  const id = await as("jo@bookete.com (web)").addLead({ name: "Krone", phone: "0664 1" });
  await as("michael@bookete.com (mcp)").updateLead(id, { phone: "0664 2" });
  const [changed, created] = await store.history(id);
  assert.equal(created.before, null);
  assert.equal(created.actor, "jo@bookete.com (web)");
  assert.deepEqual([changed.actor, changed.before.phone, changed.after.phone], ["michael@bookete.com (mcp)", "0664 1", "0664 2"]);
  assert.equal(changed.after.name, "Krone");
});

test("a save that changes nothing writes nothing", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", instagram: "@krone" });
  await uc.updateLead(id, { name: "Krone", instagram: "krone" });
  assert.equal((await store.history(id)).length, 1);
});

test("a deleted lead waits in the trash and comes back with its activities", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Weg" });
  await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Angerufen" });
  await uc.deleteLead(id);
  await uc.deleteLead(id);
  assert.deepEqual((await store.trash()).map((t) => [t.lead.name, t.actor]), [["Weg", "jo@bookete.com (test)"]]);
  const { seq } = await store.changes(0);
  await uc.restoreLead(id);
  await uc.restoreLead(id);
  assert.equal((await store.get("leads", id)).status, "kontaktiert");
  assert.deepEqual((await store.activitiesOf(id)).map((a) => a.text), ["Angerufen"]);
  assert.deepEqual((await store.trash()), []);
  assert.deepEqual((await store.changes(seq)).changes.map((c) => [c.collection, !!c.record]), [["leads", true], ["activities", true]]);
});

test("erasing a lead from the trash leaves no data and no history, and its id stays used", async () => {
  const db = createD1();
  const store = createStore(db);
  const uc = createUseCases({ store, clock, ids: { newId: () => "L" + Math.random() }, actor: "jo@bookete.com (test)" });
  const id = await uc.addLead({ name: "Gasthaus Geheim", email: "geheim@example.at" });
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Hallo Geheim" });
  await rejects(uc.purgeLead(id), "id");
  await uc.deleteLead(id);
  // A backup can still hold an activity of this lead the CRM never had; the erase covers it too.
  assert.equal(await uc.importBackup({ format: "bookete-crm-backup", data: { activities: [{ id: "A-old", leadId: id, direction: "in", channel: "E-Mail", date: "2026-10-01", text: "Geheim antwortet" }] } }), 1);
  await uc.purgeLead(id);
  await uc.purgeLead(id);
  const leftover = await db.prepare("SELECT (SELECT group_concat(data) FROM docs) AS docs, (SELECT group_concat(coalesce(before, '') || after) FROM history) AS history").first();
  assert.doesNotMatch(String(leftover.docs) + String(leftover.history), /Geheim/);
  assert.deepEqual(await store.trash(), []);
  await rejects(uc.restoreLead(id), "id");
  assert.deepEqual((await store.changes(0)).changes, []);
  assert.equal(await uc.importBackup({ format: "bookete-crm-backup", data: { leads: [{ id, name: "Gasthaus Geheim" }] } }), 0);
});

test("deleting a template twice is fine, and a deleted template is not saved back", async () => {
  const { store, uc } = setup();
  const id = await uc.saveTemplate(null, { name: "Erst", purpose: "erstkontakt", body: "Hallo" });
  await uc.deleteTemplate(id);
  await uc.deleteTemplate(id);
  await rejects(uc.saveTemplate(id, { name: "Erst", purpose: "erstkontakt", body: "Hallo 2" }), "id");
  assert.equal(await store.get("templates", id), null);
});

test("a lead's history says which entries deleted and restored it, also at the end of a page", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Gasthaus Krone" });
  await uc.deleteLead(id);
  await uc.restoreLead(id);
  for (let i = 0; i < 99; i++) await uc.setNextStep(id, `Schritt ${i}`);
  const rows = await store.history(id);
  assert.equal(rows.length, 100);
  assert.deepEqual([rows[99].deleted, rows[99].wasDeleted], [false, true]);
});

test("a lead with many contacts can be deleted, restored and erased within D1's limits", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Gasthaus Krone" });
  for (let i = 0; i < 30; i++) await uc.logActivity(id, { direction: "in", channel: "E-Mail", text: `Antwort ${i}` });
  await uc.deleteLead(id);
  assert.equal((await store.activitiesOf(id, { deleted: true })).length, 30);
  await uc.restoreLead(id);
  assert.equal((await store.activitiesOf(id)).length, 30);
  await uc.deleteLead(id);
  await uc.purgeLead(id);
  assert.equal(await store.getDeleted("leads", id), null);
});
