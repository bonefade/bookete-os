import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { ValidationError, ConflictError } from "../src/domain/errors.js";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };

/** Two people on one database. `between(fn, read)` runs fn right after A's next `read` (default get), before A commits. */
function twoUsers() {
  const store = createStore(createD1());
  let n = 0, pending = null;
  const ids = { newId: () => `id${++n}` };
  const racing = { ...store };
  for (const read of ["get", "getDeleted", "activitiesOf"]) {
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

test("after three lost races the caller gets a ConflictError and nothing is written", async () => {
  const store = createStore(createD1());
  let n = 0;
  const ids = { newId: () => `id${++n}` };
  const b = createUseCases({ store, clock, ids, actor: "michael@bookete.com (web)" });
  let races = 0;
  const busy = { ...store, async get(collection, id) {
    const found = await store.get(collection, id);
    races++;
    await b.setNextStep(id, `Anruf ${races}`);
    return found;
  } };
  const a = createUseCases({ store: busy, clock, ids, actor: "jo@bookete.com (web)" });
  const id = await b.addLead({ name: "Gasthaus Krone" });
  await assert.rejects(a.setFollowUp(id, "2026-10-20"), ConflictError);
  assert.equal(races, 3);
  const lead = await store.get("leads", id);
  assert.equal(lead.followUp, null);
  assert.equal(lead.nextStep, "Anruf 3");
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
