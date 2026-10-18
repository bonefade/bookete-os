import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { weekStart } from "../src/domain/dates.js";
import { weekNumbers } from "../src/domain/stats.js";
import { callScript, DEFAULT_SCRIPT } from "../src/domain/template.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";
import { initialState } from "../src/web/store.js";
import { todayView, detailView } from "../src/web/views.js";

let today = "2026-10-15";
const clock = { today: () => today, now: () => today + "T10:00:00.000Z" };
function setup() {
  const store = createStore(createD1());
  let n = 0;
  return { store, uc: createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)" }) };
}

test("the week runs Monday to Sunday", () => {
  assert.deepEqual(["2026-10-12", "2026-10-15", "2026-10-18", "2026-10-19"].map(weekStart), ["2026-10-12", "2026-10-12", "2026-10-12", "2026-10-19"]);
});

test("wonAt is the day of the change to Kunde: kept while Kunde, gone when the lead stops being one", async () => {
  today = "2026-10-15";
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone", status: "qualifiziert" });
  assert.equal((await store.get("leads", id)).wonAt, null);
  await uc.changeStatus(id, "kunde");
  assert.equal((await store.get("leads", id)).wonAt, "2026-10-15");
  today = "2026-10-20";
  await uc.setNextStep(id, "Onboarding");
  assert.equal((await store.get("leads", id)).wonAt, "2026-10-15");
  await uc.changeStatus(id, "qualifiziert");
  assert.equal((await store.get("leads", id)).wonAt, null);
  // A customer from before 1.8.0 has no date, and an edit does not give it today's.
  const old = await uc.addLead({ name: "Post", status: "kunde" });
  // As stored before 1.8.0: a patch's null removes the field.
  await store.commit([{ type: "patch", collection: "leads", id: old, base: await store.get("leads", old), data: { wonAt: null } }], "test");
  assert.equal((await store.get("leads", old)).wonAt, null);
  await uc.setNextStep(old, "Rechnung");
  assert.equal((await store.get("leads", old)).wonAt, null);
  assert.equal(COMMANDS.updateLead[0].safeParse({ id: "a", input: { wonAt: "2026-10-01" } }).success, false);
});

test("an imported customer keeps its wonAt, and none is made up for one without", async () => {
  today = "2026-10-15";
  const { store, uc } = setup();
  const lead = (id, wonAt) => ({ ...LEAD_FIELDS, id, name: id, status: "kunde", contactedAt: "2026-09-01", wonAt, schemaVersion: 3 });
  // A first contact in another format is dated today, as before 1.8.0, not refused as a cleared one.
  const odd = { ...lead("c", "2026-09-10"), contactedAt: "01.09.2026" };
  await uc.importBackup({ format: "bookete-crm-backup", schemaVersion: 3, data: { leads: [lead("a", "2026-09-10"), lead("b", null), odd], activities: [], templates: [], settings: [] } });
  assert.deepEqual([(await store.get("leads", "a")).wonAt, (await store.get("leads", "b")).wonAt], ["2026-09-10", null]);
  assert.equal((await store.get("leads", "c")).contactedAt, "2026-10-15");
});

test("this week's numbers: calls, reached, appointments, new customers and the reasons for no", () => {
  const call = (date, outcome, reason = null) => ({ leadId: "x", direction: "out", channel: "Telefon", date, outcome, reason });
  const acts = [
    call("2026-10-11", "termin"), call("2026-10-12", "nicht-erreicht"), call("2026-10-12", null), call("2026-10-13", "rueckruf"), call("2026-10-14", "termin"),
    call("2026-10-14", "kein-interesse", "Kein Bedarf"), call("2026-10-14", "kein-interesse", "Zu klein"), call("2026-10-15", "kein-interesse", "Zu klein"),
    call("2026-10-15", "kein-interesse", "Zu teuer"), call("2026-10-15", "kein-interesse", "Zu teuer"), call("2026-10-15", "kein-interesse", "Zu teuer"), call("2026-10-15", "kein-interesse", "Saisonbetrieb"),
    { leadId: "x", direction: "out", channel: "E-Mail", date: "2026-10-13", outcome: null, reason: null }, { leadId: "x", direction: "in", channel: "Telefon", date: "2026-10-13", outcome: null, reason: null },
  ];
  const leads = [{ wonAt: "2026-10-12" }, { wonAt: "2026-10-09" }, { wonAt: null }];
  assert.deepEqual(weekNumbers(leads, acts, "2026-10-15"), { from: "2026-10-12", calls: 11, reached: 9, meetings: 1, customers: 1, reasons: [["Zu teuer", 3], ["Zu klein", 2], ["Kein Bedarf", 1]] });
});

test("the call script: the leitfaden template if there is one, else the default, filled in", () => {
  const lead = { ...LEAD_FIELDS, name: "Krone", city: "Graz" };
  const d = callScript(lead, [{ id: "t1", purpose: "erstkontakt", body: "Hallo {Betrieb}" }]);
  assert.equal(d.template, null);
  assert.equal(d.text, DEFAULT_SCRIPT.replace("{Betrieb}", "Krone"));
  assert.match(d.text, /Wie nehmt ihr Reservierungen heute an\?/);
  const t = callScript(lead, [
    { id: "t3", purpose: "leitfaden", body: "Neuer", createdAt: "2026-10-16T08:00:00.000Z" },
    { id: "t2", purpose: "leitfaden", body: "Servus {Betrieb} in {Ort}", createdAt: "2026-10-15T08:00:00.000Z" },
  ]);
  assert.deepEqual([t.template.id, t.text], ["t2", "Servus Krone in Graz"]);
});

test("Heute shows the week; the lead page folds the script, and a script is no message template", () => {
  const state = initialState();
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", phone: "+43 1", status: "kontaktiert", contactedAt: "2026-10-01" };
  state.data.leads = [lead, { ...LEAD_FIELDS, id: "L2", name: "Post", status: "kunde", contactedAt: "2026-10-01", wonAt: "2026-10-13" }];
  state.data.activities = [{ id: "a1", leadId: "L1", direction: "out", channel: "Telefon", date: "2026-10-14", outcome: "termin", reason: null, text: "Termin", createdAt: "x" }];
  state.data.templates = [{ id: "t1", name: "Leitfaden", purpose: "leitfaden", body: "Servus {Betrieb}" }, { id: "t2", name: "Erstkontakt", purpose: "erstkontakt", body: "Hallo" }];
  const week = todayView(state, "2026-10-15");
  assert.match(week, /Diese Woche <small>seit Mo\., 12\. Okt\.<\/small>/);
  assert.deepEqual([...week.matchAll(/<b>(\d+)<\/b><span>(Anrufe|erreicht|Termine|neue Kunden)/g)].map((m) => m[2] + " " + m[1]), ["Anrufe 1", "erreicht 1", "Termine 1", "neue Kunden 1"]);
  state.ui = { ...state.ui, view: "detail", leadId: "L1", call: {} };
  assert.doesNotMatch(detailView(state, "2026-10-15"), /Servus Krone/);
  state.ui = { ...state.ui, script: true };
  const sheet = detailView(state, "2026-10-15");
  assert.match(sheet, /Servus Krone/);
  assert.doesNotMatch(sheet, /data-act="scriptTemplate"/);
  state.ui = { ...state.ui, call: null, compose: { direction: "out", templateId: "", channel: "E-Mail", date: "2026-10-15", subject: "", text: "", missing: [] } };
  const composer = detailView(state, "2026-10-15");
  assert.match(composer, /<option value="t2">Erstkontakt/);
  assert.doesNotMatch(composer, /<option value="t1">/);
  state.data.templates = [];
  state.ui = { ...state.ui, call: {}, compose: null };
  assert.match(detailView(state, "2026-10-15"), /data-act="scriptTemplate"/);
});
