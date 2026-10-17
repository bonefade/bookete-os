import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/web/store.js";
import { tabBar, todayView, todosView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView, filterBar } from "../src/web/views.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";
import { formInput, saveLeadForm, pickLostReason } from "../src/web/controller.js";
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
