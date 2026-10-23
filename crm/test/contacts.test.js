import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { ValidationError } from "../src/domain/errors.js";
import { BACKUP_FORMAT } from "../src/domain/backup.js";
import { LEAD_FIELDS, normalizeLead, getsUnsubscribeLink, upgradeLead, addressOpen } from "../src/domain/lead.js";
import { weekNumbers } from "../src/domain/stats.js";
import { searchLeads } from "../src/domain/search.js";
import { initialState } from "../src/web/store.js";
import { kontakteView, leadsView, filterBar, detailView, leadEditView, accountEditView, searchResultsHtml, TABS } from "../src/web/views.js";
import { peopleList, callList, todayQueue, toolCounts } from "../src/web/selectors.js";
import { routeOf, parseRoute, backRoute } from "../src/web/controller.js";

const TODAY = "2026-10-23";
// Each write a moment later, so the newest entry is the one logged last.
let tick = 0;
const clock = { today: () => TODAY, now: () => `${TODAY}T10:${String(++tick).padStart(2, "0")}:00.000Z` };
function setup() {
  const store = createStore(createD1());
  let k = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++k}` }, actor: "jo@bookete.com (test)", email: "jo@bookete.com", team: ["jo@bookete.com"] });
  return { store, uc };
}
const rejects = (promise, field) => assert.rejects(promise, (e) => e instanceof ValidationError && e.field === field);
const mcp = async (context, name, args) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), context)).json()).result;
// A Kontakt as stored: its fields through the rules, its Kundenakte beside them.
const kontakt = ({ account, ...fields }) => ({ ...normalizeLead({ kind: "kontakt", ...fields }, { ...LEAD_FIELDS, kind: "kontakt" }, TODAY), ...(account && { account }) });

test("a Kontakt has a name, a Thema and the reach fields, and none of a restaurant's parts", () => {
  const k = kontakt({ name: "Blue Bomb", topic: "  Partnerprogramm ", person: "Philipp", website: "bluebomb.at", city: "Graz" });
  assert.deepEqual([k.kind, k.topic, k.website, k.city], ["kontakt", "Partnerprogramm", "https://bluebomb.at", "Graz"]);
  assert.deepEqual([k.status, k.lostReason, k.optOutAt, k.contactedAt, k.wonAt, k.fit, k.type, k.currentTool, k.hook], [null, null, null, null, null, null, "", "", ""]);
  // A status, a reason, an opt-out or a restaurant's field given to a Kontakt is refused, not dropped.
  for (const [field, value] of [["status", "kunde"], ["lostReason", "Kein Bedarf"], ["contactedAt", TODAY], ["optOutAt", TODAY], ["fit", 3], ["currentTool", "aleno"], ["hook", "x"], ["type", "Bar"]]) {
    assert.throws(() => normalizeLead({ [field]: value }, k, TODAY), (e) => e instanceof ValidationError && e.field === field, field);
  }
  // A follow-up on any day: a Kontakt is never Neu.
  assert.equal(normalizeLead({ followUp: "2026-11-02" }, k, TODAY).followUp, "2026-11-02");
  // The kind never changes, either way; a Betrieb has no Thema, and stores neither kind nor topic.
  assert.throws(() => normalizeLead({ kind: "betrieb" }, k, TODAY), (e) => e.field === "kind");
  const b = normalizeLead({ name: "Krone" }, LEAD_FIELDS, TODAY);
  assert.throws(() => normalizeLead({ kind: "kontakt" }, b, TODAY), (e) => e.field === "kind");
  assert.throws(() => normalizeLead({ topic: "Skal" }, b, TODAY), (e) => e.field === "topic");
  assert.equal("kind" in b || "topic" in b, false);
  // Mail to a Kontakt is no marketing, and it has no status to upgrade.
  assert.equal(getsUnsubscribeLink(k), false);
  assert.equal(upgradeLead(k), k);
});

test("a Kontakt is made through the one write path and keeps notes, todos, people and a follow-up; status moves are refused", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ kind: "kontakt", name: "Martin Satke", topic: "Skal Steiermark", city: "Salzburg", notes: "Skal in der Steiermark wiederbeleben?" });
  const k = await store.get("leads", id);
  assert.deepEqual([k.kind, k.topic, k.status, k.contactedAt], ["kontakt", "Skal Steiermark", null, null]);
  assert.equal(k.noteEntries[0].text, "Skal in der Steiermark wiederbeleben?");
  await uc.setFollowUp(id, "2026-11-02");
  await uc.setNextStep(id, "Treffen ausmachen");
  await uc.changeTodo(id, { add: "Unterlagen schicken" });
  await uc.saveAccount(id, { contacts: [{ name: "Florian", role: "Partner" }] }, {});
  const after = await store.get("leads", id);
  assert.deepEqual([after.followUp, after.nextStep, after.todos[0].text, after.account.contacts[0].name], ["2026-11-02", "Treffen ausmachen", "Unterlagen schicken", "Florian"]);
  await rejects(uc.changeStatus(id, "kontaktiert"), "status");
  await rejects(uc.closeWithoutReply(id), "status");
  await rejects(uc.optOut(id), "status");
  await rejects(uc.logCall(id, { outcome: "rueckruf", date: "2026-11-02" }), "outcome");
  await rejects(uc.scheduleMeeting(id, { date: "2026-11-02" }), "status");
  await rejects(uc.changeOrder(id, { add: { kind: "website" } }), "status");
  await rejects(uc.updateLead(id, { kind: "betrieb" }), "kind");
  assert.equal((await store.activitiesOf(id)).length, 0);
});

test("a talk or a mail logged on a Kontakt changes nothing on it: its plan stays, and a message from them shows in Heute until ours", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ kind: "kontakt", name: "Blue Bomb", topic: "Partnerprogramm", email: "philipp@bluebomb.at" });
  await uc.setFollowUp(id, "2026-11-02");
  await uc.setNextStep(id, "Vertrag schicken");
  await uc.logActivity(id, { direction: "out", channel: "Telefon", text: "Partnerprogramm besprochen" });
  const plan = async () => {
    const k = await store.get("leads", id);
    return [k.contactedAt, k.status, k.followUp, k.nextStep];
  };
  assert.deepEqual(await plan(), [null, null, "2026-11-02", "Vertrag schicken"]);
  // Their mail, found by the sync after someone wrote the Kontakt (a note): the plan stays, Heute lists the answer.
  const at = clock.now();
  await uc.changeNote(id, { add: "Angebot kommt per Mail" });
  await uc.recordMail(id, { direction: "in", date: TODAY, at, text: "Hier unser Angebot", mail: { gmailId: "g1", threadId: "t1", mailbox: "jo@bookete.com", subject: "Angebot", from: "philipp@bluebomb.at", to: "jo@bookete.com", messageId: "<m1>" } });
  assert.deepEqual(await plan(), [null, null, "2026-11-02", "Vertrag schicken"]);
  const heute = async () => {
    const state = stateWith([await store.get("leads", id)]);
    state.data.activities = await store.activitiesOf(id);
    return todayQueue(state, TODAY).replies.map((l) => l.id);
  };
  assert.deepEqual(await heute(), [id]);
  await uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Danke, wir schauen es an" });
  assert.deepEqual(await plan(), [null, null, "2026-11-02", "Vertrag schicken"]);
  assert.deepEqual(await heute(), []);
});

test("an address someone opted out at stays closed on a Kontakt, though its mail carries no Abmeldelink", async () => {
  const { store, uc } = setup();
  const linde = await uc.addLead({ name: "Linde", email: "office@linde.at" });
  await uc.optOut(linde);
  const id = await uc.addLead({ kind: "kontakt", name: "Linde Catering", topic: "Partnerprogramm", email: "OFFICE@linde.at " });
  await rejects(uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Angebot" }), "email");
  const k = await store.get("leads", id);
  assert.equal(addressOpen(k, new Set(["office@linde.at"])), false);
  assert.equal(getsUnsubscribeLink(k), false);
  // A message from them is logged all the same.
  assert.ok(await uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Hallo" }));
  // On its page, a person at it with that address gets no mail link, as on a lead, while its own other address has one.
  const page = detailView(stateWith([await store.get("leads", linde), { ...k, email: "info@linde-catering.at", account: { contacts: [{ id: "c1", name: "Eva", email: "office@linde.at" }] } }], { view: "detail", leadId: id }), TODAY);
  assert.match(page, /<b>Eva<\/b><br>office@linde.at/);
  assert.doesNotMatch(page, /mailto:office@linde.at/);
});

test("a Kontakt's Kundenakte holds its people only", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ kind: "kontakt", name: "Blue Bomb" });
  await rejects(uc.saveAccount(id, { systems: { website: { what: "WordPress" } } }, {}), "systems");
  await rejects(uc.saveAccount(id, { systems: { access: "1Password" } }, {}), "systems");
  // The web form's empty systems are no systems.
  assert.equal(await uc.saveAccount(id, { contacts: [{ name: "Florian" }], systems: {} }, {}), true);
  assert.deepEqual((await store.get("leads", id)).account.contacts.map((c) => c.name), ["Florian"]);
});

test("a backup brings a Kontakt back as one; the RPC and MCP take kind and topic through one schema", async () => {
  const { store, uc } = setup();
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ id: "K1", kind: "kontakt", name: "Skal Salzburg", topic: "Skal Steiermark", status: null, fit: null, type: "", currentTool: "", hook: "", schemaVersion: 3 }] } });
  assert.deepEqual(await store.get("leads", "K1").then((k) => [k.kind, k.topic, k.status]), ["kontakt", "Skal Steiermark", null]);
  const [schema] = COMMANDS.addLead;
  assert.equal(schema.safeParse({ input: { name: "X", kind: "kontakt", topic: "Tischrunde" } }).success, true);
  assert.equal(schema.safeParse({ input: { name: "X", kind: "partner" } }).success, false);
  // A Thema is one line of at most 60 characters: a longer one is refused, not cut.
  assert.equal(schema.safeParse({ input: { name: "X", kind: "kontakt", topic: "x".repeat(61) } }).success, false);
  const context = { store, clock, uc };
  const made = JSON.parse((await mcp(context, "create_lead", { name: "Blue Bomb", kind: "kontakt", topic: "Partnerprogramm" })).content[0].text);
  await uc.addLead({ name: "Krone" });
  const found = JSON.parse((await mcp(context, "search_leads", { kind: "kontakt" })).content[0].text);
  assert.deepEqual(found.leads.map((l) => [l.name, l.kind, l.topic]), [["Blue Bomb", "kontakt", "Partnerprogramm"], ["Skal Salzburg", "kontakt", "Skal Steiermark"]]);
  assert.deepEqual(JSON.parse((await mcp(context, "search_leads", { kind: "betrieb" })).content[0].text).leads.map((l) => l.name), ["Krone"]);
  assert.ok((await mcp(context, "log_call", { id: made.id, outcome: "nicht-erreicht" })).isError);
  assert.ok((await mcp(context, "change_status", { id: made.id, status: "kontaktiert" })).isError);
});

test("a talk with a Kontakt is no sales call; search finds a Kontakt by its Thema and anyone by the people at a record", () => {
  const leads = [kontakt({ id: "K1", name: "Blue Bomb", topic: "Partnerprogramm", account: { contacts: [{ id: "c1", name: "Florian Huber", role: "Partner" }] } }), { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert", account: { contacts: [{ id: "c2", name: "Pixel Webagentur" }] } }];
  leads[0].id = "K1";
  const call = (leadId) => ({ leadId, direction: "out", channel: "Telefon", date: TODAY, outcome: null, createdAt: TODAY + "T10:00:00.000Z" });
  assert.equal(weekNumbers(leads, [call("K1"), call("L1")], TODAY).calls, 1);
  const state = { data: { leads, activities: [] } };
  assert.deepEqual(searchLeads(state, "partnerprog").map((r) => r.lead.id), ["K1"]);
  assert.deepEqual(searchLeads(state, "florian").map((r) => [r.lead.id, r.hit?.key]), [["K1", "contacts"]]);
  assert.deepEqual(searchLeads(state, "pixel").map((r) => r.lead.id), ["L1"]);
});

function stateWith(leads, ui = {}) {
  const state = initialState();
  state.data = { leads, activities: [], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.caps = { db: true, gmail: false };
  state.ui = { ...state.ui, ...ui };
  return state;
}
const LEADS = () => {
  const blue = { ...kontakt({ name: "Blue Bomb", topic: "Partnerprogramm", person: "Philipp", phone: "0664 1", account: { contacts: [{ id: "c1", name: "Florian", role: "Partner" }] } }), id: "K1" };
  const skal = { ...kontakt({ name: "Martin Satke", topic: "Skal Steiermark", followUp: TODAY, nextStep: "Anrufen" }), id: "K2" };
  return [blue, skal,
    { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kunde", person: "Anna Wirt", phone: "0316 1", account: { contacts: [{ id: "c2", name: "Pixel", company: "Webagentur", role: "Agentur" }] } },
    { ...LEAD_FIELDS, id: "L2", name: "Linde", status: "neu", phone: "0316 2", email: "office@linde.at" }];
};

test("Kontakte lists everyone where they live: the Kontakte and their people, a Betrieb's person and its other contacts", () => {
  const rows = (state) => [...kontakteView(state, TODAY).matchAll(/data-open="(\w+)"><span class="q-name">([^<]*)<\/span><span class="q-ch">(\w+)<\/span><span class="q-why">([^<]*)</g)].map(([, id, name, kind, line]) => [id, name, kind, line]);
  assert.deepEqual(rows(stateWith(LEADS())), [
    ["L1", "Anna Wirt", "Betrieb", "Krone \xB7 Kunde"],
    ["K1", "Blue Bomb", "Kontakt", "Partnerprogramm \xB7 Philipp"],
    ["K1", "Florian", "Kontakt", "Partner \xB7 Blue Bomb"],
    ["K2", "Martin Satke", "Kontakt", "Skal Steiermark"],
    ["L1", "Pixel", "Betrieb", "Agentur \xB7 Webagentur \xB7 bei Krone"],
  ]);
  assert.deepEqual(rows(stateWith(LEADS(), { cKind: "kontakt", cTopic: "Partnerprogramm" })).map((r) => r[1]), ["Blue Bomb", "Florian"]);
  assert.deepEqual(rows(stateWith(LEADS(), { cq: "agentur" })).map((r) => r[1]), ["Pixel"]);
  // A Betrieb with an address but no person named lists nobody.
  assert.equal(peopleList(stateWith(LEADS())).some((r) => r.lead.id === "L2"), false);
  assert.ok(TABS.some(([k]) => k === "kontakte"));
});

test("a Kontakt stays out of Leads, its filter counts and the call list, and shows in Heute when due", () => {
  const state = stateWith(LEADS(), { status: "alle" });
  const leads = leadsView(state, TODAY);
  assert.doesNotMatch(leads, /Blue Bomb|Martin Satke/);
  // Leads counts what it lists: the two restaurants, in every filter.
  assert.match(leads, /Alle Regionen \(2\)[^]*>Sonstige \(2\)<[^]*Alle Systeme \(2\)[^]*Alle Kontakte \(2\)[^]*mit Telefon \(2\)/);
  assert.deepEqual(callList(state, TODAY).map((l) => l.id), ["L2"]);
  assert.deepEqual(todayQueue(state, TODAY).today.map((l) => l.id), ["K2"]);
  // A Kontakt has no reservation system: it is no "unbekannt", and a pick of one leaves it out of Heute too.
  assert.deepEqual(toolCounts(state), [["unbekannt", 2]]);
  assert.match(filterBar(state), /Alle Regionen \(4\)/);
  assert.deepEqual(todayQueue(stateWith(LEADS(), { tool: "unbekannt" }), TODAY).today.map((l) => l.id), []);
});

test("a Kontakt's page: its Thema in place of the status, a talk to log, its people; its forms hold its fields only", () => {
  const page = (ui = {}) => detailView(stateWith(LEADS(), { view: "detail", leadId: "K1", ...ui }), TODAY);
  const html = page();
  assert.match(html, /<b>Kontakt<\/b> \xB7 Partnerprogramm/);
  assert.doesNotMatch(html, /data-status=|F\xFCr das Gespr\xE4ch|Kundenakte|Weitere ▾/);
  assert.match(html, /<h3>Personen <button class="link" data-act="accountEdit">/);
  assert.match(html, /<b>Florian<\/b>/);
  assert.match(page({ logMenu: true }), /data-act="talkOpen"/);
  assert.doesNotMatch(page({ logMenu: true }), /visitOpen|callOpen/);
  assert.match(page({ contactPick: { channel: "Telefon", text: "" } }), /data-cp="Telefon" aria-pressed="true">Telefonat[^]*data-cp="Vor Ort" aria-pressed="false">Treffen[^]*id="cpText"/);
  const form = leadEditView(stateWith(LEADS(), { view: "editLead", leadId: "K1" }));
  assert.deepEqual([...form.matchAll(/name="(\w+)"/g)].map(([, n]) => n), ["name", "topic", "city", "region", "person", "phone", "email", "website", "instagram"]);
  assert.match(form, /Kontakt l\xF6schen/);
  assert.match(form, /name="topic"[^>]*maxlength="60"/);
  const people = accountEditView(stateWith(LEADS(), { view: "editAccount", leadId: "K1" }));
  assert.match(people, /<h2>Personen<\/h2>/);
  assert.doesNotMatch(people, /systems\./);
});

test("a record opened from Kontakte is at #/kontakt/…, so Back and a reload land in Kontakte", () => {
  assert.equal(routeOf({ tab: "kontakte", view: "detail", leadId: "K1" }), "#/kontakt/K1");
  assert.equal(routeOf({ tab: "kontakte", view: "editAccount", leadId: "K1" }), "#/kontakt/K1/personen");
  assert.equal(routeOf({ tab: "heute", view: "detail", leadId: "K1" }), "#/betrieb/K1");
  assert.deepEqual(parseRoute("#/kontakt/K1/bearbeiten"), { view: "editLead", leadId: "K1", tab: "kontakte" });
  assert.equal(backRoute({ tab: "kontakte", view: "editLead", leadId: "K1" }), "#/kontakt/K1");
  assert.match(searchResultsHtml(stateWith(LEADS(), { gq: "satke" }), TODAY), /<span class="s-name"><mark>Satke<\/mark>|Satke[^]*<span class="s-st">Kontakt<\/span>/);
});
