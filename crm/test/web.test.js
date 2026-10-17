import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, initialState } from "../src/web/store.js";
import { tabBar, todayView, todosView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView, filterBar } from "../src/web/views.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";
import { formInput, saveLeadForm, pickLostReason, routeOf, parseRoute, enterRoute, backRoute, recordMissing, createNavigation, mountApp } from "../src/web/controller.js";
import { describeChange } from "../src/web/format.js";
import { scoped } from "../src/web/selectors.js";
import { createApi } from "../src/web/api.js";
import { readFileSync } from "node:fs";

// Renders every view once: catches missing imports and broken templates, which no bundler step reports.
test("every view renders with data", () => {
  const today = "2026-10-15";
  const state = initialState();
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Gasthaus <Krone>", city: "Graz", status: "kontaktiert", email: "k@example.at", followUp: today };
  state.data = {
    leads: [lead],
    activities: [{ id: "A1", leadId: "L1", date: "2026-10-12", channel: "E-Mail", direction: "out", text: "Hallo", createdAt: "x" }],
    templates: [{ id: "T1", name: "Erst", purpose: "erstkontakt", body: "Hallo {Betrieb}" }],
    settings: [{ id: "icp", fit: ["Gasthaus"], noFit: [] }],
  };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.caps = { db: true, gmail: true };
  state.me = { email: "jo@bookete.com", version: "9.8.7" };
  const v1 = { ...lead, phone: "" };
  state.ui = { ...state.ui, leadId: "L1", gq: "kron", trash: [{ lead: { ...lead, id: "L9" }, actor: "jo@bookete.com (web)", at: "2026-10-15T10:00:00.000Z" }],
    changes: { leadId: "L1", rows: [{ seq: 2, at: "2026-10-15T10:00:00.000Z", actor: "jo@bookete.com (mcp)", deleted: false, before: v1, after: { ...v1, phone: "0664 2" } }, { seq: 1, at: "2026-10-15T09:00:00.000Z", actor: "jo@bookete.com (web)", deleted: false, before: null, after: v1 }] }, compose: { direction: "out", channel: "E-Mail", templateId: "T1", date: today, subject: "S", text: "Hallo", missing: [] } };
  const html = [tabBar, todayView, todosView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView].map((view) => view(state, today)).join("");
  assert.match(html, /Gasthaus &lt;Krone&gt;/);
  assert.match(html, /Per Gmail senden/);
  assert.match(html, /Telefon: \u2013 \u2192 0664 2/);
  assert.match(moreView(state, today), /Version 9\.8\.7/);
  assert.match(html, /data-restore="L9"/);
  // The Content-Security-Policy (public/_headers) blocks inline handlers and inline scripts.
  for (const [where, text] of [["views", html], ["index.html", readFileSync(new URL("../public/index.html", import.meta.url), "utf8")]]) {
    assert.doesNotMatch(text, /\son[a-z]+\s*=/i, where);
    assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)/i, where);
  }
  assert.doesNotMatch(html, /undefined/);
});

test("due leads are todos in their own tab, not in Heute", () => {
  const today = "2026-10-15";
  const state = initialState();
  const lead = (id, name, followUp, extra = {}) => ({ ...LEAD_FIELDS, id, name, status: "kontaktiert", followUp, ...extra });
  state.data = {
    leads: [
      lead("L1", "Alt", "2026-10-12", { nextStep: "Termin 13:30 bestätigen" }),
      lead("L2", "Heutig", today),
      lead("L3", "Später", "2026-10-20"),
      lead("L4", "Abgeschlossen", "2026-10-01", { status: "disqualifiziert", lostReason: "Kein Bedarf" }),
      lead("L5", "Onboarding", today, { status: "kunde" }),
    ],
    activities: [], templates: [], settings: [],
  };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  const todos = todosView(state, today);
  assert.match(todos, /Überfällig <small>1<\/small>/);
  assert.match(todos, /Heute <small>2<\/small>/);
  assert.match(todos, /data-open="L5"/);
  assert.match(todos, /Termin 13:30 bestätigen[\s\S]*Alt[\s\S]*seit 3 Tagen/);
  assert.match(todos, /data-open="L2"/);
  assert.doesNotMatch(todos, /Später|Abgeschlossen/);
  assert.doesNotMatch(todayView(state, today), /Alt|Heutig/);
  assert.match(tabBar(state, today), /data-tab="todos"[^]*?<span class="badge">3<\/span>/);
});

test("a form save sends only the fields changed since the form opened", () => {
  const field = (name, shown, value = shown) => ({ name, defaultValue: shown, value });
  const select = (name, options, value) => ({ name, value, options: options.map(([v, selected]) => ({ value: v, defaultSelected: selected })) });
  const elements = [
    field("name", "Krone"), field("phone", "0664 1", "0664 9"), field("notes", "", ""),
    select("status", [["neu", false], ["qualifiziert", true]], "qualifiziert"),
    select("fit", [["3", false], ["2", false]], "2"),
    select("type", [["Gasthaus", false], ["Bar", true]], "Gasthaus"),
    { name: "", value: "x", defaultValue: "" },
  ];
  assert.deepEqual(formInput(elements, true), { phone: "0664 9", fit: "2", type: "Gasthaus" });
  assert.deepEqual(Object.keys(formInput(elements, false)), ["name", "phone", "notes", "status", "fit", "type"]);
});

test("a history entry reads as what changed, from what to what", () => {
  const v1 = { ...LEAD_FIELDS, name: "Krone", status: "kontaktiert", notes: "x".repeat(100) };
  assert.deepEqual(describeChange({ before: null, after: v1, deleted: false }), ["Angelegt"]);
  assert.deepEqual(describeChange({ before: v1, after: { ...v1, status: "demo", followUp: null, updatedAt: "later" }, deleted: false }), ["Status: Kontaktiert \u2192 Gespr\xE4ch/Demo"]);
  assert.deepEqual(describeChange({ before: v1, after: { ...v1, status: "disqualifiziert", lostReason: "Zu klein", contactedAt: "2026-10-12" }, deleted: false }),
    ["Status: Kontaktiert \u2192 Disqualifiziert", "Grund: \u2013 \u2192 Zu klein", "Erstkontakt: \u2013 \u2192 Mo., 12. Okt."]);
  // Versions written before 1.4.0 keep their old statuses in the history; they still read as words.
  const old = { ...v1, status: "recherchiert" };
  assert.deepEqual(["antwort", "onboarding", "kein-interesse"].map((status) => describeChange({ before: old, after: { ...old, status }, deleted: false })[0]),
    ["Status: Recherchiert \u2192 Antwort", "Status: Recherchiert \u2192 Onboarding", "Status: Recherchiert \u2192 Kein Interesse"]);
  assert.deepEqual(describeChange({ before: v1, after: { ...v1, notes: "kurz" }, deleted: false }), [`Notizen: ${"x".repeat(59)}\u2026 \u2192 kurz`]);
  assert.deepEqual(describeChange({ before: v1, after: v1, deleted: true, wasDeleted: false }), ["In den Papierkorb gelegt"]);
  assert.deepEqual(describeChange({ before: v1, after: v1, deleted: false, wasDeleted: true }), ["Wiederhergestellt"]);
  assert.deepEqual(describeChange({ before: v1, after: { ...v1, updatedAt: "later" }, deleted: false, wasDeleted: false }), []);
});

test("Änderungen leaves out entries with nothing visible, such as a logged contact", () => {
  const state = initialState();
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert" };
  state.data = { leads: [lead], activities: [], templates: [], settings: [] };
  state.status = { ...state.status, leads: true, activities: true };
  const entry = (after) => ({ seq: 2, at: "2026-10-15T10:00:00.000Z", actor: "jo@bookete.com (web)", deleted: false, wasDeleted: false, before: lead, after });
  state.ui = { ...state.ui, leadId: "L1", changes: { leadId: "L1", rows: [entry({ ...lead, updatedAt: "later" })] } };
  assert.match(detailView(state, "2026-10-15"), /Noch keine \xC4nderungen aufgezeichnet/);
  assert.doesNotMatch(detailView(state, "2026-10-15"), /Ohne sichtbare/);
});

test("saving the edit form of a lead deleted in the meantime asks the server, never adds a copy", async () => {
  const calls = [];
  const uc = { updateLead: async (lead, input) => calls.push(["update", lead.id, input]), addLead: async (input) => (calls.push(["add", input]), "NEW") };
  const elements = [{ name: "name", defaultValue: "Krone", value: "Krone" }, { name: "phone", defaultValue: "1", value: "2" }];
  assert.equal(await saveLeadForm(uc, "L1", elements), "L1");
  assert.equal(await saveLeadForm(uc, null, elements), "NEW");
  assert.deepEqual(calls, [["update", "L1", { phone: "2" }], ["add", { name: "Krone", phone: "2" }]]);
});

const TODAY = "2026-10-15";
function stateWith(leads, ui = {}) {
  const state = initialState();
  state.data = { leads: leads.map((l) => ({ ...LEAD_FIELDS, ...l })), activities: [], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.caps = { db: true, gmail: false };
  state.ui = { ...state.ui, ...ui };
  return state;
}
const optionsOf = (html, filter) => [...html.match(new RegExp(`data-filter="${filter}"[^>]*>([^]*?)</select>`))[1].matchAll(/<option value="([^"]*)"( selected)?>([^<]*)</g)].map(([, v, sel, text]) => (sel ? "*" : "") + v + " " + text);

test("one filter row: region, system and contact as selects, each counting what the others leave", () => {
  const leads = [
    { id: "L1", name: "A", city: "Graz", phone: "0664 1", email: "a@example.at", currentTool: "Quandoo" },
    { id: "L2", name: "B", city: "Graz", phone: "0664 2" },
    { id: "L3", name: "C", city: "Wien", email: "c@example.at" },
    { id: "L4", name: "D", city: "Wien" },
    { id: "L5", name: "E", city: "Graz", email: "e@example.at" },
  ];
  const all = stateWith(leads);
  const bar = filterBar(all);
  assert.equal(bar.match(/<select/g).length, 3);
  assert.doesNotMatch(bar, /<button/);
  assert.deepEqual(optionsOf(bar, "region"), ["*alle Alle Regionen (5)", "Steiermark Steiermark (3)", "Wien Wien (2)"]);
  assert.deepEqual(optionsOf(bar, "tool"), ["*alle Alle Systeme (5)", "unbekannt unbekannt (4)", "Quandoo Quandoo (1)"]);
  assert.deepEqual(optionsOf(bar, "contact"), ["*alle Alle Kontakte (5)", "telefon mit Telefon (2)", "email mit E-Mail (3)"]);
  const graz = stateWith(leads, { region: "Steiermark", contact: "telefon" });
  assert.deepEqual(scoped(graz).map((l) => l.id), ["L1", "L2"]);
  assert.deepEqual(scoped(stateWith(leads, { contact: "email" })).map((l) => l.id), ["L1", "L3", "L5"]);
  const bar2 = filterBar(graz);
  assert.deepEqual(optionsOf(bar2, "region"), ["alle Alle Regionen (2)", "*Steiermark Steiermark (2)"]);
  assert.deepEqual(optionsOf(bar2, "contact"), ["alle Alle Kontakte (3)", "*telefon mit Telefon (2)", "email mit E-Mail (2)"]);
  assert.deepEqual(optionsOf(bar2, "tool"), ["*alle Alle Systeme (2)", "unbekannt unbekannt (1)", "Quandoo Quandoo (1)"]);
});

test("Betriebe: a status select, and with Disqualifiziert a reason and a contacted select", () => {
  const leads = [
    { id: "L1", name: "Neu", status: "neu" },
    { id: "L2", name: "Dran", status: "kontaktiert", contactedAt: "2026-10-01" },
    { id: "L3", name: "Termin", status: "qualifiziert", contactedAt: "2026-10-02" },
    { id: "L4", name: "Kundin", status: "kunde", contactedAt: "2026-09-01" },
    { id: "L5", name: "Klein", status: "disqualifiziert", lostReason: "Zu klein", contactedAt: "2026-09-03" },
    { id: "L6", name: "Zu", status: "disqualifiziert", lostReason: "Geschlossen / existiert nicht" },
    { id: "L7", name: "Winzig", status: "disqualifiziert", lostReason: "Zu klein" },
  ];
  const names = (html) => [...html.matchAll(/class="c-name">([^<]*)</g)].map((m) => m[1]);
  const open = leadsView(stateWith(leads), TODAY);
  assert.deepEqual(optionsOf(open, "status"), ["*offen Offen (3)", "neu Neu (1)", "kontaktiert Kontaktiert (1)", "qualifiziert Qualifiziert (1)", "kunde Kunde (1)", "disqualifiziert Disqualifiziert (3)", "alle Alle (7)"]);
  assert.doesNotMatch(open, /data-filter="(reason|contacted)"/);
  assert.deepEqual(names(open).sort(), ["Dran", "Neu", "Termin"]);
  assert.deepEqual(names(leadsView(stateWith(leads, { status: "kunde" }), TODAY)), ["Kundin"]);
  const disq = leadsView(stateWith(leads, { status: "disqualifiziert" }), TODAY);
  assert.deepEqual(optionsOf(disq, "reason"), ["*alle Alle Gr\xFCnde (3)", "Zufrieden mit aktueller L\xF6sung Zufrieden mit aktueller L\xF6sung (0)", "Kein Bedarf Kein Bedarf (0)", "Zu klein Zu klein (2)", "Nicht unsere Zielgruppe Nicht unsere Zielgruppe (0)", "Geschlossen / existiert nicht Geschlossen / existiert nicht (1)", "Nicht erreicht Nicht erreicht (0)", "Keine Kontaktaufnahme gew\xFCnscht Keine Kontaktaufnahme gew\xFCnscht (0)"]);
  assert.deepEqual(optionsOf(disq, "contacted"), ["*alle Kontaktiert: alle (3)", "ja Kontaktiert: ja (1)", "nein Kontaktiert: nein (2)"]);
  const small = leadsView(stateWith(leads, { status: "disqualifiziert", reason: "Zu klein" }), TODAY);
  assert.deepEqual(names(small).sort(), ["Klein", "Winzig"]);
  assert.deepEqual(optionsOf(small, "contacted"), ["*alle Kontaktiert: alle (2)", "ja Kontaktiert: ja (1)", "nein Kontaktiert: nein (1)"]);
  assert.deepEqual(names(leadsView(stateWith(leads, { status: "disqualifiziert", reason: "Zu klein", contacted: "nein" }), TODAY)), ["Winzig"]);
  // The reason in a row says why a lead is closed.
  assert.match(small, /Winzig[^]*?class="c-next">Zu klein</);
  // Reason and contacted narrow only the disqualified list they are shown with.
  assert.deepEqual(names(leadsView(stateWith(leads, { status: "alle", reason: "Zu klein", contacted: "nein" }), TODAY)).length, 7);
});

test("Heute offers the new leads to write to first", () => {
  const html = todayView(stateWith([{ id: "L1", name: "Frisch", status: "neu" }, { id: "L2", name: "Dran", status: "kontaktiert", contactedAt: "2026-10-01" }]), TODAY);
  assert.match(html, /Bereit zum Anschreiben <small>1<\/small>[^]*Frisch/);
  assert.doesNotMatch(html, /Dran/);
});

test("the lead view: five status chips, the reason picker, and since when the lead is contacted", () => {
  const lead = { id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-12" };
  const view = detailView(stateWith([lead], { leadId: "L1" }), TODAY);
  assert.deepEqual([...view.matchAll(/data-status="([^"]+)"/g)].map((m) => m[1]), ["neu", "kontaktiert", "qualifiziert", "kunde", "disqualifiziert"]);
  assert.match(view, /Kontaktiert seit Mo\., 12\. Okt\./);
  assert.doesNotMatch(view, /data-lost=/);
  const picking = detailView(stateWith([lead], { leadId: "L1", lostPick: true }), TODAY);
  assert.equal([...picking.matchAll(/data-lost="/g)].length, 7);
  assert.match(picking, /Warum disqualifiziert\?/);
  assert.match(picking, /data-act="lostCancel"/);
  const fresh = detailView(stateWith([{ id: "L2", name: "Frisch", status: "neu" }], { leadId: "L2" }), TODAY);
  assert.match(fresh, /Nie kontaktiert/);
  const closed = detailView(stateWith([{ id: "L3", name: "Zu", status: "disqualifiziert", lostReason: "Zu klein" }], { leadId: "L3" }), TODAY);
  assert.match(closed, /Disqualifiziert \xB7 Zu klein/);
  assert.match(closed, /data-act="lostPick">Grund \xE4ndern/);
  assert.doesNotMatch(closed, /id="fu"/);
});

test("picking a reason disqualifies in one call, or changes the reason of a disqualified lead", async () => {
  const calls = [];
  const uc = { changeStatus: async (...a) => calls.push(["changeStatus", a[0].id, ...a.slice(1)]), setLostReason: async (...a) => calls.push(["setLostReason", a[0].id, ...a.slice(1)]) };
  await pickLostReason(uc, { id: "L1", status: "kontaktiert" }, "Zu klein");
  await pickLostReason(uc, { id: "L2", status: "disqualifiziert", lostReason: "Zu klein" }, "Kein Bedarf");
  assert.deepEqual(calls, [["changeStatus", "L1", "disqualifiziert", "Zu klein"], ["setLostReason", "L2", "Kein Bedarf"]]);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (sent.push([url, JSON.parse(init.body)]), new Response('{"result":true}'));
  try {
    await createApi(() => {}).changeStatus({ id: "L1" }, "disqualifiziert", "Zu klein");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, [["/api/rpc/changeStatus", { id: "L1", status: "disqualifiziert", reason: "Zu klein" }]]);
});

test("the edit form asks for a reason next to the status, shown for Disqualifiziert", () => {
  const reasonField = (html) => html.match(/<label id="lostReasonField"([^>]*)>([^]*?)<\/label>/);
  const closed = leadEditView(stateWith([{ id: "L1", name: "Zu", status: "disqualifiziert", lostReason: "Zu klein" }], { leadId: "L1" }));
  const [, attrs, inner] = reasonField(closed);
  assert.doesNotMatch(attrs, /hidden/);
  assert.match(inner, /^Grund \*<select name="lostReason">/);
  assert.match(inner, /<option value="Zu klein" selected>/);
  assert.match(inner, /<option value="">Grund w\xE4hlen \u2026<\/option>/);
  assert.match(reasonField(leadEditView(stateWith([{ id: "L2", name: "Dran", status: "kontaktiert", contactedAt: "2026-10-01" }], { leadId: "L2" })))[1], /hidden/);
  assert.match(reasonField(leadEditView(stateWith([])))[1], /hidden/);
});

test("Mehr counts the disqualified leads by their reason", () => {
  const html = moreView(stateWith([
    { id: "L1", name: "A", status: "disqualifiziert", lostReason: "Zu klein" },
    { id: "L2", name: "B", status: "disqualifiziert", lostReason: "Zu klein" },
    { id: "L3", name: "C", status: "disqualifiziert", lostReason: "Kein Bedarf" },
    { id: "L4", name: "D", status: "kontaktiert", contactedAt: "2026-10-01" },
  ]));
  assert.match(html, /Warum disqualifiziert[^]*<dt>Zu klein<\/dt><dd>2<\/dd>[^]*<dt>Kein Bedarf<\/dt><dd>1<\/dd>/);
  assert.doesNotMatch(html, /ohne Grund/);
});

test("every screen has an address, and the address opens that screen", () => {
  const screens = [
    [{ tab: "betriebe", view: null }, "#/betriebe"],
    [{ tab: "heute", view: "detail", leadId: "L 1/ä" }, "#/betrieb/L%201%2F%C3%A4"],
    [{ tab: "heute", view: "editLead", leadId: "L1" }, "#/betrieb/L1/bearbeiten"],
    [{ tab: "vorlagen", view: "editTemplate", templateId: "T1" }, "#/vorlage/T1"],
    [{ tab: "vorlagen", view: "editTemplate", templateId: null }, "#/vorlage/neu"],
  ];
  for (const [ui, hash] of screens) {
    assert.equal(routeOf(ui), hash);
    // A lead keeps the tab it was opened from; a template belongs to Vorlagen.
    const { tab, ...rest } = ui;
    assert.deepEqual(parseRoute(hash), !ui.view ? { view: null, tab } : ui.view === "editTemplate" ? ui : rest);
  }
  // A bare start, an unknown tab and a broken escape all open Heute.
  for (const hash of ["", "#", "#/", "#/gibts-nicht", "#/betrieb/%E0"]) assert.deepEqual(parseRoute(hash), { view: null, tab: "heute" }, hash);
});

test("entering an address resets what belongs to the screen left, and keeps the rest", () => {
  const ui = { ...initialState().ui, tab: "betriebe", q: "krone", quick: true, compose: { text: "x" }, lostPick: true, trash: [{}], scroll: { betriebe: 300 } };
  const lead = enterRoute(ui, parseRoute("#/betrieb/L1"));
  assert.deepEqual([lead.view, lead.leadId, lead.tab, lead.compose, lead.lostPick, lead.q], ["detail", "L1", "betriebe", null, false, "krone"]);
  // Back from the edit form to the same lead keeps its open compose box.
  const again = enterRoute({ ...ui, view: "editLead", leadId: "L1" }, parseRoute("#/betrieb/L1"));
  assert.deepEqual(again.compose, { text: "x" });
  const mehr = enterRoute(ui, parseRoute("#/mehr"));
  assert.deepEqual([mehr.view, mehr.tab, mehr.quick, mehr.trash], [null, "mehr", false, null]);
  assert.deepEqual(enterRoute({ ...ui, tab: "mehr" }, parseRoute("#/mehr")).trash, [{}]);
});

test("the in-app back button goes to the screen above", () => {
  assert.equal(backRoute({ tab: "todos", view: "detail", leadId: "L1" }), "#/todos");
  assert.equal(backRoute({ tab: "todos", view: "editLead", leadId: "L1" }), "#/betrieb/L1");
  assert.equal(backRoute({ tab: "vorlagen", view: "editTemplate", templateId: "T1" }), "#/vorlagen");
  // A template opened from a link or after a reload, where the app starts on Heute.
  for (const hash of ["#/vorlage/T1", "#/vorlage/neu"]) assert.equal(backRoute(enterRoute({ ...initialState().ui, tab: "heute" }, parseRoute(hash))), "#/vorlagen", hash);
});

test("a lead page opened from an address waits for the data instead of falling back", () => {
  const state = initialState();
  state.ui = { ...state.ui, view: "detail", leadId: "L1" };
  assert.match(detailView(state, "2026-10-15"), /Lade Daten/);
  state.ui.view = "editLead";
  assert.match(leadEditView(state), /Lade Daten/);
  // A form filled in here, before the data arrives, would be saved over the real template.
  state.ui = { ...state.ui, view: "editTemplate", templateId: "T1" };
  assert.match(templateEditView(state), /Lade Daten/);
  assert.doesNotMatch(leadEditView(state) + templateEditView(state), /<form/);
});

test("a lead or template address whose record is gone falls back once the data is there", () => {
  const state = { ...initialState(), status: { leads: true, activities: true, templates: true, settings: true, failed: "" } };
  state.data = { ...state.data, leads: [{ ...LEAD_FIELDS, id: "L1", name: "Krone" }], templates: [{ id: "T1", name: "Erst", purpose: "", body: "x" }] };
  const at = (ui) => recordMissing({ ...state, ui: { ...state.ui, ...ui } });
  for (const view of ["detail", "editLead"]) assert.deepEqual([at({ view, leadId: "L1" }), at({ view, leadId: "GONE" })], [false, true], view);
  assert.deepEqual([at({ view: "editTemplate", templateId: "T1" }), at({ view: "editTemplate", templateId: "GONE" })], [false, true]);
  // New records and the tabs have none to miss; before the data arrives nothing is missing yet.
  assert.deepEqual([at({ view: "editLead", leadId: null }), at({ view: "editTemplate", templateId: null }), at({ view: null })], [false, false, false]);
  assert.equal(recordMissing({ ...initialState(), ui: { ...state.ui, view: "detail", leadId: "GONE" } }), false);
});

// The browser's history, as far as the app uses it: entries with a state, and steps back or forward that land
// later, as history.go does, each firing popstate.
function fakeHistory(first) {
  const entries = [{ state: null, url: first }];
  let i = 0;
  const queued = [];
  const onPop = [];
  const history = {
    get state() { return entries[i].state; },
    pushState(state, _, url) { entries.splice(++i, Infinity, { state, url }); },
    replaceState(state, _, url) { entries[i] = { state, url }; },
    go(n) { queued.push(n); },
  };
  const location = { get hash() { return entries[i].url; } };
  return {
    history,
    location,
    onPop: (f) => onPop.push(f),
    land() {
      while (queued.length) {
        i += queued.shift();
        onPop.forEach((f) => f());
      }
    },
    // Every entry with the depth it carries, and the current one.
    seen: () => ({ at: i, entries: entries.map((e) => [e.url, e.state?.crm ?? null]) }),
  };
}

test("leaving a screen steps back through the app's own entries and never leaves a copy behind", () => {
  const h = fakeHistory("#/betriebe");
  const shown = [];
  const nav = createNavigation(h.history, h.location, () => shown.push(h.location.hash));
  h.onPop(nav.landed);
  nav.go("#/betrieb/L1");
  nav.go("#/betrieb/L1/bearbeiten");
  const opened = [["#/betriebe", null], ["#/betrieb/L1", 1], ["#/betrieb/L1/bearbeiten", 2]];
  assert.deepEqual(h.seen(), { at: 2, entries: opened });
  // Saving the edit: back to the lead page, which stays the only one.
  nav.leave("#/betrieb/L1");
  h.land();
  assert.deepEqual([h.seen(), shown.at(-1)], [{ at: 1, entries: opened }, "#/betrieb/L1"]);
  // Deleting from the edit form: past the lead page, back to the tab.
  nav.go("#/betrieb/L1/bearbeiten");
  assert.deepEqual(h.seen(), { at: 2, entries: opened });
  nav.leave("#/betriebe", 2);
  h.land();
  assert.deepEqual([h.seen(), shown.at(-1)], [{ at: 0, entries: opened }, "#/betriebe"]);

  // Opened from a link: no entry of ours to step back to, so the screen up takes this entry's place.
  const link = fakeHistory("#/betrieb/L1/bearbeiten");
  const deep = createNavigation(link.history, link.location, () => {});
  deep.leave("#/betrieb/L1");
  assert.deepEqual(link.seen(), { at: 0, entries: [["#/betrieb/L1", null]] });
  // One entry of ours is not enough to step two back.
  deep.go("#/betrieb/L1/bearbeiten");
  assert.deepEqual(link.seen(), { at: 1, entries: [["#/betrieb/L1", null], ["#/betrieb/L1/bearbeiten", 1]] });
  deep.leave("#/betriebe", 2);
  assert.deepEqual(link.seen(), { at: 1, entries: [["#/betrieb/L1", null], ["#/betriebe", 1]] });
});

test("a double click on Zurück steps back once", () => {
  const h = fakeHistory("#/betriebe");
  const nav = createNavigation(h.history, h.location, () => {});
  h.onPop(nav.landed);
  nav.go("#/betrieb/L1");
  nav.go("#/betrieb/L1/bearbeiten");
  nav.leave("#/betrieb/L1");
  nav.leave("#/betrieb/L1");
  h.land();
  assert.equal(h.seen().at, 1);
  // Once landed, the next Zurück works again.
  nav.leave("#/betriebe");
  h.land();
  assert.equal(h.seen().at, 0);
});

// mountApp in a fake browser: just enough of document, window and the screen's root for the app to draw into
// and for a test to click its buttons.
function fakeBrowser(hash, store, uc) {
  const h = fakeHistory(hash);
  const on = {};
  const root = {
    innerHTML: "",
    addEventListener() {},
    contains: () => false,
    // A drawn form, with no fields: the use case fakes take whatever the form holds.
    querySelector: (sel) => (sel === "form" || sel === "#form") && root.innerHTML.includes("<form") ? { elements: [] } : null,
    querySelectorAll: () => [],
  };
  Object.assign(globalThis, {
    history: h.history,
    location: h.location,
    window: { scrollY: 0, scrollTo() {}, addEventListener: (type, f) => type === "popstate" && h.onPop(f) },
    document: { activeElement: null, addEventListener: (type, f) => (on[type] = f) },
    confirm: () => true,
  });
  const app = mountApp({ root, tabsEl: {}, toastEl: { classList: { add() {}, remove() {} } }, store, clock: { today: () => "2026-10-15" } });
  app.connect(uc);
  const click = (dataset) => on.click({ target: { closest: () => ({ dataset }) } });
  return { h, root, app, click };
}

test("the app's buttons and the browser's Back and Forward move through the addresses", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert" };
  const ready = (store, name) => {
    store.data("leads", [{ ...lead, name }]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
  };
  const uc = { updateLead: async () => {}, deleteLead: async () => {} };
  try {
    const store = createStore(initialState());
    ready(store, "Krone");
    const { h, click } = fakeBrowser("#/betriebe", store, uc);
    await click({ open: "L1" });
    await click({ act: "edit" });
    const opened = [["#/betriebe", null], ["#/betrieb/L1", 1], ["#/betrieb/L1/bearbeiten", 2]];
    // Saving the edit steps back to the lead page instead of adding another one.
    await click({ act: "saveLead" });
    h.land();
    assert.deepEqual([h.seen(), store.get().ui.view], [{ at: 1, entries: opened }, "detail"]);
    // Deleting from the edit form steps back past the lead page to the tab.
    await click({ act: "edit" });
    await click({ act: "deleteLead" });
    h.land();
    assert.deepEqual([h.seen(), store.get().ui.view, store.get().ui.tab], [{ at: 0, entries: opened }, null, "betriebe"]);
    // The browser's Forward shows the lead page again.
    h.history.go(1);
    h.land();
    assert.equal(store.get().ui.view, "detail");

    // An edit form opened after a reload waits for the data, is drawn once it arrives, and then stays as it is.
    const later = createStore(initialState());
    const reload = fakeBrowser("#/betrieb/L1/bearbeiten", later, uc);
    assert.doesNotMatch(reload.root.innerHTML, /<form/);
    ready(later, "Krone");
    reload.app.onDataChanged();
    assert.match(reload.root.innerHTML, /<form[^]*value="Krone"/);
    ready(later, "Krone neu");
    reload.app.onDataChanged();
    assert.doesNotMatch(reload.root.innerHTML, /Krone neu/);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

test("a sign-in asked for by the server comes back to the same screen", async () => {
  const [realFetch, realLocation] = [globalThis.fetch, globalThis.location];
  const went = [];
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  globalThis.location = { pathname: "/", hash: "#/betrieb/L2", assign: (u) => went.push(u) };
  try {
    await createApi(() => {}).changeStatus({ id: "L2" }, "kontaktiert").catch(() => {});
  } finally {
    [globalThis.fetch, globalThis.location] = [realFetch, realLocation];
  }
  assert.deepEqual(went, ["/auth/login?next=%2F%23%2Fbetrieb%2FL2"]);
});
