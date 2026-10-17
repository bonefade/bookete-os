import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAccount, EMPTY_ACCOUNT, ACCOUNT_LIMIT, handledBy, showsAccount, accountOf } from "../src/domain/account.js";
import { ValidationError } from "../src/domain/errors.js";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { BACKUP_FORMAT } from "../src/domain/backup.js";
import { describeChange } from "../src/web/format.js";
import { detailView, accountEditView } from "../src/web/views.js";
import { accountInput, routeOf, parseRoute } from "../src/web/controller.js";
import { initialState } from "../src/web/store.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";

let n = 0;
const newId = () => `x${++n}`;
const rejects = (fn, field) => assert.throws(fn, (e) => e instanceof ValidationError && e.field === field);

test("an empty Kundenakte has every part, all empty", () => {
  assert.deepEqual(normalizeAccount({}, newId), EMPTY_ACCOUNT);
  assert.deepEqual(normalizeAccount(null, newId), EMPTY_ACCOUNT);
});

test("services, systems and contacts are trimmed, checked and get ids", () => {
  n = 0;
  const a = normalizeAccount({
    services: [{ kind: "Website", state: "in-arbeit", since: "2026-10-01", goLive: "", price: " 49 €/Monat ", note: "Zeile 1\nZeile 2" }],
    systems: { domain: { what: " krone.at ", by: "c1" }, domainOwner: "Agentur", registrar: "World4You", dns: { what: "Cloudflare", by: "c1" }, hosting: { what: "", by: "gibt-es-nicht" }, googleProfile: "Kunde", access: "1Password,\r\nTresor Kunden" },
    contacts: [{ id: "c1", name: " Max Muster ", company: "Webagentur\nX", role: "Agentur", handles: "Domain, DNS", email: "max@x.at", phone: "+43 1 234" }, { name: "Anna", role: "Inhaberin" }],
  }, newId);
  // Only notes keep their line breaks: every other field is one line, as the form shows it.
  assert.deepEqual(a.services, [{ id: "x1", kind: "Website", state: "in-arbeit", since: "2026-10-01", goLive: "", contractEnd: "", price: "49 €/Monat", note: "Zeile 1\nZeile 2" }]);
  assert.equal(a.systems.access, "1Password, Tresor Kunden");
  assert.deepEqual(a.systems.domain, { what: "krone.at", by: "c1" });
  assert.equal(a.systems.domainOwner, "Agentur");
  assert.deepEqual(a.systems.dns, { what: "Cloudflare", by: "c1" });
  // "betreut von" must name a contact of this business.
  assert.deepEqual(a.systems.hosting, { what: "", by: "" });
  assert.deepEqual(a.contacts.map((c) => [c.id, c.name, c.company]), [["c1", "Max Muster", "Webagentur X"], ["x2", "Anna", ""]]);
  assert.deepEqual(handledBy(a, "c1"), ["Domain", "DNS"]);
  // Each field has a cap, notes too.
  const long = normalizeAccount({ contacts: [{ name: "x".repeat(300), note: "y".repeat(3000) }] }, newId).contacts[0];
  assert.deepEqual([long.name.length, long.note.length], [200, 2000]);
});

test("unknown kinds, states, owners and dates are refused, not replaced; a service needs a kind, a contact a name and a valid email", () => {
  for (const service of [{ kind: "Homepage" }, { kind: "Website", state: "Live" }, { kind: "Website", since: "17.10.2026" }, { kind: "" }, {}]) rejects(() => normalizeAccount({ services: [service] }, newId), "services");
  for (const systems of [{ domainOwner: "bookete" }, { googleProfile: "?" }]) rejects(() => normalizeAccount({ systems }, newId), "systems");
  // Not given is not unknown: a service without a state is planned, an owner not given is unknown.
  const a = normalizeAccount({ services: [{ kind: "Website", state: "" }], systems: { domainOwner: "" } }, newId);
  assert.deepEqual([a.services[0].state, a.systems.domainOwner], ["geplant", "unbekannt"]);
  rejects(() => normalizeAccount({ contacts: [{ name: "" }] }, newId), "contacts");
  rejects(() => normalizeAccount({ contacts: [{ name: "Max", email: "kein-mail" }] }, newId), "contacts");
});

test("lists are capped, so one record stays small", () => {
  const many = Array.from({ length: ACCOUNT_LIMIT + 1 }, (_, i) => ({ name: `P${i}` }));
  rejects(() => normalizeAccount({ contacts: many }, newId), "contacts");
  rejects(() => normalizeAccount({ services: many.map(() => ({ kind: "bookete" })) }, newId), "services");
});

test("two entries with the same id are refused", () => {
  rejects(() => normalizeAccount({ contacts: [{ id: "c1", name: "A" }, { id: "c1", name: "B" }] }, newId), "contacts");
});

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };
function setup() {
  const store = createStore(createD1());
  let k = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++k}` }, actor: "jo@bookete.com (test)" });
  return { store, uc };
}
const mcp = async (context, name, args) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), context)).json()).result;
const agency = { name: "Max Muster", company: "Webagentur X", handles: "Domain, DNS", email: "max@x.at" };
/** A save by a writer that has just read the lead: `before` is the Kundenakte as stored ({} for none). */
const saveFresh = async ({ store, uc }, id, parts) => uc.saveAccount(id, parts, (await store.get("leads", id)).account ?? {});

test("the Kundenakte is saved on the lead: guarded, in its history, and only the parts given change", async () => {
  const s = setup();
  const { store, uc } = s;
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  await saveFresh(s, id, { services: [{ kind: "Website", state: "in-arbeit" }], contacts: [agency] });
  let a = (await store.get("leads", id)).account;
  assert.deepEqual([a.services[0].kind, a.contacts[0].company, a.systems.domainOwner], ["Website", "Webagentur X", "unbekannt"]);
  // Systems merge by field; lists replace the stored list.
  await saveFresh(s, id, { systems: { domain: { what: "krone.at", by: a.contacts[0].id }, dns: { what: "Cloudflare", by: a.contacts[0].id } } });
  await saveFresh(s, id, { systems: { domainOwner: "Agentur" } });
  a = (await store.get("leads", id)).account;
  assert.deepEqual([a.systems.domain, a.systems.domainOwner, a.systems.dns.by, a.services.length], [{ what: "krone.at", by: a.contacts[0].id }, "Agentur", a.contacts[0].id, 1]);
  // Each system too: naming the DNS provider keeps who runs it.
  await saveFresh(s, id, { systems: { dns: { what: "Hetzner" } } });
  a = (await store.get("leads", id)).account;
  assert.deepEqual(a.systems.dns, { what: "Hetzner", by: a.contacts[0].id });
  assert.equal(await saveFresh(s, id, { systems: { domainOwner: "Agentur" } }), false);
  const [last] = await store.history(id);
  assert.deepEqual(describeChange(last), ["Kundenakte ge\xE4ndert"]);
});

test("a form saved over a Kundenakte someone changed since it opened is refused, not merged", async () => {
  const s = setup();
  const { store, uc } = s;
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  await saveFresh(s, id, { contacts: [agency] });
  const opened = (await store.get("leads", id)).account;
  await saveFresh(s, id, { contacts: [...opened.contacts, { name: "Anna" }] });
  await assert.rejects(uc.saveAccount(id, { ...opened, contacts: [] }, opened), (e) => e instanceof ValidationError && e.field === "account");
  // A writer that names no Kundenakte read none: that is not this one.
  await assert.rejects(uc.saveAccount(id, { contacts: [] }), (e) => e instanceof ValidationError && e.field === "account");
  assert.equal((await store.get("leads", id)).account.contacts.length, 2);
  const now = (await store.get("leads", id)).account;
  assert.equal(await uc.saveAccount(id, { ...now, contacts: [] }, now), true);
});

test("the RPC saves only over the Kundenakte the form showed, and takes no save without it", async () => {
  const { store, uc } = setup();
  const [schema, handler] = COMMANDS.saveAccount;
  const rpc = async (args) => handler(uc, schema.parse(args));
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  assert.equal(await rpc({ id, account: { contacts: [agency] }, before: {} }), true);
  const shown = (await store.get("leads", id)).account;
  assert.equal(await rpc({ id, account: { systems: { domain: { what: "krone.at" } } }, before: shown }), true);
  // A form still showing the Kundenakte before that save is refused.
  await assert.rejects(rpc({ id, account: { contacts: [] }, before: shown }), (e) => e instanceof ValidationError && e.field === "account");
  await assert.rejects(rpc({ id, account: { contacts: [] } }), (e) => e.name === "ZodError");
  const a = (await store.get("leads", id)).account;
  assert.deepEqual([a.contacts.length, a.systems.domain.what], [1, "krone.at"]);
});

test("a write that leaves out the contact who runs a system is refused, unless it says who runs it now", async () => {
  const s = setup();
  const { store, uc } = s;
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  await saveFresh(s, id, { contacts: [agency] });
  const max = (await store.get("leads", id)).account.contacts[0];
  await saveFresh(s, id, { systems: { domain: { what: "krone.at", by: max.id }, dns: { what: "Cloudflare", by: max.id } } });
  // Max sent again without his id is a new contact, and the domain would lose who runs it.
  const refused = (system) => (e) => e instanceof ValidationError && e.field === "contacts" && e.message.startsWith(`Max Muster betreut ${system}`);
  await assert.rejects(saveFresh(s, id, { contacts: [agency] }), refused("Domain"));
  await assert.rejects(saveFresh(s, id, { contacts: [], systems: { domain: { by: "" } } }), refused("DNS"));
  // With his id he stays; said for each system he runs, he can go.
  assert.equal(await saveFresh(s, id, { contacts: [max] }), false);
  assert.equal(await saveFresh(s, id, { contacts: [], systems: { domain: { by: "" }, dns: { by: "" } } }), true);
  const a = (await store.get("leads", id)).account;
  assert.deepEqual([a.contacts, a.systems.domain, a.systems.dns], [[], { what: "krone.at", by: "" }, { what: "Cloudflare", by: "" }]);
});

test("the Kundenakte survives a backup, and lead edits leave it alone", async () => {
  const s = setup();
  const { store, uc } = s;
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  await saveFresh(s, id, { systems: { domain: { what: "krone.at" } } });
  await uc.updateLead(id, { notes: "x" });
  assert.equal((await store.get("leads", id)).account.systems.domain.what, "krone.at");
  const lead = { ...(await store.get("leads", id)), id: "B1" };
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [lead] } });
  assert.equal((await store.get("leads", "B1")).account.systems.domain.what, "krone.at");
  // A lead without one stays without one.
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ ...LEAD_FIELDS, id: "B2", name: "Post", schemaVersion: 3 }] } });
  assert.equal((await store.get("leads", "B2")).account, undefined);
});

test("RPC and MCP take the Kundenakte through one schema; no passwords field, no unknown keys", async () => {
  const { store, uc } = setup();
  const save = COMMANDS.saveAccount[0];
  assert.equal(save.safeParse({ id: "a", account: { systems: { domain: { what: "x.at", by: "c1" } } }, before: {} }).success, true);
  // The form always says what it showed, so nothing reaches the use case without it.
  assert.equal(save.safeParse({ id: "a", account: { systems: { domain: { what: "x.at" } } } }).success, false);
  assert.equal(save.safeParse({ id: "a", account: { systems: { password: "geheim" } }, before: {} }).success, false);
  assert.equal(save.safeParse({ id: "a", account: { contacts: [{ name: "A", pin: "1" }] }, before: {} }).success, false);
  assert.equal(save.safeParse({ id: "a", account: { contacts: Array.from({ length: ACCOUNT_LIMIT + 1 }, () => ({ name: "A" })) }, before: {} }).success, false);
  for (const account of [{ services: [{ kind: "Homepage" }] }, { services: [{ kind: "Website", since: "17.10.2026" }] }, { systems: { domainOwner: "bookete" } }, { systems: { domain: "x.at" } }]) assert.equal(save.safeParse({ id: "a", account, before: {} }).success, false, JSON.stringify(account));
  const context = { store, clock, uc };
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  // An agent names the Kundenakte it read; a lead without one has {}.
  assert.ok((await mcp(context, "update_account", { id, contacts: [agency] })).isError);
  const r = await mcp(context, "update_account", { id, before: {}, contacts: [agency], systems: { domainOwner: "Agentur" } });
  assert.ok(!r.isError, JSON.stringify(r));
  const read = async () => JSON.parse((await mcp(context, "get_lead", { id })).content[0].text).lead.account;
  const got = await read();
  assert.deepEqual([got.contacts[0].name, got.systems.domainOwner], ["Max Muster", "Agentur"]);
  // A web edit saved after the agent read is not overwritten.
  await uc.saveAccount(id, { contacts: [...got.contacts, { name: "Anna" }] }, got);
  const stale = await mcp(context, "update_account", { id, before: got, contacts: [{ name: "Y" }] });
  assert.ok(stale.isError && /inzwischen ge\xE4ndert/.test(stale.content[0].text), JSON.stringify(stale));
  assert.deepEqual((await read()).contacts.map((c) => c.name), ["Max Muster", "Anna"]);
});

test("agents see the allowed values and that before is required", async () => {
  const { result } = await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), {})).json();
  const schema = JSON.stringify(result.tools.find((t) => t.name === "update_account").inputSchema);
  for (const value of ["Google-Profil", "in-arbeit", "Agentur", "unbekannt"]) assert.ok(schema.includes(`"${value}"`), value);
  assert.ok(result.tools.find((t) => t.name === "update_account").inputSchema.required.includes("before"));
});

test("a Kundenakte stored before a part was added still compares, shows and saves", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", status: "kontaktiert", contactedAt: "2026-10-01" });
  const { pos: _pos, ...olderSystems } = EMPTY_ACCOUNT.systems;
  const older = { ...EMPTY_ACCOUNT, systems: olderSystems };
  await store.commit([{ type: "patch", collection: "leads", id, base: await store.get("leads", id), data: { account: older } }], "test");
  assert.equal(showsAccount(await store.get("leads", id)), false);
  // As an agent read it (stored shape) and as the form showed it (today's shape).
  assert.equal(await uc.saveAccount(id, { systems: { domain: { what: "krone.at" } } }, older), true);
  const shown = accountOf(await store.get("leads", id));
  assert.equal(await uc.saveAccount(id, { systems: { pos: { what: "Gastrofix" } } }, shown), true);
  assert.deepEqual((await store.get("leads", id)).account.systems.pos, { what: "Gastrofix", by: "" });
});

test("the lead page shows the Kundenakte for Qualifiziert and Kunde, or once it holds anything", () => {
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-01" };
  assert.equal(showsAccount(lead), false);
  assert.equal(showsAccount({ ...lead, status: "qualifiziert" }), true);
  assert.equal(showsAccount({ ...lead, account: normalizeAccount({ systems: { domain: { what: "krone.at" } } }, newId) }), true);
  const account = normalizeAccount({ services: [{ kind: "Website", state: "live", price: "49 \u20AC/Monat", contractEnd: "2026-12-31", note: "Zeile 1\nZeile 2" }], systems: { domain: { what: "krone.at", by: "c1" }, domainOwner: "Agentur", registrar: "World4You", dns: { what: "Cloudflare", by: "c1" }, access: "1Password" }, contacts: [{ id: "c1", ...agency, phone: "+43 1 234", note: "erreichbar\nab 9" }, { id: "c2", name: "<b>Anna</b>" }] }, newId);
  const state = initialState();
  state.data = { leads: [{ ...lead, status: "kunde", account }], activities: [], templates: [], settings: [] };
  state.status = { ...state.status, leads: true, activities: true };
  state.ui = { ...state.ui, view: "detail", leadId: "L1" };
  const html = detailView(state, "2026-10-15");
  for (const text of ["Kundenakte", "Website", "Live", "49 \u20AC/Monat", "Vertrag bis 31. Dez. 2026", "krone.at \xB7 geh\xF6rt: Agentur \xB7 World4You \xB7 betreut von Max Muster", "Cloudflare \xB7 betreut von Max Muster", "Webagentur X", 'href="tel:+431234"', 'href="mailto:max@x.at"', "1Password", "&lt;b&gt;Anna&lt;/b&gt;"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes("<b>Anna"));
  assert.ok(detailView({ ...state, data: { ...state.data, leads: [lead] } }, "2026-10-15").indexOf("Kundenakte") === -1);
  state.ui.view = "editAccount";
  const form = accountEditView(state);
  assert.match(form, /keine Passw\xF6rter/);
  assert.match(form, /name="contacts\.0\.name" type="text" value="Max Muster"/);
  // The domain has its "betreut von" like every system.
  assert.match(form, /<select name="systems\.domain\.by"><option value="">\u2013<\/option><option value="c1" selected>Max Muster<\/option>/);
  assert.ok(!form.includes("<b>Anna"));
  // Notes are text areas, so saving the form untouched keeps their line breaks.
  assert.match(form, /<textarea name="services\.0\.note" rows="3">Zeile 1\nZeile 2<\/textarea>/);
  assert.match(form, /<textarea name="contacts\.0\.note" rows="3">erreichbar\nab 9<\/textarea>/);
  // One empty row each, to add to.
  assert.match(form, /name="services\.1\.kind"/);
  assert.match(form, /name="contacts\.2\.name" type="text" value=""/);
});

test("the Kundenakte form has its own address and reads back as the account it shows", () => {
  assert.equal(routeOf({ view: "editAccount", leadId: "L1" }), "#/betrieb/L1/kunde");
  assert.deepEqual(parseRoute("#/betrieb/L1/kunde"), { view: "editAccount", leadId: "L1" });
  const el = (name, value, extra = {}) => ({ name, value, ...extra });
  const input = accountInput([
    el("services.0.id", "s1"), el("services.0.kind", "Website"), el("services.0.state", "live"), el("services.0.price", ""), el("services.0.drop", "1", { type: "checkbox", checked: false }),
    el("services.1.id", ""), el("services.1.kind", ""), el("services.1.state", ""), el("services.1.price", ""), el("services.1.drop", "1", { type: "checkbox", checked: false }),
    el("contacts.0.id", "c1"), el("contacts.0.name", "Max"), el("contacts.0.drop", "1", { type: "checkbox", checked: true }),
    el("contacts.1.id", ""), el("contacts.1.name", ""), el("contacts.1.email", ""),
    el("systems.domain.what", "krone.at"), el("systems.domainOwner", "Agentur"), el("systems.dns.what", "Cloudflare"), el("systems.dns.by", ""),
  ]);
  // The untouched empty row and the row marked to remove are left out.
  assert.deepEqual(input.services, [{ id: "s1", kind: "Website", state: "live", price: "" }]);
  assert.deepEqual(input.contacts, []);
  assert.deepEqual(input.systems, { domain: { what: "krone.at" }, domainOwner: "Agentur", dns: { what: "Cloudflare", by: "" } });
});
