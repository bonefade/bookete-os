import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { ValidationError } from "../src/domain/errors.js";
import { customerOf } from "../src/domain/customer.js";
import { BACKUP_FORMAT } from "../src/domain/backup.js";
import { describeChange } from "../src/web/format.js";

let today = "2026-10-15";
const clock = { today: () => today, now: () => today + "T10:00:00.000Z" };
function setup() {
  today = "2026-10-15";
  const store = createStore(createD1());
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)", email: "jo@bookete.com", team: ["jo@bookete.com", "anna@bookete.com"] });
  return { store, uc };
}
const rejects = (promise, field) => assert.rejects(promise, (e) => e instanceof ValidationError && e.field === field);
const next = (l) => [l.followUp, l.nextStep];

test("a lead that becomes Kunde starts its onboarding, owned by whoever won it, with the first step as its next step", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "qualifiziert", followUp: "2026-10-20", nextStep: "Termin" });
  await uc.changeStatus(id, "kunde");
  const l = await store.get("leads", id);
  assert.deepEqual(l.customer, { phase: "onboarding", since: "2026-10-15", owner: "jo@bookete.com", steps: [], liveAt: "", cancelReason: "" });
  assert.deepEqual(next(l), ["2026-10-15", "Vertrag unterschrieben"]);
  // Once: back to Qualifiziert and Kunde again keeps the care as it was.
  await uc.changeCustomer(id, { step: "vertrag" });
  await uc.changeStatus(id, "qualifiziert");
  await uc.changeStatus(id, "kunde");
  assert.deepEqual((await store.get("leads", id)).customer.steps.map((s) => s.id), ["vertrag"]);
  // A next step given with the change stays.
  const given = await uc.addLead({ name: "Post", status: "kunde", followUp: "2026-10-30" });
  assert.deepEqual(next(await store.get("leads", given)), ["2026-10-30", ""]);
});

test("each step done or skipped moves the next step to the next open one on its day; Live ends the onboarding", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde" });
  today = "2026-10-16";
  await uc.changeCustomer(id, { step: "vertrag" });
  let l = await store.get("leads", id);
  assert.deepEqual(l.customer.steps, [{ id: "vertrag", at: "2026-10-16", by: "jo@bookete.com (test)" }]);
  // Due one day after the start, the 15th.
  assert.deepEqual(next(l), ["2026-10-16", "Abo abgeschlossen"]);
  await uc.changeCustomer(id, { step: "abo", skip: "Abo kommt mit dem Vertrag" });
  await uc.changeCustomer(id, { step: "konto" });
  l = await store.get("leads", id);
  assert.equal(l.customer.steps.find((s) => s.id === "abo").skipped, "Abo kommt mit dem Vertrag");
  assert.deepEqual(next(l), ["2026-10-19", "Widget auf der Website"]);
  // A step done by mistake opens again.
  await uc.changeCustomer(id, { step: "konto", done: false });
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-16", "bookete-Konto angelegt"]);
  // Live may come before the other steps: the customer is live from that day, with no next step of its own.
  today = "2026-10-25";
  await uc.changeCustomer(id, { step: "live" });
  l = await store.get("leads", id);
  assert.deepEqual([l.customer.phase, l.customer.liveAt, ...next(l)], ["live", "2026-10-25", null, ""]);
  await uc.changeCustomer(id, { step: "live", done: false });
  l = await store.get("leads", id);
  assert.deepEqual([l.customer.phase, l.customer.liveAt, ...next(l)], ["onboarding", "", "2026-10-16", "bookete-Konto angelegt"]);
});

test("the owner changes alone, and only to one of the team; Gekündigt needs a reason and stops the steps until the customer is taken up again", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde" });
  await uc.setNextStep(id, "Anruf wegen Widget");
  await uc.changeCustomer(id, { owner: "anna@bookete.com" });
  let l = await store.get("leads", id);
  assert.deepEqual([l.customer.owner, ...next(l)], ["anna@bookete.com", "2026-10-15", "Anruf wegen Widget"]);
  await rejects(uc.changeCustomer(id, { owner: "niemand" }), "owner");
  await rejects(uc.changeCustomer(id, { owner: "fremd@example.at" }), "owner");
  await rejects(uc.changeCustomer(id, { phase: "gekuendigt" }), "cancelReason");
  await rejects(uc.changeCustomer(id, { phase: "live", reason: "Preis" }), "cancelReason");
  await uc.changeCustomer(id, { phase: "gekuendigt", reason: "Preis" });
  l = await store.get("leads", id);
  assert.deepEqual([l.status, l.customer.phase, l.customer.cancelReason, ...next(l)], ["kunde", "gekuendigt", "Preis", null, ""]);
  await rejects(uc.changeCustomer(id, { step: "vertrag" }), "phase");
  await uc.changeCustomer(id, { phase: "onboarding" });
  l = await store.get("leads", id);
  assert.deepEqual([l.customer.phase, l.customer.cancelReason, ...next(l)], ["onboarding", "", "2026-10-15", "Vertrag unterschrieben"]);
  // Only a Kunde has care.
  await rejects(uc.changeCustomer(await uc.addLead({ name: "Post" }), { step: "vertrag" }), "status");
});

test("a Kunde won before customers were stored is Live where a service is live, else onboarding; its steps count from its first change", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Seeblick", status: "kunde" });
  const won = await store.get("leads", id);
  // As a Kunde from before: no care stored, a service live in the Kundenakte.
  const old = { ...won, customer: undefined, wonAt: "2026-06-01", account: { services: [{ kind: "bookete", state: "live", goLive: "2026-06-20" }] } };
  assert.deepEqual(customerOf(old), { phase: "live", since: "", owner: "", steps: [], liveAt: "2026-06-20", cancelReason: "" });
  assert.deepEqual(customerOf({ ...old, account: undefined }).phase, "onboarding");
  assert.equal(customerOf({ ...old, status: "qualifiziert" }), null);
  // Stored by the first change, here a step ticked to record it; the steps count from that day, so the next one is
  // not months overdue.
  const { customer: _c, ...without } = won;
  await store.commit([{ type: "put", collection: "leads", id, data: { ...without, wonAt: "2026-06-01", followUp: "2026-11-01", nextStep: "Angebot Website" } }], "test");
  today = "2026-10-20";
  await uc.changeCustomer(id, { step: "vertrag" });
  const l = await store.get("leads", id);
  assert.deepEqual([l.customer.since, l.customer.phase, ...next(l)], ["2026-10-20", "onboarding", "2026-10-21", "Abo abgeschlossen"]);
  // Not stored yet, its steps have no day, so a contact leaves its plan alone.
  const other = await uc.addLead({ name: "Krone", status: "kunde", email: "k@krone.at" });
  const { customer: _o, ...plain } = await store.get("leads", other);
  await store.commit([{ type: "put", collection: "leads", id: other, data: { ...plain, followUp: "2026-11-01", nextStep: "Angebot Website" } }], "test");
  await uc.logActivity(other, { direction: "out", channel: "E-Mail", text: "Hallo" });
  assert.deepEqual(next(await store.get("leads", other)), ["2026-11-01", "Angebot Website"]);
});

test("after an opt-out a step moves only the text of a customer's next step, never a follow-up date", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde" });
  await uc.optOut(id);
  await uc.changeCustomer(id, { step: "vertrag" });
  assert.deepEqual(next(await store.get("leads", id)), [null, "Abo abgeschlossen"]);
});

test("the RPC takes one change at a time, by its own schema; a backup keeps the care", async () => {
  const { store, uc } = setup();
  const ok = (input) => COMMANDS.changeCustomer[0].safeParse({ id: "a", ...input }).success;
  assert.equal(ok({ step: "widget" }), true);
  assert.equal(ok({ step: "widget", done: false }), true);
  assert.equal(ok({ owner: "" }), true);
  assert.equal(ok({ phase: "gekuendigt", reason: "Preis" }), true);
  assert.equal(ok({ step: "kaffee" }), false);
  assert.equal(ok({ owner: "niemand" }), false);
  assert.equal(ok({ phase: "pausiert" }), false);
  assert.equal(ok({ step: "widget", owner: "jo@bookete.com" }), false);
  const customer = { phase: "live", since: "2026-09-01", owner: "anna@bookete.com", steps: [{ id: "vertrag", at: "2026-09-01", by: "anna" }], liveAt: "2026-09-14", cancelReason: "" };
  const lead = { id: "L9", name: "Krone", status: "kunde", wonAt: "2026-09-01", schemaVersion: 3, customer };
  assert.equal(await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [lead] } }), 1);
  assert.deepEqual((await store.get("leads", "L9")).customer, customer);
});

test("the phase it has already changes nothing; a step ticked or opened after the onboarding leaves the next step as planned", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Seeblick", status: "kunde" });
  today = "2026-10-20";
  await uc.changeCustomer(id, { phase: "live" });
  await uc.setNextStep(id, "Angebot Website");
  await uc.setFollowUp(id, "2026-10-30");
  assert.equal(await uc.changeCustomer(id, { phase: "live" }), false);
  await uc.changeCustomer(id, { step: "widget" });
  await uc.changeCustomer(id, { step: "widget", done: false });
  // Ticking Live on a customer live already keeps the day it went live.
  await uc.changeCustomer(id, { step: "live" });
  const l = await store.get("leads", id);
  assert.deepEqual([l.customer.phase, l.customer.liveAt, ...next(l)], ["live", "2026-10-20", "2026-10-30", "Angebot Website"]);
  // Gekündigt drops the customer from Heute.
  await uc.changeCustomer(id, { phase: "gekuendigt", reason: "Preis" });
  assert.deepEqual(next(await store.get("leads", id)), [null, ""]);
});

test("in onboarding the open step stays the next step: their mail is answered, then the step is back on its day, and an overdue step stays overdue", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde", email: "info@linde.at" });
  await uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Wann kommt der Vertrag?" });
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-15", "Antworten"]);
  today = "2026-10-20";
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Kommt heute." });
  // "Vertrag unterschrieben" was due on the 15th: still due then, so still overdue on the 20th.
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-15", "Vertrag unterschrieben"]);
});

test("a change to the care alone shows in Änderungen", () => {
  const care = { phase: "onboarding", since: "2026-10-15", owner: "", steps: [], liveAt: "", cancelReason: "" };
  assert.deepEqual(describeChange({ before: { name: "Linde", customer: care }, after: { name: "Linde", customer: { ...care, owner: "anna@bookete.com" } } }), ["Betreuung ge\xE4ndert"]);
});

test("in onboarding our contact leaves a Termin, a Rückruf or a step a person typed; it takes back only what the onboarding planned", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde", email: "info@linde.at" });
  await uc.scheduleMeeting(id, { date: "2026-10-25", time: "10:00" });
  today = "2026-10-20";
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Bis Sonntag!" });
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-25", "Termin um 10:00"]);
});

test("Kunde set back before any step was done was a mistake: the care and the step it planned go, and a real win later starts anew", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "qualifiziert", followUp: "2026-10-20", nextStep: "Termin um 10:00" });
  await uc.changeStatus(id, "kunde");
  await uc.changeStatus(id, "qualifiziert");
  let l = await store.get("leads", id);
  assert.deepEqual([l.customer, ...next(l)], [undefined, null, ""]);
  today = "2027-02-01";
  await uc.changeStatus(id, "kunde");
  l = await store.get("leads", id);
  assert.deepEqual([l.customer.since, ...next(l)], ["2027-02-01", "2027-02-01", "Vertrag unterschrieben"]);
  // With a step done it was no mistake: the care stays.
  await uc.changeCustomer(id, { step: "vertrag" });
  await uc.changeStatus(id, "qualifiziert");
  assert.equal((await store.get("leads", id)).customer.steps.length, 1);
});

test("a customer who cancelled stays out of Heute after our contact; Live is never left out", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Post", status: "kunde", email: "info@post.at" });
  await uc.changeCustomer(id, { phase: "gekuendigt", reason: "Preis" });
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Schade, alles Gute!" });
  assert.deepEqual(next(await store.get("leads", id)), [null, ""]);
  const other = await uc.addLead({ name: "Linde", status: "kunde" });
  await rejects(uc.changeCustomer(other, { step: "live", skip: "" }), "step");
});

test("an imported customer looked after by someone not of the team is looked after by nobody", async () => {
  const { store, uc } = setup();
  const customer = { phase: "live", since: "2026-09-01", owner: "fremd@example.at", steps: [], liveAt: "2026-09-14", cancelReason: "" };
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ id: "L8", name: "Krone", status: "kunde", schemaVersion: 3, customer }] } });
  assert.equal((await store.get("leads", "L8")).customer.owner, "");
});
