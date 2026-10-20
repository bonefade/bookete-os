import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { ValidationError } from "../src/domain/errors.js";
import { customerOf, attentionOf, normalizeCustomer, onboardingOf } from "../src/domain/customer.js";
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
  assert.deepEqual(l.customer, { phase: "onboarding", package: "bookete", since: "2026-10-15", owner: "jo@bookete.com", steps: [], liveAt: "", cancelReason: "", checkIns: [], nextCheckIn: "" });
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
  // Live may come before the other steps: the customer is live from that day, its first check-in 14 days on.
  today = "2026-10-25";
  await uc.changeCustomer(id, { step: "live" });
  l = await store.get("leads", id);
  assert.deepEqual([l.customer.phase, l.customer.liveAt, ...next(l)], ["live", "2026-10-25", "2026-11-08", "Check-in"]);
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
  assert.deepEqual(customerOf(old), { phase: "live", package: "bookete", since: "", owner: "", steps: [], liveAt: "2026-06-20", cancelReason: "", checkIns: [], nextCheckIn: "" });
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
  assert.equal(ok({ package: "beides" }), true);
  assert.equal(ok({ package: "alles" }), false);
  assert.equal(ok({ phase: "gekuendigt", reason: "Preis" }), true);
  assert.equal(ok({ step: "kaffee" }), false);
  assert.equal(ok({ owner: "niemand" }), false);
  assert.equal(ok({ phase: "pausiert" }), false);
  assert.equal(ok({ step: "widget", owner: "jo@bookete.com" }), false);
  const customer = { phase: "live", package: "beides", since: "2026-09-01", owner: "anna@bookete.com", steps: [{ id: "vertrag", at: "2026-09-01", by: "anna" }], liveAt: "2026-09-14", cancelReason: "", checkIns: [{ at: "2026-09-28", result: "gut", by: "anna", note: "" }], nextCheckIn: "2026-12-13" };
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

test("check-ins: the first 14 days after going live, the second 90 days after it, then every 90 days; each is the next step on its day", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Seeblick", status: "kunde" });
  await rejects(uc.changeCustomer(id, { checkIn: "gut" }), "phase");
  today = "2026-10-20";
  await uc.changeCustomer(id, { step: "live" });
  assert.deepEqual(next(await store.get("leads", id)), ["2026-11-03", "Check-in"]);
  // The first, a day late: the second stays 90 days after going live, the 18th of January.
  today = "2026-11-04";
  await uc.changeCustomer(id, { checkIn: "gut", note: "Gäste buchen online" });
  let l = await store.get("leads", id);
  assert.deepEqual([l.customer.checkIns, ...next(l)], [[{ at: "2026-11-04", result: "gut", by: "jo@bookete.com (test)", note: "Gäste buchen online" }], "2027-01-18", "Check-in"]);
  // Then every 90 days from the last one.
  today = "2027-01-20";
  await uc.changeCustomer(id, { checkIn: "fragen" });
  assert.deepEqual(next(await store.get("leads", id)), ["2027-04-20", "Check-in"]);
  // A date picked for the next one is taken; it lies after today.
  await rejects(uc.changeCustomer(id, { checkIn: "gut", next: "2027-01-20" }), "next");
  await uc.changeCustomer(id, { checkIn: "gut", next: "2027-03-01" });
  assert.deepEqual(next(await store.get("leads", id)), ["2027-03-01", "Check-in"]);
});

test("an unhappy check-in asks when to call again and puts the customer on Achtung until the next one", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Seeblick", status: "kunde" });
  await uc.changeCustomer(id, { phase: "live" });
  await rejects(uc.changeCustomer(id, { checkIn: "unzufrieden" }), "next");
  await uc.changeCustomer(id, { checkIn: "unzufrieden", next: "2026-10-22", note: "Widget lädt langsam" });
  let c = (await store.get("leads", id)).customer;
  assert.deepEqual([attentionOf(c, "2026-10-15"), c.nextCheckIn], ["Unzufrieden", "2026-10-22"]);
  today = "2026-10-22";
  await uc.changeCustomer(id, { checkIn: "gut" });
  c = (await store.get("leads", id)).customer;
  assert.equal(attentionOf(c, "2026-10-22"), "");
});

test("Achtung: an onboarding step 3 days late, a check-in a week late; never a cancelled customer", () => {
  const onboarding = normalizeCustomer({ phase: "onboarding", since: "2026-10-01" });
  // "Vertrag unterschrieben" was due on the 1st.
  assert.equal(attentionOf(onboarding, "2026-10-03"), "");
  assert.equal(attentionOf(onboarding, "2026-10-04"), "Onboarding hängt");
  const live = normalizeCustomer({ phase: "live", since: "2026-06-01", nextCheckIn: "2026-10-10" });
  assert.equal(attentionOf(live, "2026-10-16"), "");
  assert.equal(attentionOf(live, "2026-10-17"), "Check-in überfällig");
  assert.equal(attentionOf({ ...live, phase: "gekuendigt" }, "2026-12-01"), "");
});

test("on a live customer our contact keeps the check-in as the next step, but not over a step a person typed", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Seeblick", status: "kunde", email: "info@seeblick.at" });
  await uc.changeCustomer(id, { phase: "live" });
  await uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Frage zur Rechnung" });
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-15", "Antworten"]);
  today = "2026-10-16";
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Antwort" });
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-29", "Check-in"]);
  await uc.setNextStep(id, "Angebot Website");
  today = "2026-10-17";
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Angebot folgt" });
  assert.equal((await store.get("leads", id)).nextStep, "Angebot Website");
});

test("a live customer from before gets its first check-in 14 days after its first change", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Seeblick", status: "kunde" });
  const { customer: _c, ...without } = await store.get("leads", id);
  await store.commit([{ type: "put", collection: "leads", id, data: { ...without, account: { services: [{ kind: "bookete", state: "live", goLive: "2026-06-20" }] } } }], "test");
  today = "2026-10-20";
  await uc.changeCustomer(id, { owner: "jo@bookete.com" });
  const l = await store.get("leads", id);
  assert.deepEqual([l.customer.phase, l.customer.liveAt, l.customer.nextCheckIn, ...next(l)], ["live", "2026-06-20", "2026-11-03", "2026-11-03", "Check-in"]);
  assert.equal(COMMANDS.changeCustomer[0].safeParse({ id: "a", checkIn: "gut", next: "2026-11-01", note: "ok" }).success, true);
  assert.equal(COMMANDS.changeCustomer[0].safeParse({ id: "a", checkIn: "super" }).success, false);
});

test("care stored by 1.20.0 gets what it lacks from its next change: a live one its first check-in 14 days on, one without a start day its steps' days", async () => {
  const { store, uc } = setup();
  const live = await uc.addLead({ name: "Seeblick", status: "kunde" });
  const won = await store.get("leads", live);
  // As 1.20.0 stored a live customer: no check-ins, no check-in day, live since June.
  const old = { phase: "live", since: "2026-06-01", owner: "", steps: [], liveAt: "2026-06-20", cancelReason: "" };
  await store.commit([{ type: "put", collection: "leads", id: live, data: { ...won, customer: old, followUp: null, nextStep: "" } }], "test");
  today = "2026-10-20";
  await uc.changeCustomer(live, { owner: "jo@bookete.com" });
  let l = await store.get("leads", live);
  assert.deepEqual([l.customer.nextCheckIn, ...next(l)], ["2026-11-03", "2026-11-03", "Check-in"]);
  // An imported care without a start day: its steps count from the first change.
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ id: "L7", name: "Linde", status: "kunde", schemaVersion: 3, customer: { phase: "onboarding", since: "" } }] } });
  await uc.changeCustomer("L7", { step: "vertrag" });
  l = await store.get("leads", "L7");
  assert.deepEqual([l.customer.since, ...next(l)], ["2026-10-20", "2026-10-21", "Abo abgeschlossen"]);
});

test("live again after a cancellation starts that day: its first check-in 14 days on, an old unhappy check-in past", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Post", status: "kunde" });
  await uc.changeCustomer(id, { phase: "live" });
  await uc.changeCustomer(id, { checkIn: "unzufrieden", next: "2026-10-20" });
  today = "2026-11-10";
  await uc.changeCustomer(id, { phase: "gekuendigt", reason: "Preis" });
  today = "2027-03-01";
  await uc.changeCustomer(id, { phase: "live" });
  const l = await store.get("leads", id);
  assert.deepEqual([l.customer.liveAt, l.customer.nextCheckIn, ...next(l), attentionOf(l.customer, "2027-03-01")], ["2027-03-01", "2027-03-15", "2027-03-15", "Check-in", ""]);
});

test("a care keeps its last 40 check-ins", () => {
  const checkIns = Array.from({ length: 45 }, (_, i) => ({ at: `2020-01-${String(i % 28 + 1).padStart(2, "0")}`.replace("2020", String(2020 + Math.floor(i / 28))), result: "gut", by: "jo" }));
  const kept = normalizeCustomer({ phase: "live", checkIns }).checkIns;
  assert.equal(kept.length, 40);
  assert.equal(kept[0].at, "2020-01-06");
});

test("a later step can be done or left out first: the first open step stays the next step", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde" });
  // The Abo is booked; the website contract is not signed yet.
  await uc.changeCustomer(id, { step: "abo" });
  await uc.changeCustomer(id, { step: "google", skip: "kein Google-Profil" });
  const l = await store.get("leads", id);
  assert.deepEqual(l.customer.steps.map((s) => s.id), ["abo", "google"]);
  assert.deepEqual(next(l), ["2026-10-15", "Vertrag unterschrieben"]);
});

test("the package decides the steps: a website takes its own, both take all; a new package moves the next step to its open one", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde" });
  await uc.changeCustomer(id, { step: "vertrag" });
  await uc.changeCustomer(id, { step: "abo" });
  await uc.changeCustomer(id, { step: "konto" });
  // bookete: the Widget is due on day 4.
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-19", "Widget auf der Website"]);
  // A website alone: its first step, on day 3, and no bookete step to tick.
  await uc.changeCustomer(id, { package: "website" });
  let l = await store.get("leads", id);
  assert.deepEqual([l.customer.package, ...next(l)], ["website", "2026-10-18", "Inhalte & Fotos erhalten"]);
  assert.deepEqual(onboardingOf(l.customer).map((s) => s.id), ["vertrag", "abo", "inhalte", "domain", "entwurf", "online", "uebergabe", "live"]);
  await rejects(uc.changeCustomer(id, { step: "widget" }), "step");
  await rejects(uc.changeCustomer(id, { package: "alles" }), "package");
  // Both: every step, in the order they are due; the Konto ticked before is done again.
  await uc.changeCustomer(id, { package: "beides" });
  l = await store.get("leads", id);
  const steps = onboardingOf(l.customer);
  assert.deepEqual(steps.map((s) => s.id), ["vertrag", "abo", "konto", "inhalte", "widget", "domain", "google", "entwurf", "team", "online", "uebergabe", "live"]);
  assert.deepEqual(steps.filter((s) => s.at).map((s) => s.id), ["vertrag", "abo", "konto"]);
  assert.deepEqual(next(l), ["2026-10-18", "Inhalte & Fotos erhalten"]);
  // Back to bookete: the website's steps leave the list, the next step is bookete's again.
  await uc.changeCustomer(id, { package: "bookete" });
  assert.deepEqual(next(await store.get("leads", id)), ["2026-10-19", "Widget auf der Website"]);
});

test("a new package leaves a Termin a person planned, and a next step whose open step it does not change; a cancelled customer keeps its package", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde", email: "info@linde.at" });
  for (const step of ["vertrag", "abo", "konto"]) await uc.changeCustomer(id, { step });
  // The website moves the open step from the Widget to the photos, yet the Termin stays the next step.
  await uc.scheduleMeeting(id, { date: "2026-10-25", time: "10:00" });
  await uc.changeCustomer(id, { package: "website" });
  let l = await store.get("leads", id);
  assert.deepEqual([l.customer.package, ...next(l)], ["website", "2026-10-25", "Termin um 10:00"]);
  // The open step is Vertrag in every package: a follow-up a person moved stays.
  const moved = await uc.addLead({ name: "Post", status: "kunde" });
  await uc.setFollowUp(moved, "2026-10-22");
  await uc.changeCustomer(moved, { package: "beides" });
  assert.deepEqual(next(await store.get("leads", moved)), ["2026-10-22", "Vertrag unterschrieben"]);
  await uc.changeCustomer(id, { phase: "gekuendigt", reason: "Preis" });
  await rejects(uc.changeCustomer(id, { package: "bookete" }), "phase");
  l = await store.get("leads", id);
  assert.equal(l.customer.package, "website");
});
