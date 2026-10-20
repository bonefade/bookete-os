import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDeal, dealOf, EMPTY_DEAL } from "../src/domain/deal.js";
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
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++k}` }, actor: "jo@bookete.com (test)" });
  return { store, uc };
}
const mcp = async (context, name, args) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), context)).json()).result;

test("a deal is trimmed to one line, capped and checked; nothing given is empty", () => {
  assert.deepEqual(normalizeDeal(undefined), EMPTY_DEAL);
  assert.deepEqual(normalizeDeal({ price: "  300 €\nnetto  einmalig ", hosting: "care", signedAt: "2026-10-12", note: "Abo bucht\r\ndas Restaurant selbst" }),
    { price: "300 € netto einmalig", hosting: "care", signedAt: "2026-10-12", note: "Abo bucht das Restaurant selbst" });
  const long = normalizeDeal({ price: "x".repeat(300), note: "y".repeat(600) });
  assert.deepEqual([long.price.length, long.note.length], [200, 500]);
  // A value not allowed is refused, not replaced.
  rejects(() => normalizeDeal({ hosting: "Hetzner" }), "hosting");
  rejects(() => normalizeDeal({ signedAt: "12.10.2026" }), "signedAt");
});

test("changeDeal changes field by field on the deal as it is, only for a Kunde, and shows in Änderungen", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Bernsteiner", status: "kunde" });
  assert.equal(await uc.changeDeal(id, { price: "EUR 300 netto einmalig", signedAt: "2026-10-12" }), true);
  // A second change leaves the first fields; "" clears one; the same value again is no change.
  assert.equal(await uc.changeDeal(id, { hosting: "care" }), true);
  assert.equal(await uc.changeDeal(id, { hosting: "care" }), false);
  assert.equal(await uc.changeDeal(id, { signedAt: "" }), true);
  const l = await store.get("leads", id);
  assert.deepEqual(l.deal, { price: "EUR 300 netto einmalig", hosting: "care", signedAt: "", note: "" });
  assert.deepEqual(describeChange((await store.history(id))[0]), ["Vereinbarung ge\xE4ndert"]);
  await assert.rejects(uc.changeDeal(id, { hosting: "Hetzner" }), (e) => e instanceof ValidationError && e.field === "hosting");
  // Not a customer: no deal.
  const lead = await uc.addLead({ name: "Krone", status: "qualifiziert" });
  await assert.rejects(uc.changeDeal(lead, { price: "300" }), (e) => e instanceof ValidationError && e.field === "status");
  assert.equal((await store.get("leads", lead)).deal, undefined);
});

test("two writers changing different fields of the deal both land", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Bernsteiner", status: "kunde" });
  const base = await store.get("leads", id);
  // The second change is computed from what the first left, as a write from a stale read is run again.
  await Promise.all([uc.changeDeal(id, { price: "300" }), uc.changeDeal(id, { note: "Abo selbst" })]);
  assert.deepEqual((await store.get("leads", id)).deal, { price: "300", hosting: "", signedAt: "", note: "Abo selbst" });
  assert.equal(base.deal, undefined);
});

test("the deal survives a backup and lead edits; a backup takes it in today's shape", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  await uc.changeDeal(id, { price: "300", hosting: "selbst" });
  await uc.updateLead(id, { notes: "x" });
  assert.equal((await store.get("leads", id)).deal.price, "300");
  const lead = { ...(await store.get("leads", id)), id: "B1" };
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [lead, { ...LEAD_FIELDS, id: "B2", name: "Post", status: "kunde", schemaVersion: 3, deal: { price: " 49 ", hosting: "care" } }] } });
  assert.deepEqual((await store.get("leads", "B1")).deal, { price: "300", hosting: "selbst", signedAt: "", note: "" });
  assert.deepEqual((await store.get("leads", "B2")).deal, { price: "49", hosting: "care", signedAt: "", note: "" });
  // A lead without one stays without one.
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ ...LEAD_FIELDS, id: "B3", name: "Bar", schemaVersion: 3 }] } });
  assert.equal((await store.get("leads", "B3")).deal, undefined);
});

test("RPC and MCP take the deal through one schema: no unknown field, no unknown hosting, one change at a time or several", async () => {
  const { store, uc } = setup();
  const [schema] = COMMANDS.changeDeal;
  const ok = (input) => schema.safeParse({ id: "a", ...input }).success;
  assert.equal(ok({ price: "300", hosting: "care", signedAt: "2026-10-12", note: "x" }), true);
  assert.equal(ok({ hosting: "" }), true);
  assert.equal(ok({ hosting: "Hetzner" }), false);
  assert.equal(ok({ signedAt: "12.10.2026" }), false);
  assert.equal(ok({ price: "x".repeat(201) }), false);
  assert.equal(ok({ discount: "10 %" }), false);
  const context = { store, clock, uc };
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  assert.deepEqual(JSON.parse((await mcp(context, "update_deal", { id, price: "EUR 300 netto einmalig", hosting: "care" })).content[0].text), { ok: true });
  const read = async () => JSON.parse((await mcp(context, "get_lead", { id })).content[0].text).lead;
  assert.deepEqual((await read()).deal, { price: "EUR 300 netto einmalig", hosting: "care", signedAt: "", note: "" });
  // A lead with no deal stored has no `deal` key.
  const other = await uc.addLead({ name: "Post", status: "kunde" });
  assert.equal(JSON.parse((await mcp(context, "get_lead", { id: other })).content[0].text).lead.deal, undefined);
  // The rules hold for an agent: a lead that is no customer takes none; an unknown hosting is refused.
  const lead = await uc.addLead({ name: "Bar", status: "qualifiziert" });
  assert.ok((await mcp(context, "update_deal", { id: lead, price: "300" })).isError);
  assert.ok((await mcp(context, "update_deal", { id, hosting: "Hetzner" })).isError);
  assert.equal(dealOf(await store.get("leads", id)).price, "EUR 300 netto einmalig");
});
