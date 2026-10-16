import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/web/store.js";
import { tabBar, todayView, todosView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView } from "../src/web/views.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";
import { formInput, saveLeadForm } from "../src/web/controller.js";
import { describeChange } from "../src/web/format.js";
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
  state.me = { email: "jo@bookete.com" };
  const v1 = { ...lead, phone: "" };
  state.ui = { ...state.ui, leadId: "L1", gq: "kron", trash: [{ lead: { ...lead, id: "L9" }, actor: "jo@bookete.com (web)", at: "2026-10-15T10:00:00.000Z" }],
    changes: { leadId: "L1", rows: [{ seq: 2, at: "2026-10-15T10:00:00.000Z", actor: "jo@bookete.com (mcp)", deleted: false, before: v1, after: { ...v1, phone: "0664 2" } }, { seq: 1, at: "2026-10-15T09:00:00.000Z", actor: "jo@bookete.com (web)", deleted: false, before: null, after: v1 }] }, compose: { direction: "out", channel: "E-Mail", templateId: "T1", date: today, subject: "S", text: "Hallo", missing: [] } };
  const html = [tabBar, todayView, todosView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView].map((view) => view(state, today)).join("");
  assert.match(html, /Gasthaus &lt;Krone&gt;/);
  assert.match(html, /Per Gmail senden/);
  assert.match(html, /Telefon: \u2013 \u2192 0664 2/);
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
      lead("L4", "Abgeschlossen", "2026-10-01", { status: "kunde" }),
    ],
    activities: [], templates: [], settings: [],
  };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  const todos = todosView(state, today);
  assert.match(todos, /Überfällig <small>1<\/small>/);
  assert.match(todos, /Heute <small>1<\/small>/);
  assert.match(todos, /Termin 13:30 bestätigen[\s\S]*Alt[\s\S]*seit 3 Tagen/);
  assert.match(todos, /data-open="L2"/);
  assert.doesNotMatch(todos, /Später|Abgeschlossen/);
  assert.doesNotMatch(todayView(state, today), /Alt|Heutig/);
  assert.match(tabBar(state, today), /data-tab="todos"[^]*?<span class="badge">2<\/span>/);
});

test("a form save sends only the fields changed since the form opened", () => {
  const field = (name, shown, value = shown) => ({ name, defaultValue: shown, value });
  const select = (name, options, value) => ({ name, value, options: options.map(([v, selected]) => ({ value: v, defaultSelected: selected })) });
  const elements = [
    field("name", "Krone"), field("phone", "0664 1", "0664 9"), field("notes", "", ""),
    select("status", [["recherchiert", false], ["demo", true]], "demo"),
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
