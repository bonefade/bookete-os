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
  await rejects(uc.updateLead(id, { status: "demo" }), "status");
  await rejects(uc.updateField(id, "status", "antwort"), "status");
  await rejects(uc.sendEmail(id, { subject: "Hi", text: "x" }), "optOutAt");
  await rejects(uc.draftEmail(id, { subject: "Hi", text: "x" }), "optOutAt");
  assert.equal(mailer.sent.length, 0);

  const lead = await store.get("leads", id);
  assert.equal(lead.status, "kein-interesse");
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
  assert.equal((await store.get("leads", id)).status, "recherchiert");
});

test("without Gmail, sending fails before anything happens", async () => {
  const { uc } = setup();
  const id = await uc.addLead({ name: "Kein Gmail", email: "x@example.at" });
  await rejects(uc.sendEmail(id, { subject: "S", text: "T" }), "gmail");
});

test("deleting a lead removes its history in the same transaction, and sync reports both", async () => {
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

test("importing a Claude-artifact backup upserts every record", async () => {
  const { store, uc } = setup();
  const backup = {
    format: "bookete-crm-backup",
    schemaVersion: 2,
    data: {
      leads: [{ id: "L1", name: "Alt", status: "kontaktiert", fit: 3 }],
      activities: [{ id: "A1", leadId: "L1", date: "2026-10-01", channel: "Instagram", direction: "out", text: "Hi" }],
      templates: [],
      settings: [{ id: "icp", fit: ["Gasthaus"], noFit: [] }],
    },
  };
  assert.equal(await uc.importBackup(backup), 3);
  assert.equal(await uc.importBackup(backup), 3);
  assert.equal((await store.list("leads")).length, 1);
  assert.equal((await store.get("leads", "L1")).followUp, null);
  assert.deepEqual((await store.get("settings", "icp")).fit, ["Gasthaus"]);
  await rejects(uc.importBackup({ format: "other" }), "backup");
});

test("every write records who made it", async () => {
  const db = createD1();
  const store = createStore(db);
  const uc = createUseCases({ store, clock, ids: { newId: () => "x1" }, actor: "partner@bookete.com (mcp)" });
  await uc.addLead({ name: "Wer" });
  assert.equal((await db.prepare("SELECT updated_by FROM docs").first()).updated_by, "partner@bookete.com (mcp)");
});
