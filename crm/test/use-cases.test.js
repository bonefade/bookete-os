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

test("an opt-out closes its address to mail: no mail, sent, drafted or logged as sent, to an address any lead with an opt-out holds, also in the Papierkorb", async () => {
  const mailer = fakeMailer();
  const { store, uc } = setup({ mailer });
  const old = await uc.addLead({ name: "Krone", email: "Info@Krone.at" });
  await uc.optOut(old);
  const again = await uc.addLead({ name: "Gasthaus Krone", email: " info@krone.AT " });
  const refused = (message) => (e) => e instanceof ValidationError && e.field === "email" && e.message === message;
  const live = "Keine E-Mail an diese Adresse: \u201EKrone\u201C hat dieselbe Adresse und ein Opt-out seit 15.10.2026";
  const logged = { direction: "out", channel: "E-Mail", text: "Hallo" };
  await assert.rejects(uc.sendEmail(again, { subject: "Hi", text: "x" }), refused(live));
  await assert.rejects(uc.draftEmail(again, { subject: "Hi", text: "x" }), refused(live));
  await assert.rejects(uc.logActivity(again, logged), refused(live));
  // In the Papierkorb its opt-out still holds, and the message says where it is.
  await uc.deleteLead(old);
  const trashed = "Keine E-Mail an diese Adresse: \u201EKrone\u201C (im Papierkorb) hat dieselbe Adresse und ein Opt-out seit 15.10.2026";
  await assert.rejects(uc.sendEmail(again, { subject: "Hi", text: "x" }), refused(trashed));
  await assert.rejects(uc.draftEmail(again, { subject: "Hi", text: "x" }), refused(trashed));
  await assert.rejects(uc.logActivity(again, logged), refused(trashed));
  assert.equal(mailer.sent.length, 0);
  assert.equal((await store.activitiesOf(again)).length, 0);
  // Another channel logged by hand, a call and an incoming E-Mail stay allowed.
  await uc.logActivity(again, { direction: "out", channel: "Telefon", text: "Angerufen" });
  await uc.logCall(again, { outcome: "nicht-erreicht" });
  await uc.logActivity(again, { direction: "in", channel: "E-Mail", text: "Antwort" });
  assert.equal((await store.activitiesOf(again)).length, 3);
  // Once the opt-out is lifted, the address takes mail again; another address always did.
  await uc.restoreLead(old);
  await uc.clearOptOut(old);
  await uc.sendEmail(again, { subject: "Hi", text: "x" });
  const other = await uc.addLead({ name: "Post", email: "post@example.at" });
  await uc.draftEmail(other, { subject: "Hi", text: "x" });
  assert.deepEqual(mailer.sent.map((m) => (m.draft || m).to), ["info@krone.AT", "post@example.at"]);
});

test("a Kunde's service mail goes to an address another lead's opt-out holds; the Kunde's own opt-out still stops it", async () => {
  const mailer = fakeMailer();
  const { uc } = setup({ mailer });
  await uc.optOut(await uc.addLead({ name: "Krone", email: "info@krone.at" }));
  const kunde = await uc.addLead({ name: "Gasthaus Krone", status: "kunde", email: "info@krone.at" });
  await uc.sendEmail(kunde, { subject: "Rechnung", text: "x" });
  await uc.draftEmail(kunde, { subject: "Rechnung", text: "x" });
  await uc.logActivity(kunde, { direction: "out", channel: "E-Mail", text: "Rechnung" });
  assert.equal(mailer.sent.length, 2);
  await uc.optOut(kunde);
  await rejects(uc.sendEmail(kunde, { subject: "Rechnung", text: "x" }), "optOutAt");
  await rejects(uc.draftEmail(kunde, { subject: "Rechnung", text: "x" }), "optOutAt");
  await rejects(uc.logActivity(kunde, { direction: "out", channel: "E-Mail", text: "Rechnung" }), "optOutAt");
  assert.equal(mailer.sent.length, 2);
});

test("a mail sent by Gmail is logged even if its address closed while it went out", async () => {
  const sent = [];
  let uc;
  // Another lead with the same address opts out while the mail is on its way.
  const mailer = { send: async (msg) => (sent.push(msg), await uc.optOut(other), { id: "m1", threadId: "t1" }) };
  ({ uc } = setup({ mailer }));
  const other = await uc.addLead({ name: "Krone", email: "info@krone.at" });
  const id = await uc.addLead({ name: "Gasthaus Krone", email: "info@krone.at" });
  const { activity } = await uc.sendEmail(id, { subject: "Hi", text: "Hallo" });
  assert.deepEqual([sent.length, activity.channel, activity.direction], [1, "E-Mail", "out"]);
});

test("with a live and a trashed lead holding the closed address, the refusal names the live one", async () => {
  const { uc } = setup({ mailer: fakeMailer() });
  // The trashed one is added first and written last, so neither insertion order nor the newest write names the live one; only "live first" does.
  const trashed = await uc.addLead({ name: "Alte Krone", email: "info@krone.at" });
  const live = await uc.addLead({ name: "Krone", email: "info@krone.at" });
  await uc.optOut(live);
  await uc.optOut(trashed);
  await uc.deleteLead(trashed);
  const again = await uc.addLead({ name: "Gasthaus Krone", email: "info@krone.at" });
  await assert.rejects(uc.draftEmail(again, { subject: "Hi", text: "x" }), { message: "Keine E-Mail an diese Adresse: „Krone“ hat dieselbe Adresse und ein Opt-out seit 15.10.2026" });
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
  assert.deepEqual(mailer.sent, [{ leadId: id, to: "heuriger@example.at", subject: "Tische", text: "Grüß Gott", serviceMail: false }]);
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
  assert.deepEqual(mailer.sent, [{ draft: { leadId: id, to: "wirt@example.at", subject: "S", text: "T", serviceMail: false } }]);
  assert.equal((await store.activitiesOf(id)).length, 0);
  assert.equal((await store.get("leads", id)).status, "neu");
});

test("mail to a Kunde goes without the unsubscribe link, sent or drafted", async () => {
  const mailer = fakeMailer();
  const { uc } = setup({ mailer });
  const id = await uc.addLead({ name: "Stammkunde", email: "kunde@example.at" });
  await uc.changeStatus(id, "kunde");
  await uc.sendEmail(id, { subject: "Rechnung", text: "Anbei" });
  await uc.draftEmail(id, { subject: "Termin", text: "Passt Montag?" });
  assert.deepEqual(mailer.sent.map((m) => (m.draft || m).serviceMail), [true, true]);
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

test("an import adds an activity of a lead in the Papierkorb to the trash with it, and none to an erased lead", async () => {
  const { store, uc } = setup();
  const trashed = await uc.addLead({ name: "Weg" });
  const erased = await uc.addLead({ name: "Gasthaus Geheim" });
  await uc.deleteLead(trashed);
  await uc.deleteLead(erased);
  await uc.purgeLead(erased);
  const activity = (id, leadId, text) => ({ id, leadId, direction: "in", channel: "E-Mail", date: "2026-10-01", text });
  assert.equal(await uc.importBackup({ format: "bookete-crm-backup", data: { activities: [activity("A1", trashed, "Gerne"), activity("A2", erased, "Geheim antwortet")] } }), 1);
  assert.deepEqual(await store.activitiesOf(trashed), []);
  assert.equal((await store.ids("activities")).has("A2"), false);
  await uc.restoreLead(trashed);
  assert.deepEqual((await store.activitiesOf(trashed)).map((a) => a.text), ["Gerne"]);
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
  assert.deepEqual(await store.trash(), []);
  assert.deepEqual((await store.changes(seq)).changes.map((c) => [c.collection, !!c.record]), [["leads", true], ["activities", true]]);
});

test("deleting or restoring a lead moves only its own activities", async () => {
  const { store, uc } = setup();
  const krone = await uc.addLead({ name: "Krone" });
  const linde = await uc.addLead({ name: "Linde" });
  await uc.logActivity(krone, { direction: "in", channel: "E-Mail", text: "Krone antwortet" });
  await uc.logActivity(linde, { direction: "in", channel: "E-Mail", text: "Linde antwortet" });
  const texts = async (id, deleted) => (await store.activitiesOf(id, { deleted })).map((a) => a.text);
  await uc.deleteLead(krone);
  assert.deepEqual(await texts(linde, false), ["Linde antwortet"]);
  // Both in the Papierkorb: bringing one back leaves the other's activities in the trash with it.
  await uc.deleteLead(linde);
  await uc.restoreLead(krone);
  assert.deepEqual(await texts(krone, false), ["Krone antwortet"]);
  assert.deepEqual(await texts(linde, false), []);
  assert.deepEqual(await texts(linde, true), ["Linde antwortet"]);
});

test("a lead's activities each get their own seq when it is deleted or restored, in their old order", async () => {
  const db = createD1();
  const store = createStore(db);
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)" });
  const id = await uc.addLead({ name: "Krone" });
  for (const text of ["Erste", "Zweite", "Dritte"]) await uc.logActivity(id, { direction: "in", channel: "E-Mail", text });
  for (const move of [() => uc.deleteLead(id), () => uc.restoreLead(id)]) {
    const { seq } = await store.changes(0);
    await move();
    const rows = (await db.prepare("SELECT seq, collection, json_extract(data, '$.text') AS text FROM docs WHERE seq > ? ORDER BY seq").bind(seq).all()).results;
    assert.equal(new Set(rows.map((row) => row.seq)).size, 4);
    assert.deepEqual(rows.filter((row) => row.collection === "activities").map((row) => row.text), ["Erste", "Zweite", "Dritte"]);
  }
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
  // Before 1.13.1 an import left such an activity live beside its deleted lead; the erase covers that one too.
  await store.commit([{ type: "put", collection: "activities", id: "A-live", data: { leadId: id, direction: "in", channel: "E-Mail", date: "2026-10-02", text: "Geheim live" } }], "test");
  await uc.purgeLead(id);
  await uc.purgeLead(id);
  const leftover = await db.prepare("SELECT (SELECT group_concat(data) FROM docs) AS docs, (SELECT group_concat(coalesce(before, '') || after) FROM history) AS history").first();
  assert.doesNotMatch(String(leftover.docs) + String(leftover.history), /Geheim/);
  assert.deepEqual(await store.trash(), []);
  await rejects(uc.restoreLead(id), "id");
  assert.deepEqual((await store.changes(0)).changes, []);
  assert.equal(await uc.importBackup({ format: "bookete-crm-backup", data: { leads: [{ id, name: "Gasthaus Geheim" }] } }), 0);
});

test("erasing one lead from the trash leaves another's activities and their history", async () => {
  const db = createD1();
  const store = createStore(db);
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)" });
  const geheim = await uc.addLead({ name: "Gasthaus Geheim" });
  const linde = await uc.addLead({ name: "Linde" });
  await uc.logActivity(geheim, { direction: "in", channel: "E-Mail", text: "Geheim antwortet" });
  await uc.logActivity(linde, { direction: "in", channel: "E-Mail", text: "Linde antwortet" });
  await uc.deleteLead(geheim);
  await uc.deleteLead(linde);
  const [act] = await store.activitiesOf(linde, { deleted: true });
  const versions = "SELECT COUNT(*) AS n FROM history WHERE collection = 'activities' AND id = ?";
  await uc.purgeLead(geheim);
  // Two versions: logged, then moved to the trash with its lead.
  assert.equal((await db.prepare(versions).bind(act.id).first()).n, 2);
  await uc.restoreLead(linde);
  assert.deepEqual((await store.activitiesOf(linde)).map((a) => a.text), ["Linde antwortet"]);
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
  const db = createD1();
  const store = createStore(db);
  let n = 0;
  // Each call is one request, on a handle that counts D1's queries as one Worker invocation.
  const request = () => createUseCases({ store: createStore(db.invocation()), clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)" });
  const id = await request().addLead({ name: "Gasthaus Krone" });
  for (let i = 0; i < 60; i++) await request().logActivity(id, { direction: "in", channel: "E-Mail", text: `Antwort ${i}` });
  await request().deleteLead(id);
  assert.equal((await store.activitiesOf(id, { deleted: true })).length, 60);
  await request().restoreLead(id);
  assert.equal((await store.activitiesOf(id)).length, 60);
  await request().deleteLead(id);
  await request().purgeLead(id);
  assert.equal(await store.getDeleted("leads", id), null);
});
