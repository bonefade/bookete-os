import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrders, ordersOf, ordersAfter, orderEnd, packageOf, HOSTING_CARE } from "../src/domain/orders.js";
import { addMonths } from "../src/domain/dates.js";
import { ValidationError } from "../src/domain/errors.js";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { BACKUP_FORMAT } from "../src/domain/backup.js";
import { describeChange } from "../src/web/format.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";

const rejects = (fn, field) => assert.throws(fn, (e) => e instanceof ValidationError && e.field === field);
const clock = { today: () => "2026-10-20", now: () => "2026-10-20T10:00:00.000Z" };
function setup() {
  const store = createStore(createD1());
  let k = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++k}` }, actor: "jo@bookete.com (test)", email: "jo@bookete.com", team: ["jo@bookete.com"] });
  return { store, uc };
}
const mcp = async (context, name, args) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), context)).json()).result;
let n = 0;
const newId = () => `o${++n}`;

test("months are added as a calendar does: past the end of a shorter month, its last day", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-11-01", 12), "2027-11-01");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  // A runtime ends the day before the same day months on.
  assert.equal(orderEnd({ start: "2026-11-01", months: 12 }), "2027-10-31");
  assert.equal(orderEnd({ start: "2026-01-31", months: 1 }), "2026-02-27");
  assert.equal(orderEnd({ start: "2026-11-01", months: "" }), "");
  assert.equal(orderEnd({ start: "", months: 12 }), "");
});

test("an Auftrag is checked and trimmed; a value not allowed is refused, never replaced", () => {
  const [o] = normalizeOrders([{ kind: "hosting", title: " Hosting\nCare ", amount: "99,50", months: "12", renews: true, contract: " https://app.fynk.com/c/1 " }], newId);
  assert.deepEqual(o, { id: o.id, kind: "hosting", title: "Hosting Care", amount: 99.5, rhythm: "einmalig", signedAt: "", start: "", months: 12, renews: true, contract: "https://app.fynk.com/c/1", note: "" });
  rejects(() => normalizeOrders([{ kind: "abo" }], newId), "kind");
  rejects(() => normalizeOrders([{ kind: "website", rhythm: "taeglich" }], newId), "rhythm");
  rejects(() => normalizeOrders([{ kind: "website", amount: -1 }], newId), "amount");
  rejects(() => normalizeOrders([{ kind: "website", amount: 1.005 }], newId), "amount");
  rejects(() => normalizeOrders([{ kind: "website", amount: 2e6 }], newId), "amount");
  rejects(() => normalizeOrders([{ kind: "website", months: 0 }], newId), "months");
  rejects(() => normalizeOrders([{ kind: "website", months: 1.5 }], newId), "months");
  rejects(() => normalizeOrders([{ kind: "website", start: "01.11.2026" }], newId), "start");
  rejects(() => normalizeOrders([{ kind: "website", contract: "http://fynk.com/c/1" }], newId), "contract");
  rejects(() => normalizeOrders([{ kind: "website", contract: "javascript:alert(1)" }], newId), "contract");
  rejects(() => normalizeOrders(Array.from({ length: 51 }, () => ({ kind: "sonstiges" })), newId), "orders");
  rejects(() => normalizeOrders([{ id: "a", kind: "website" }, { id: "a", kind: "bookete" }], newId), "orders");
});

test("the package comes from the kinds: a website comes with bookete, so it makes both; anything else is bookete", () => {
  const of = (...kinds) => packageOf(kinds.map((kind) => ({ kind })));
  assert.deepEqual([of(), of("hosting"), of("bookete"), of("website"), of("website", "hosting"), of("website", "bookete"), of("individuell", "sonstiges")], ["bookete", "bookete", "bookete", "beides", "beides", "beides", "bookete"]);
});

test("one change at a time: add, change only the fields given, remove; a Vereinbarung of before reads as one Auftrag", () => {
  let list = ordersAfter([], { add: { ...HOSTING_CARE } }, { newId });
  const id = list[0].id;
  list = ordersAfter(list, { order: id, start: "2026-11-01", note: "erste Rechnung mit dem Vertrag" }, { newId });
  assert.deepEqual([list[0].amount, list[0].start, list[0].note, list[0].renews], [99, "2026-11-01", "erste Rechnung mit dem Vertrag", true]);
  rejects(() => ordersAfter(list, { order: "weg", amount: 1 }, { newId }), "order");
  assert.deepEqual(ordersAfter(list, { order: "weg", remove: true }, { newId }), list);
  assert.deepEqual(ordersAfter(list, { order: id, remove: true }, { newId }), []);
  // A Vereinbarung of before: its text kept in the note, the amount open.
  assert.deepEqual(ordersOf({ deal: { price: "300 € netto einmalig", hosting: "care", signedAt: "2026-10-12", note: "Abo selbst" } }), [
    { id: "vereinbarung", kind: "sonstiges", title: "Vereinbarung", amount: "", rhythm: "einmalig", signedAt: "2026-10-12", start: "", months: "", renews: false, contract: "", note: "300 € netto einmalig · Hosting: Care · Abo selbst" },
  ]);
  assert.deepEqual(ordersOf({}), []);
});

test("changeOrder writes the Aufträge of a Kunde only; the first write takes the place of the Vereinbarung; it shows in Änderungen", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  const lead = await store.get("leads", id);
  await store.commit([{ type: "put", collection: "leads", id, data: { ...lead, deal: { price: "300", hosting: "care", signedAt: "", note: "" } } }], "test");
  assert.equal(await uc.changeOrder(id, { order: "vereinbarung", kind: "website", amount: 300 }), true);
  let l = await store.get("leads", id);
  assert.deepEqual([l.deal, l.orders.length, l.orders[0].kind, l.orders[0].amount, l.orders[0].note], [undefined, 1, "website", 300, "300 · Hosting: Care"]);
  assert.equal(await uc.changeOrder(id, { order: "vereinbarung", amount: 300 }), false);
  const [last] = await store.history(id);
  assert.deepEqual(describeChange(last).includes("Auftr\xE4ge ge\xE4ndert"), true);
  // Not a customer: no Aufträge.
  const other = await uc.addLead({ name: "Post", status: "qualifiziert" });
  await assert.rejects(uc.changeOrder(other, { add: { kind: "website" } }), (e) => e instanceof ValidationError && e.field === "status");
  assert.equal((await store.get("leads", other)).orders, undefined);
});

test("two writers changing different Aufträge both land", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  await uc.changeOrder(id, { add: { kind: "website" } });
  await uc.changeOrder(id, { add: { kind: "hosting" } });
  const [a, b] = (await store.get("leads", id)).orders;
  await Promise.all([uc.changeOrder(id, { order: a.id, amount: 1000 }), uc.changeOrder(id, { order: b.id, amount: 99 })]);
  assert.deepEqual((await store.get("leads", id)).orders.map((o) => o.amount), [1000, 99]);
});

test("a backup keeps the Aufträge; one from before 1.30.0 brings its Vereinbarung in as one", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  await uc.changeOrder(id, { add: { kind: "website", amount: 1000 } });
  const lead = { ...(await store.get("leads", id)), id: "B1" };
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [lead, { ...LEAD_FIELDS, id: "B2", name: "Post", status: "kunde", schemaVersion: 3, deal: { price: " 49 ", hosting: "care" } }, { ...LEAD_FIELDS, id: "B3", name: "Bar", schemaVersion: 3 }] } });
  assert.deepEqual((await store.get("leads", "B1")).orders, lead.orders);
  const b2 = await store.get("leads", "B2");
  assert.deepEqual([b2.deal, b2.orders[0].kind, b2.orders[0].note], [undefined, "sonstiges", "49 · Hosting: Care"]);
  assert.equal((await store.get("leads", "B3")).orders, undefined);
});

test("RPC and MCP take an Auftrag through one schema; an agent reads them in get_lead, a Vereinbarung of before as one", async () => {
  const { store, uc } = setup();
  const [schema] = COMMANDS.changeOrder;
  const ok = (input) => schema.safeParse({ id: "a", ...input }).success;
  assert.equal(ok({ add: { kind: "hosting", amount: 99, rhythm: "jaehrlich", months: 12, renews: true } }), true);
  assert.equal(ok({ add: { amount: 99 } }), false);
  assert.equal(ok({ add: { kind: "website", price: "300" } }), false);
  assert.equal(ok({ order: "o1", amount: "" }), true);
  assert.equal(ok({ order: "o1", amount: "300" }), false);
  assert.equal(ok({ order: "o1" }), false);
  assert.equal(ok({ order: "o1", remove: true }), true);
  assert.equal(ok({ order: "o1", remove: true, amount: 1 }), false);
  assert.equal(ok({ add: { kind: "website" }, order: "o1" }), false);
  assert.equal(ok({ order: "o1", months: 0 }), false);
  const context = { store, clock, uc };
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  assert.deepEqual(JSON.parse((await mcp(context, "update_order", { id, add: { kind: "hosting", amount: 99, rhythm: "jaehrlich" } })).content[0].text), { ok: true });
  const read = async (lead) => JSON.parse((await mcp(context, "get_lead", { id: lead })).content[0].text).lead;
  const [o] = (await read(id)).orders;
  assert.deepEqual([o.kind, o.amount, o.rhythm], ["hosting", 99, "jaehrlich"]);
  assert.ok((await mcp(context, "update_order", { id, order: o.id, contract: "http://x" })).isError);
  // A Vereinbarung of before: no `deal`, one Auftrag.
  const old = await uc.addLead({ name: "Post", status: "kunde" });
  await store.commit([{ type: "put", collection: "leads", id: old, data: { ...(await store.get("leads", old)), deal: { price: "500 €", hosting: "", signedAt: "", note: "" } } }], "test");
  const oldRead = await read(old);
  assert.deepEqual([oldRead.deal, oldRead.orders.map((x) => x.note)], [undefined, ["500 €"]]);
  // A lead with none has no `orders` key; one that is no customer takes none.
  assert.equal((await read(await uc.addLead({ name: "Bar", status: "kunde" }))).orders, undefined);
  assert.ok((await mcp(context, "update_order", { id: await uc.addLead({ name: "Neu" }), add: { kind: "website" } })).isError);
});
