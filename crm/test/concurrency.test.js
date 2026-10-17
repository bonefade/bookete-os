import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { retryPause } from "../src/adapters/system.js";
import { ValidationError, ConflictError } from "../src/domain/errors.js";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };

/** Two people on one database. `between(fn, read)` runs fn right after A's next `read` (default get), before A commits. */
function twoUsers() {
  const store = createStore(createD1());
  let n = 0, pending = null;
  const ids = { newId: () => `id${++n}` };
  const racing = { ...store };
  for (const read of ["get", "getDeleted", "activitiesOf", "heldLeads"]) {
    racing[read] = async (...args) => {
      const found = await store[read](...args);
      if (pending?.read === read) {
        const { fn } = pending;
        pending = null;
        await fn();
      }
      return found;
    };
  }
  return {
    store,
    // No pause, so a retry runs at once: the races here are staged, not timed.
    a: createUseCases({ store: racing, clock, ids, actor: "jo@bookete.com (web)" }),
    b: createUseCases({ store, clock, ids, actor: "michael@bookete.com (web)" }),
    between: (fn, read = "get") => { pending = { fn, read }; },
  };
}

test("a status change made while an activity is being logged is not overwritten", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  between(() => b.changeStatus(id, "qualifiziert"));
  await a.logActivity(id, { direction: "in", channel: "E-Mail", text: "Gerne am Montag" });
  // Same result as if the two had happened one after the other.
  const { store: s2, a: a2, b: b2 } = twoUsers();
  const id2 = await b2.addLead({ name: "Gasthaus Krone" });
  await b2.changeStatus(id2, "qualifiziert");
  await a2.logActivity(id2, { direction: "in", channel: "E-Mail", text: "Gerne am Montag" });
  const [got, want] = [await store.get("leads", id), await s2.get("leads", id2)];
  assert.equal(got.status, want.status);
  assert.equal(got.nextStep, want.nextStep);
});

test("an edit to a lead deleted in the meantime fails instead of succeeding silently", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  between(() => b.deleteLead(id));
  await assert.rejects(a.setNextStep(id, "Anrufen"), (e) => e instanceof ValidationError && e.field === "id");
  assert.equal(await store.get("leads", id), null);
});

test("a form save racing another user's edit runs again on fresh data and keeps both edits", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone", phone: "0664 1" });
  between(() => b.updateField(id, "phone", "0664 2"));
  await a.updateLead(id, { notes: "Will eine Demo" });
  const lead = await store.get("leads", id);
  assert.equal(lead.phone, "0664 2");
  assert.equal(lead.notes, "Will eine Demo");
});

test("a Kundenakte save racing another write runs again on fresh data: other fields are kept, a changed Kundenakte refuses it", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone", status: "kunde" });
  between(() => b.updateField(id, "notes", "Will eine Website"));
  assert.equal(await a.saveAccount(id, { systems: { domain: { what: "krone.at" } } }, {}), true);
  const lead = await store.get("leads", id);
  assert.deepEqual([lead.notes, lead.account.systems.domain.what], ["Will eine Website", "krone.at"]);
  between(() => b.saveAccount(id, { contacts: [{ name: "Anna" }] }, lead.account));
  await assert.rejects(a.saveAccount(id, { contacts: [{ name: "Max" }] }, lead.account), (e) => e instanceof ValidationError && e.field === "account");
  assert.deepEqual((await store.get("leads", id)).account.contacts.map((c) => c.name), ["Anna"]);
});

test("an outgoing message logged while the lead opts out is refused", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  await b.logActivity(id, { direction: "out", channel: "E-Mail", text: "Hallo" });
  between(() => b.optOut(id, "per Telefon"));
  await assert.rejects(a.logActivity(id, { direction: "out", channel: "E-Mail", text: "Nochmal" }), (e) => e instanceof ValidationError && e.field === "optOutAt");
  assert.deepEqual((await store.activitiesOf(id)).map((x) => x.text).filter((t) => t === "Nochmal"), []);
});

test("an activity logged while the lead is deleted is refused, not left behind", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  between(() => b.deleteLead(id));
  await assert.rejects(a.logActivity(id, { direction: "in", channel: "E-Mail", text: "Gerne" }), (e) => e instanceof ValidationError && e.field === "id");
  assert.deepEqual(await store.activitiesOf(id), []);
});

test("after three lost races, each followed by a pause, the caller gets a ConflictError and nothing is written", async () => {
  const store = createStore(createD1());
  let n = 0;
  const ids = { newId: () => `id${++n}` };
  const b = createUseCases({ store, clock, ids, actor: "michael@bookete.com (web)" });
  let races = 0;
  const steps = [];
  const busy = { ...store, async get(collection, id) {
    const found = await store.get(collection, id);
    races++;
    steps.push("read");
    await b.setNextStep(id, `Anruf ${races}`);
    return found;
  } };
  // The pause ends after the pending reads and writes: a retry that did not wait for it would read first.
  const recorded = async (attempt) => { await new Promise((resolve) => setImmediate(resolve)); steps.push(`pause ${attempt}`); };
  const a = createUseCases({ store: busy, clock, ids, pause: recorded, actor: "jo@bookete.com (web)" });
  const id = await b.addLead({ name: "Gasthaus Krone" });
  await assert.rejects(a.setFollowUp(id, "2026-10-20"), ConflictError);
  assert.equal(races, 3);
  // A pause before each retry, none after the last attempt.
  assert.deepEqual(steps, ["read", "pause 1", "read", "pause 2", "read"]);
  const lead = await store.get("leads", id);
  assert.equal(lead.followUp, null);
  assert.equal(lead.nextStep, "Anruf 3");
});

test("retryPause waits a random time below 100 ms times the attempt", async (t) => {
  const waits = [];
  t.mock.method(globalThis, "setTimeout", (resolve, ms) => { waits.push(ms); resolve(); });
  let random = 0.5;
  t.mock.method(Math, "random", () => random);
  await retryPause(1);
  await retryPause(2);
  // Math.random stays below 1, so the wait stays below the bound.
  random = 0.999;
  await retryPause(2);
  assert.deepEqual(waits.slice(0, 2), [50, 100]);
  assert.ok(waits[2] > 199 && waits[2] < 200, `waited ${waits[2]} ms`);
});

test("a commit with a stale read rolls back entirely, history included", async () => {
  const { store, b } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  const stale = await store.get("leads", id);
  await b.setNextStep(id, "Anrufen");
  const before = await store.history(id);
  await assert.rejects(store.commit([
    { type: "put", collection: "activities", id: "x", data: { leadId: id } },
    { type: "patch", collection: "leads", id, base: stale, data: { notes: "alt" } },
  ], "test"), ConflictError);
  assert.deepEqual(await store.history(id), before);
  assert.deepEqual(await store.activitiesOf(id), []);
  assert.equal((await store.get("leads", id)).notes, "");
});

test("an activity logged while the lead is being deleted goes to the trash with it", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  between(() => b.logActivity(id, { direction: "in", channel: "E-Mail", text: "Gerne" }), "activitiesOf");
  await a.deleteLead(id);
  assert.deepEqual(await store.activitiesOf(id), []);
  assert.deepEqual((await store.activitiesOf(id, { deleted: true })).map((x) => x.text), ["Gerne"]);
});

test("an opt-out recorded while the lead is deleted is refused, not left behind", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  between(() => b.deleteLead(id));
  await assert.rejects(a.optOut(id, "per Telefon"), (e) => e instanceof ValidationError && e.field === "id");
  assert.deepEqual(await store.activitiesOf(id), []);
});

test("a restore racing an erase does not bring back an empty lead", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  await b.deleteLead(id);
  between(() => b.purgeLead(id), "getDeleted");
  await assert.rejects(a.restoreLead(id), (e) => e instanceof ValidationError && e.field === "id");
  assert.equal(await store.get("leads", id), null);
});

test("an import racing an erase adds nothing to the erased lead", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Geheim" });
  await b.deleteLead(id);
  const backup = { format: "bookete-crm-backup", data: { activities: [{ id: "A-old", leadId: id, direction: "in", channel: "E-Mail", date: "2026-10-01", text: "Geheim antwortet" }] } };
  between(() => b.purgeLead(id), "heldLeads");
  await assert.rejects(a.importBackup(backup), ConflictError);
  assert.equal(await a.importBackup(backup), 0);
  assert.equal((await store.ids("activities")).has("A-old"), false);
});

test("an import racing a delete leaves no live activity beside the deleted lead", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  const backup = { format: "bookete-crm-backup", data: { activities: [{ id: "A-old", leadId: id, direction: "in", channel: "E-Mail", date: "2026-10-01", text: "Gerne" }] } };
  between(() => b.deleteLead(id), "heldLeads");
  await assert.rejects(a.importBackup(backup), ConflictError);
  assert.equal((await store.ids("activities")).has("A-old"), false);
  // Run again, the import puts it into the trash with its lead.
  assert.equal(await a.importBackup(backup), 1);
  assert.deepEqual((await store.activitiesOf(id, { deleted: true })).map((x) => x.text), ["Gerne"]);
});

test("an erase racing a restore leaves the restored lead and its history alone", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  await b.deleteLead(id);
  between(() => b.restoreLead(id), "getDeleted");
  await assert.rejects(a.purgeLead(id), (e) => e instanceof ValidationError && e.field === "id");
  assert.equal((await store.get("leads", id)).name, "Gasthaus Krone");
  assert.equal((await store.history(id)).length, 3);
});

test("a template deleted while it is being saved is not saved back", async () => {
  const { store, a, b, between } = twoUsers();
  const id = await b.saveTemplate(null, { name: "Erst", purpose: "erstkontakt", body: "Hallo" });
  between(() => b.deleteTemplate(id));
  await assert.rejects(a.saveTemplate(id, { name: "Erst", purpose: "erstkontakt", body: "Hallo 2" }), (e) => e instanceof ValidationError && e.field === "id");
  assert.equal(await store.get("templates", id), null);
});

test("the store refuses a change to an existing record that does not name the read it is based on", async () => {
  const { store, b } = twoUsers();
  const id = await b.addLead({ name: "Gasthaus Krone" });
  for (const type of ["patch", "remove", "restore"]) {
    await assert.rejects(store.commit([{ type, collection: "leads", id, data: { notes: "x" } }], "test"), /base/);
  }
  assert.equal((await store.get("leads", id)).notes, "");
});
