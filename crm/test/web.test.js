import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/web/store.js";
import { tabBar, todayView, todosView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView } from "../src/web/views.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";

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
  state.ui = { ...state.ui, leadId: "L1", gq: "kron", compose: { direction: "out", channel: "E-Mail", templateId: "T1", date: today, subject: "S", text: "Hallo", missing: [] } };
  const html = [tabBar, todayView, todosView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView].map((view) => view(state, today)).join("");
  assert.match(html, /Gasthaus &lt;Krone&gt;/);
  assert.match(html, /Per Gmail senden/);
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
