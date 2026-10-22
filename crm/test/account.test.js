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

test("systems and contacts are trimmed, checked and get ids", () => {
  n = 0;
  const a = normalizeAccount({
    systems: { domain: { what: " krone.at, gehört dem Kunden ", by: "c1" }, dns: { what: "Cloudflare", by: "c1" }, website: { what: "", by: "gibt-es-nicht" }, access: "1Password,\r\nTresor Kunden" },
    contacts: [{ id: "c1", name: " Max Muster ", company: "Webagentur\nX", role: "Agentur", handles: "Domain, DNS", email: "max@x.at", phone: "+43 1 234" }, { name: "Anna", role: "Inhaberin" }],
  }, newId);
  // Only notes keep their line breaks: every other field is one line, as the form shows it.
  assert.equal(a.systems.access, "1Password, Tresor Kunden");
  assert.deepEqual(a.systems.domain, { what: "krone.at, gehört dem Kunden", by: "c1" });
  assert.deepEqual(a.systems.dns, { what: "Cloudflare", by: "c1" });
  // "betreut von" must name a contact of this business.
  assert.deepEqual(a.systems.website, { what: "", by: "" });
  assert.deepEqual(a.contacts.map((c) => [c.id, c.name, c.company]), [["c1", "Max Muster", "Webagentur X"], ["x1", "Anna", ""]]);
  assert.deepEqual(handledBy(a, "c1"), ["Domain", "DNS"]);
  // Each field has a cap, notes too.
  const long = normalizeAccount({ contacts: [{ name: "x".repeat(300), note: "y".repeat(3000) }] }, newId).contacts[0];
  assert.deepEqual([long.name.length, long.note.length], [200, 2000]);
});

test("a contact needs a name and a valid email", () => {
  rejects(() => normalizeAccount({ contacts: [{ name: "" }] }, newId), "contacts");
  rejects(() => normalizeAccount({ contacts: [{ name: "Max", email: "kein-mail" }] }, newId), "contacts");
});

test("a Kundenakte stored before 1.27.0 reads without what that release dropped", () => {
  const stored = {
    services: [{ id: "s1", kind: "Website", state: "live", note: "in die Notizen übernommen" }],
    systems: { domain: { what: "krone.at", by: "" }, hosting: { what: "Hetzner", by: "" }, pos: { what: "Gastrofix", by: "" }, domainOwner: "Agentur", registrar: "World4You", googleProfile: "Kunde", access: "" },
    contacts: [],
  };
  assert.deepEqual(normalizeAccount(stored, newId), { ...EMPTY_ACCOUNT, systems: { ...EMPTY_ACCOUNT.systems, domain: { what: "krone.at", by: "" } } });
});

test("lists are capped, so one record stays small", () => {
  const many = Array.from({ length: ACCOUNT_LIMIT + 1 }, (_, i) => ({ name: `P${i}` }));
  rejects(() => normalizeAccount({ contacts: many }, newId), "contacts");
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
  await saveFresh(s, id, { contacts: [agency] });
  let a = (await store.get("leads", id)).account;
  assert.deepEqual([a.contacts[0].company, a.systems.access], ["Webagentur X", ""]);
  // Systems merge by field; the contacts replace the stored list only when given.
  await saveFresh(s, id, { systems: { domain: { what: "krone.at", by: a.contacts[0].id }, dns: { what: "Cloudflare", by: a.contacts[0].id } } });
  await saveFresh(s, id, { systems: { access: "1Password" } });
  a = (await store.get("leads", id)).account;
  assert.deepEqual([a.systems.domain, a.systems.access, a.systems.dns.by, a.contacts.length], [{ what: "krone.at", by: a.contacts[0].id }, "1Password", a.contacts[0].id, 1]);
  // Each system too: naming the DNS provider keeps who runs it.
  await saveFresh(s, id, { systems: { dns: { what: "Hetzner" } } });
  a = (await store.get("leads", id)).account;
  assert.deepEqual(a.systems.dns, { what: "Hetzner", by: a.contacts[0].id });
  assert.equal(await saveFresh(s, id, { systems: { access: "1Password" } }), false);
  const [last] = await store.history(id);
  assert.deepEqual(describeChange(last), ["Kundenakte ge\xE4ndert"]);
});

test("the business's own contact stays in the lead's fields: a Kundenakte contact with its address or number is refused", async () => {
  const s = setup();
  const { store, uc } = s;
  const id = await uc.addLead({ name: "Luderbauer", status: "kunde", person: "Familie Schwarz", email: "gasthaus@luderbauer.at", phone: "+43 316 253410" });
  for (const own of [{ name: "Familie Schwarz", email: "Gasthaus@Luderbauer.at" }, { name: "Familie Schwarz", phone: "+43 316 25 34 10" }, { name: "Familie Schwarz", phone: "0316 253410" }]) {
    await assert.rejects(saveFresh(s, id, { contacts: [agency, own] }), (e) => e instanceof ValidationError && e.field === "contacts" && /Familie Schwarz/.test(e.message));
  }
  assert.equal((await store.get("leads", id)).account, undefined);
  assert.equal(await saveFresh(s, id, { contacts: [agency] }), true);
  // A contact already stored never blocks the save: the lead's phone may come to match it later, or it is from before.
  const [stored] = (await store.get("leads", id)).account.contacts;
  await uc.updateLead(id, { email: "max@x.at" });
  assert.equal(await saveFresh(s, id, { systems: { domain: { what: "luderbauer.at", by: stored.id } } }), true);
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
  // What 1.27.0 dropped is refused, not ignored, so a writer learns it is gone.
  for (const account of [{ services: [{ kind: "Website" }] }, { systems: { domainOwner: "Agentur" } }, { systems: { hosting: { what: "Hetzner" } } }, { systems: { domain: "x.at" } }]) assert.equal(save.safeParse({ id: "a", account, before: {} }).success, false, JSON.stringify(account));
  const context = { store, clock, uc };
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  // An agent names the Kundenakte it read; a lead without one has {}.
  assert.ok((await mcp(context, "update_account", { id, contacts: [agency] })).isError);
  const r = await mcp(context, "update_account", { id, before: {}, contacts: [agency], systems: { access: "1Password" } });
  assert.ok(!r.isError, JSON.stringify(r));
  const read = async () => JSON.parse((await mcp(context, "get_lead", { id })).content[0].text).lead.account;
  const got = await read();
  assert.deepEqual([got.contacts[0].name, got.systems.access], ["Max Muster", "1Password"]);
  // A web edit saved after the agent read is not overwritten.
  await uc.saveAccount(id, { contacts: [...got.contacts, { name: "Anna" }] }, got);
  const stale = await mcp(context, "update_account", { id, before: got, contacts: [{ name: "Y" }] });
  assert.ok(stale.isError && /inzwischen ge\xE4ndert/.test(stale.content[0].text), JSON.stringify(stale));
  assert.deepEqual((await read()).contacts.map((c) => c.name), ["Max Muster", "Anna"]);
});

test("agents see the systems they can write and that before is required", async () => {
  const { result } = await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), {})).json();
  const schema = JSON.stringify(result.tools.find((t) => t.name === "update_account").inputSchema);
  for (const key of ["domain", "dns", "website", "email", "access"]) assert.ok(schema.includes(`"${key}"`), key);
  for (const key of ["services", "hosting", "pos", "domainOwner"]) assert.ok(!schema.includes(`"${key}"`), key);
  assert.ok(result.tools.find((t) => t.name === "update_account").inputSchema.required.includes("before"));
});

test("a Kundenakte stored before 1.27.0 compares, shows and saves in today's shape, and an agent reads it so", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", status: "kontaktiert", contactedAt: "2026-10-01" });
  const older = { services: [{ id: "s1", kind: "Website", state: "live" }], systems: { ...EMPTY_ACCOUNT.systems, hosting: { what: "Hetzner", by: "" }, pos: { what: "", by: "" }, domainOwner: "unbekannt", registrar: "", googleProfile: "unbekannt" }, contacts: [] };
  await store.commit([{ type: "patch", collection: "leads", id, base: await store.get("leads", id), data: { account: older } }], "test");
  // What it holds besides is gone from view, so a Kontaktiert lead shows none.
  assert.equal(showsAccount(await store.get("leads", id)), false);
  // An agent reads it in today's shape, and that goes back to update_account as `before`.
  const read = JSON.parse((await mcp({ store, clock, uc }, "get_lead", { id })).content[0].text).lead.account;
  assert.deepEqual(read, EMPTY_ACCOUNT);
  const r = await mcp({ store, clock, uc }, "update_account", { id, before: read, systems: { domain: { what: "krone.at" } } });
  assert.ok(!r.isError, JSON.stringify(r));
  // The save writes today's shape; the history keeps the one before.
  assert.deepEqual((await store.get("leads", id)).account, { ...EMPTY_ACCOUNT, systems: { ...EMPTY_ACCOUNT.systems, domain: { what: "krone.at", by: "" } } });
  // A `before` still in the old shape compares as today's: the same Kundenakte, so nothing to save.
  assert.equal(await uc.saveAccount(id, { systems: { domain: { what: "krone.at" } } }, { ...older, systems: { ...older.systems, domain: { what: "krone.at", by: "" } } }), false);
});

test("the lead page shows the Kundenakte for Qualifiziert and Kunde, or once it holds anything", () => {
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-01" };
  assert.equal(showsAccount(lead), false);
  assert.equal(showsAccount({ ...lead, status: "qualifiziert" }), true);
  assert.equal(showsAccount({ ...lead, account: normalizeAccount({ systems: { domain: { what: "krone.at" } } }, newId) }), true);
  const account = normalizeAccount({ systems: { domain: { what: "krone.at, geh\xF6rt der Agentur, bei World4You", by: "c1" }, dns: { what: "Cloudflare", by: "c1" }, access: "1Password" }, contacts: [{ id: "c1", ...agency, phone: "+43 1 234", note: "erreichbar\nab 9" }, { id: "c2", name: "<b>Anna</b>" }] }, newId);
  const state = initialState();
  state.data = { leads: [{ ...lead, status: "kunde", account }], activities: [], templates: [], settings: [] };
  state.status = { ...state.status, leads: true, activities: true };
  state.ui = { ...state.ui, view: "detail", leadId: "L1" };
  const html = detailView(state, "2026-10-15");
  for (const text of ["Kundenakte", "krone.at, geh\xF6rt der Agentur, bei World4You \xB7 betreut von Max Muster", "Cloudflare \xB7 betreut von Max Muster", "Webagentur X", 'href="tel:+431234"', 'href="mailto:max@x.at"', "1Password", "&lt;b&gt;Anna&lt;/b&gt;"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes("<b>Anna"));
  assert.ok(!/Leistung|Kassensystem|Google-Profil verwaltet/.test(html));
  // The systems are open where something is written down.
  assert.match(html, /<details open><summary><h4>Systeme<\/h4><\/summary>/);
  assert.ok(detailView({ ...state, data: { ...state.data, leads: [lead] } }, "2026-10-15").indexOf("Kundenakte") === -1);
  state.ui.view = "editAccount";
  const form = accountEditView(state);
  assert.match(form, /keine Passw\xF6rter/);
  assert.match(form, /name="contacts\.0\.name" type="text" value="Max Muster"/);
  // The domain has its "betreut von" like every system.
  assert.match(form, /<select name="systems\.domain\.by"><option value="">\u2013<\/option><option value="betrieb">Betrieb selbst<\/option><option value="c1" selected>Max Muster<\/option>/);
  assert.deepEqual([...form.matchAll(/name="systems\.(\w+)\.what"/g)].map(([, k]) => k), ["domain", "dns", "website", "email"]);
  assert.ok(!/services\.|domainOwner|registrar|googleProfile/.test(form));
  assert.ok(!form.includes("<b>Anna"));
  // Notes are text areas, so saving the form untouched keeps their line breaks.
  assert.match(form, /<textarea name="contacts\.0\.note" rows="3">erreichbar\nab 9<\/textarea>/);
  // One empty row, to add to.
  assert.match(form, /name="contacts\.2\.name" type="text" value=""/);
});

test("the systems open shut for a customer on bookete alone with none written down, open for a website", () => {
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kunde", contactedAt: "2026-10-01", customer: { phase: "onboarding", since: "2026-10-15" } };
  const view = (l, v = "detail") => {
    const state = initialState();
    state.data = { leads: [l], activities: [], templates: [], settings: [] };
    state.status = { ...state.status, leads: true, activities: true };
    state.ui = { ...state.ui, view: v, leadId: "L1" };
    return v === "detail" ? detailView(state, "2026-10-15") : accountEditView(state);
  };
  const open = (html) => /<details[^>]*? open><summary><h[34]>Systeme/.test(html);
  assert.deepEqual([open(view(lead)), open(view(lead, "editAccount"))], [false, false]);
  const website = { ...lead, customer: { ...lead.customer, package: "website" } };
  assert.deepEqual([open(view(website)), open(view(website, "editAccount"))], [true, true]);
  const written = { ...lead, account: normalizeAccount({ systems: { email: { what: "office@krone.at bei A1" } } }, newId) };
  assert.deepEqual([open(view(written)), open(view(written, "editAccount"))], [true, true]);
  // Only who runs a system is written down: that counts too.
  const runBy = { ...lead, account: normalizeAccount({ systems: { dns: { by: "c1" } }, contacts: [{ id: "c1", name: "Max" }] }, newId) };
  assert.equal(open(view(runBy)), true);
  // A lead that is no customer yet shows them open.
  assert.equal(open(view({ ...lead, status: "qualifiziert", customer: undefined })), true);
});

test("the Kundenakte form has its own address and reads back as the account it shows", () => {
  assert.equal(routeOf({ view: "editAccount", leadId: "L1" }), "#/betrieb/L1/kunde");
  assert.deepEqual(parseRoute("#/betrieb/L1/kunde"), { view: "editAccount", leadId: "L1" });
  const el = (name, value, extra = {}) => ({ name, value, ...extra });
  const input = accountInput([
    el("contacts.0.id", "c1"), el("contacts.0.name", "Max"), el("contacts.0.drop", "1", { type: "checkbox", checked: false }),
    el("contacts.1.id", "c2"), el("contacts.1.name", "Anna"), el("contacts.1.drop", "1", { type: "checkbox", checked: true }),
    el("contacts.2.id", ""), el("contacts.2.name", ""), el("contacts.2.email", ""),
    el("systems.domain.what", "krone.at"), el("systems.access", "1Password"), el("systems.dns.what", "Cloudflare"), el("systems.dns.by", ""),
  ]);
  // The untouched empty row and the row marked to remove are left out.
  assert.deepEqual(input.contacts, [{ id: "c1", name: "Max" }]);
  assert.deepEqual(input.systems, { domain: { what: "krone.at" }, access: "1Password", dns: { what: "Cloudflare", by: "" } });
});

test("\"betreut von\" can be the business itself: kept without a contact, shown as Betrieb selbst", async () => {
  const s = setup();
  const { store, uc } = s;
  const id = await uc.addLead({ name: "Krone", status: "kunde" });
  assert.equal(await saveFresh(s, id, { systems: { domain: { what: "krone.at, bei World4You", by: "betrieb" } } }), true);
  // A contact list sent without it leaves the business running its domain.
  assert.equal(await saveFresh(s, id, { contacts: [agency] }), true);
  const l = await store.get("leads", id);
  assert.equal(l.account.systems.domain.by, "betrieb");
  const state = initialState();
  state.data = { leads: [l], activities: [], templates: [], settings: [] };
  state.status = { ...state.status, leads: true, activities: true };
  state.ui = { ...state.ui, view: "detail", leadId: id };
  assert.ok(detailView(state, "2026-10-15").includes("krone.at, bei World4You \xB7 betreut von Betrieb selbst"));
});

test("no contact takes the id \"betrieb\", which names the business itself", () => {
  const a = normalizeAccount({ systems: { domain: { by: "betrieb" } }, contacts: [{ id: "betrieb", name: "Agentur" }] }, () => "c9");
  assert.deepEqual([a.contacts[0].id, a.systems.domain.by], ["c9", "betrieb"]);
});
