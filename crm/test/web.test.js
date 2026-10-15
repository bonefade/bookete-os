import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/web/store.js";
import { tabBar, todayView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView } from "../src/web/views.js";
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
  const html = [tabBar, todayView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView].map((view) => view(state, today)).join("");
  assert.match(html, /Gasthaus &lt;Krone&gt;/);
  assert.match(html, /Per Gmail senden/);
  assert.doesNotMatch(html, /undefined/);
});
