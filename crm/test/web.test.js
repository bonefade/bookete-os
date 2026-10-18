import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, initialState } from "../src/web/store.js";
import { TABS, tabBar, todayView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView, filterBar } from "../src/web/views.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";
import { formInput, saveLeadForm, pickLostReason, routeOf, parseRoute, enterRoute, backRoute, recordMissing, createNavigation, mountApp } from "../src/web/controller.js";
import { describeChange, fmtDate } from "../src/web/format.js";
import { scoped, activitiesByLead, freshLeads } from "../src/web/selectors.js";
import { createApi, coalesced } from "../src/web/api.js";
import { COLLECTIONS, FIELD_LABEL, TRASH_SHOWN } from "../src/domain/constants.js";
import worker from "../src/server/index.js";
import { sha256 } from "../src/server/crypto.js";
import { createD1 } from "./d1.js";
import { IMPORT_CHUNK, BACKUP_FORMAT } from "../src/domain/backup.js";
import { readFileSync } from "node:fs";
import { searchLeads } from "../src/domain/search.js";
import { hitLabel } from "../src/web/search.js";
import { unsubscribeUrl } from "../src/server/unsubscribe.js";

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
    changesOpen: true, changes: { leadId: "L1", at: lead.updatedAt, rows: [{ seq: 2, at: "2026-10-15T10:00:00.000Z", actor: "jo@bookete.com (mcp)", deleted: false, before: v1, after: { ...v1, phone: "0664 2" } }, { seq: 1, at: "2026-10-15T09:00:00.000Z", actor: "jo@bookete.com (web)", deleted: false, before: null, after: v1 }] }, compose: { direction: "out", channel: "E-Mail", templateId: "T1", date: today, subject: "S", text: "Hallo", missing: [] } };
  const html = [tabBar, todayView, leadsView, searchView, templatesView, templateEditView, moreView, detailView, leadEditView].map((view) => view(state, today)).join("");
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
  // The compose hint names the unsubscribe link only where the mail gets one.
  assert.match(detailView(state, today), /Abmeldelink/);
  lead.status = "kunde";
  assert.doesNotMatch(detailView(state, today), /Abmeldelink/);
});

test("a Kundenakte contact's address opens no mail where an opt-out closes it, as the lead's own address; its name and address stay", () => {
  const today = "2026-10-15";
  const state = initialState();
  // The lead's own address (other case), an agency's, and one that another business with an opt-out holds.
  const account = { contacts: [{ id: "C1", name: "Anna Wirt", email: "Info@Krone.at" }, { id: "C2", name: "Agentur Blau", email: "office@blau.at" }, { id: "C3", name: "Max Grün", email: "max@gruen.at" }] };
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Gasthaus Krone", status: "qualifiziert", email: "info@krone.at", account };
  state.data = { leads: [lead, { ...LEAD_FIELDS, id: "L2", name: "Grün", status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", email: "MAX@gruen.at ", optOutAt: "2026-10-01" }], activities: [], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.caps = { db: true, gmail: false };
  state.ui = { ...state.ui, leadId: "L1" };
  const contacts = () => detailView(state, today).split("<h4>Kontakte</h4>")[1].split('<div class="l-feed">')[0];
  const mailsTo = (address) => contacts().includes(`href="mailto:${address}"`);
  assert.deepEqual(["Info@Krone.at", "office@blau.at", "max@gruen.at"].map(mailsTo), [true, true, false]);
  assert.match(contacts(), /<b>Max Grün<\/b><br>max@gruen\.at/);
  // On the business with the opt-out, the contact at its address is closed with it; the agency's address is not.
  state.data.leads[0] = { ...lead, status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", optOutAt: "2026-10-02" };
  assert.deepEqual(["Info@Krone.at", "office@blau.at", "max@gruen.at"].map(mailsTo), [false, true, false]);
  assert.match(contacts(), /<b>Anna Wirt<\/b><br>Info@Krone\.at/);
  // A Kunde is not closed by another's opt-out; its own opt-out closes its own address.
  state.data.leads[0] = { ...lead, status: "kunde" };
  assert.deepEqual(["Info@Krone.at", "office@blau.at", "max@gruen.at"].map(mailsTo), [true, true, true]);
  state.data.leads[0] = { ...lead, status: "kunde", optOutAt: "2026-10-02" };
  assert.deepEqual(["Info@Krone.at", "office@blau.at", "max@gruen.at"].map(mailsTo), [false, true, true]);
});

test("the compose area says why no mail goes to an address another business with an opt-out holds, and no mail link opens one", () => {
  const today = "2026-10-15";
  const state = initialState();
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Gasthaus Krone", status: "neu", email: "info@krone.at" };
  state.data = { leads: [lead, { ...LEAD_FIELDS, id: "L2", name: "Krone", status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", email: "Info@Krone.at", optOutAt: "2026-10-01" }], activities: [], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.caps = { db: true, gmail: true };
  state.ui = { ...state.ui, leadId: "L1", compose: { direction: "out", channel: "E-Mail", templateId: "", date: today, subject: "S", text: "Hallo", missing: [] } };
  const html = detailView(state, today);
  assert.match(html, /Keine E-Mail an diese Adresse: \u201EKrone\u201C hat dieselbe Adresse und ein Opt-out seit 01\.10\.2026/);
  assert.doesNotMatch(html, /Per Gmail senden/);
  // Nor is it logged as sent, nor copied: the composer offers only Abbrechen.
  assert.doesNotMatch(html, /data-act="(logActivity|copyOpen)"/);
  assert.match(html, /data-act="composeCancel">Abbrechen/);
  // Nor does a link open a mail to it, in the composer or the action row, with Gmail or without; as on the lead that holds the opt-out.
  assert.doesNotMatch(html, /mailto:/);
  state.caps = { db: true, gmail: false };
  assert.doesNotMatch(detailView(state, today), /mailto:|data-act="logActivity"/);
  assert.doesNotMatch(detailView({ ...state, ui: { ...state.ui, leadId: "L2", compose: null } }, today), /mailto:/);
  // Only mail is closed: another channel shows nothing and is logged as sent.
  state.ui.compose = { ...state.ui.compose, channel: "Telefon" };
  assert.doesNotMatch(detailView(state, today), /Keine E-Mail an diese Adresse/);
  assert.match(detailView(state, today), /class="primary" data-act="logActivity">Gesendet/);
  state.ui.compose = { ...state.ui.compose, channel: "E-Mail" };
  // A Kunde's service mail is not closed by another's opt-out; its own opt-out closes its mail link.
  state.data.leads[0] = { ...lead, status: "kunde" };
  assert.match(detailView(state, today), /href="mailto:info@krone\.at[^"]*"[^>]*>Kopieren und \xF6ffnen/);
  state.data.leads[0] = { ...lead, status: "kunde", optOutAt: "2026-10-02" };
  assert.doesNotMatch(detailView({ ...state, ui: { ...state.ui, compose: null } }, today), /mailto:/);
  // Its own opt-out arriving by sync while the composer is open: it says so and names no other business; no send,
  // no log, no copy.
  const own = detailView(state, today);
  assert.match(own, /<p>Keine Kontaktaufnahme gew\xFCnscht<\/p><p class="note">Seit 02\.10\.2026\.<\/p>/);
  assert.doesNotMatch(own, /dieselbe Adresse|Per Gmail senden|data-act="(logActivity|copyOpen)"|mailto:/);
  state.data.leads[0] = lead;
  state.data.leads[1] = { ...state.data.leads[1], email: "post@krone.at" };
  assert.match(detailView(state, today), /href="mailto:info@krone\.at[^"]*"[^>]*>Kopieren und \xF6ffnen/);
  assert.match(detailView({ ...state, ui: { ...state.ui, compose: null } }, today), /<button data-compose="E-Mail">E-Mail</);
  state.caps = { db: true, gmail: true };
  assert.match(detailView(state, today), /Per Gmail senden/);
});

test("with Gmail connected, mail that gets the Abmeldelink goes out only by Gmail; without Gmail, and to a Kunde, also by the mail program", () => {
  const today = "2026-10-15";
  const state = initialState();
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert", email: "k@example.at", phone: "0664 123" };
  state.data = { leads: [lead], activities: [], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.caps = { db: true, gmail: true };
  const compose = (channel) => ({ direction: "out", channel, templateId: "", date: today, subject: "S", text: "Hallo", missing: [] });
  state.ui = { ...state.ui, leadId: "L1", compose: compose("E-Mail") };
  const composeCard = () => detailView(state, today).split('class="card compose"')[1].split("<aside")[0];
  const viaGmail = composeCard();
  assert.match(viaGmail, /Per Gmail senden/);
  assert.doesNotMatch(viaGmail, /mailto:|data-act="copyOpen"/);
  // The action row opens the composer, never the mail program.
  const actionRow = detailView({ ...state, ui: { ...state.ui, compose: null } }, today).split('class="acts"')[1].split("</div>")[0];
  assert.match(actionRow, /<button data-compose="E-Mail">E-Mail<\/button>/);
  assert.doesNotMatch(detailView(state, today), /mailto:/);
  state.caps = { db: true, gmail: false };
  assert.match(composeCard(), /href="mailto:k@example\.at[^"]*"[^>]*>Kopieren und öffnen/);
  // A Kunde's service mail gets no Abmeldelink, so its mailto stays next to Gmail.
  state.caps = { db: true, gmail: true };
  state.data.leads[0] = { ...lead, status: "kunde" };
  assert.match(composeCard(), /Per Gmail senden/);
  assert.match(composeCard(), /href="mailto:k@example\.at[^"]*"[^>]*>Kopieren und öffnen/);
  // Other channels have no Gmail path and keep their link.
  state.data.leads[0] = lead;
  state.ui = { ...state.ui, compose: compose("WhatsApp") };
  assert.match(composeCard(), /href="https:\/\/wa\.me\/0664123[^"]*"[^>]*>Kopieren und öffnen/);
});

test("with Gmail connected, a Kundenakte contact at the lead's own address opens no mail program; one at another address, which Gmail does not send to, still does", () => {
  const today = "2026-10-15";
  const state = initialState();
  const account = { contacts: [{ id: "C1", name: "Anna Wirt", email: "K@Example.at" }, { id: "C2", name: "Agentur Blau", email: "office@blau.at" }] };
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "qualifiziert", email: "k@example.at", account };
  state.data = { leads: [lead], activities: [], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.caps = { db: true, gmail: true };
  state.ui = { ...state.ui, leadId: "L1" };
  const contacts = () => detailView(state, today).split("<h4>Kontakte</h4>")[1].split('<div class="l-feed">')[0];
  const mailsTo = (address) => contacts().includes(`href="mailto:${address}"`);
  assert.deepEqual(["K@Example.at", "office@blau.at"].map(mailsTo), [false, true]);
  assert.match(contacts(), /<b>Anna Wirt<\/b><br>K@Example\.at/);
  // Without Gmail, and on a Kunde (no Abmeldelink), the mail program is the way, as for the lead's own links.
  state.caps = { db: true, gmail: false };
  assert.deepEqual(["K@Example.at", "office@blau.at"].map(mailsTo), [true, true]);
  state.caps = { db: true, gmail: true };
  state.data.leads[0] = { ...lead, status: "kunde" };
  assert.deepEqual(["K@Example.at", "office@blau.at"].map(mailsTo), [true, true]);
});

test("Heute is one queue: new answers, then overdue, then due today with the leads in work that have no next step", () => {
  const today = "2026-10-15";
  const state = initialState();
  const lead = (id, name, followUp, extra = {}) => ({ ...LEAD_FIELDS, id, name, status: "kontaktiert", contactedAt: "2026-10-01", followUp, ...extra });
  const act = (id, leadId, date, direction, text) => ({ id, leadId, date, direction, channel: "E-Mail", text, createdAt: date + "T09:00:00.000Z" });
  state.data = {
    leads: [
      lead("L1", "Alt", "2026-10-12", { nextStep: "Termin 13:30 bestätigen" }),
      lead("L2", "Heutig", today),
      lead("L3", "Später", "2026-10-20"),
      lead("L4", "Abgeschlossen", "2026-10-01", { status: "disqualifiziert", lostReason: "Kein Bedarf" }),
      lead("L5", "Onboarding", today, { status: "kunde" }),
      lead("L6", "Ungeplant", null),
      // Answered and overdue: it shows once, as an answer.
      lead("L7", "Antwortet", "2026-10-13"),
      // Answered, then written to again: the answer is no longer the newest, so nothing waits on it.
      lead("L8", "Beantwortet", "2026-10-20"),
      lead("L9", "Neu", null, { status: "neu", contactedAt: null }),
    ],
    activities: [act("A1", "L7", "2026-10-01", "out", "Hallo"), act("A2", "L7", "2026-10-14", "in", "Was kostet das?\nGrüße"), act("A3", "L8", "2026-10-13", "in", "Gern"), act("A4", "L8", "2026-10-14", "out", "Danke")],
    templates: [], settings: [],
  };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  const html = todayView(state, today);
  const rows = (title) => [...(html.split(`<h3>${title} <small>`)[1] ?? "").split("</ul>")[0].matchAll(/data-queue="(\w+)"/g)].map(([, id]) => id);
  assert.deepEqual([rows("Neue Antworten"), rows("\xDCberf\xE4llig"), rows("Heute f\xE4llig")], [["L7"], ["L1"], ["L2", "L5", "L6"]]);
  assert.match(html, /<span class="q-name">Antwortet<\/span><span class="q-ch">E-Mail<\/span><span class="q-why">„Was kostet das\?“<\/span><span class="q-go">Antworten ›/);
  assert.match(html, /<span class="q-why">Termin 13:30 bestätigen · fällig seit 3 Tagen<\/span><span class="q-go">Öffnen ›/);
  assert.match(html, /<span class="q-name">Ungeplant<\/span><span class="q-ch none">Kein n\xE4chster Schritt<\/span>[^]*?Planen ›/);
  assert.match(html, /5 offen<\/p><\/div><button class="primary" data-act="queueStart">Abarbeiten ›/);
  // The tab's badge counts the queue; Todos is no tab any more.
  assert.match(tabBar(state, today, false), /data-tab="heute"[^]*?<span class="badge">5<\/span>/);
  assert.doesNotMatch(tabBar(state, today, false), /todos/);
});

test("the lead page marks a lead in work with no next step, and only that one", () => {
  const page = (lead) => detailView(stateWith([{ id: "L1", name: "Krone", ...lead }], { leadId: "L1" }), TODAY);
  assert.match(page({ status: "kontaktiert", contactedAt: "2026-10-01" }), /<div class="next lacks"><span><b>Kein n\xE4chster Schritt<\/b>/);
  assert.match(page({ status: "qualifiziert", contactedAt: "2026-10-01" }), /class="next lacks"/);
  assert.match(page({ status: "kontaktiert", contactedAt: "2026-10-01", followUp: "2026-10-14" }), /<div class="next due"><span>N\xE4chster Schritt: f\xE4llig seit gestern/);
  for (const lead of [{ status: "neu" }, { status: "kunde" }, { status: "kontaktiert", contactedAt: "2026-10-01", followUp: "2026-10-20" }]) assert.doesNotMatch(page(lead), /next lacks|Kein n\xE4chster Schritt/, lead.status);
});

test("the forms, the lead page, the list and search name a field as FIELD_LABEL does", () => {
  const today = "2026-10-15";
  const state = initialState();
  state.data = { leads: [{ ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert", person: "Maria Huber", notes: "Ruhetag Montag" }], activities: [], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  // Search reads its labels once, when it loads, so it is checked by the labels themselves. It used to say "Person" and "Notiz".
  const hitLabel = (gq) => searchView({ ...state, ui: { ...state.ui, gq } }, today).match(/class="s-hit"><b>([^<]*)</)[1];
  assert.equal(hitLabel("maria"), "Ansprechperson");
  assert.equal(hitLabel("ruhetag"), "Notizen");
  // Labels no screen writes out, so a label written out again shows the old text and fails.
  const renamed = Object.fromEntries(Object.keys(FIELD_LABEL).map((key) => [key, `Feld ${key}`]));
  const saved = { ...FIELD_LABEL };
  Object.assign(FIELD_LABEL, renamed);
  try {
    const form = leadEditView(state);
    for (const key of ["name", "city", "type", "region", "status", "fit", "lostReason", "instagram", "phone", "email", "website", "person", "currentTool", "hook", "notes"])
      assert.match(form, new RegExp(`>Feld ${key}( \\*)?<(input|select|textarea) name="${key}"`), key);
    const quick = leadsView({ ...state, ui: { ...state.ui, quick: { name: "", city: "", instagram: "", hook: "" } } }, today);
    for (const [key, id] of [["name", "qaName"], ["city", "qaCity"], ["instagram", "qaIg"], ["hook", "qaHook"]])
      assert.match(quick, new RegExp(`>Feld ${key}( \\*)?<input id="${id}"`), key);
    const page = detailView({ ...state, ui: { ...state.ui, leadId: "L1", nextEdit: true, statusMenu: true } }, today);
    assert.match(page, />Feld nextStep<input id="nextStep"/);
    assert.match(page, />Feld followUp<\/label>/);
    assert.match(page, /<input type="date" id="fu"[^>]*aria-label="Feld followUp"/);
    assert.match(page, /<b>Feld status direkt setzen …<\/b>/);
    assert.match(page, /<h3>Feld notes<\/h3>/);
    const list = leadsView(state, today);
    const head = list.match(/<li class="lhead"[^>]*>([^]*?)<\/li>/)[1];
    assert.deepEqual([...head.matchAll(/<span>([^<]*)<\/span>/g)].map(([, s]) => s).slice(2, 5), ["Feld city", "Feld status", "Feld nextStep"]);
    assert.match(list, /data-filter="region" aria-label="Feld region"/);
    assert.match(list, /data-filter="status" aria-label="Feld status"/);
    assert.match(leadsView({ ...state, ui: { ...state.ui, status: "disqualifiziert" } }, today), /data-filter="reason" aria-label="Feld lostReason"/);
  } finally {
    Object.assign(FIELD_LABEL, saved);
  }
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
  state.ui = { ...state.ui, leadId: "L1", changesOpen: true, changes: { leadId: "L1", at: lead.updatedAt, rows: [entry({ ...lead, updatedAt: "later" })] } };
  assert.match(detailView(state, "2026-10-15"), /data-act="changesToggle">\xC4nderungen an Feldern ausblenden/);
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

test("search ranks a name prefix over a word in the name over a substring, then other fields; equal hits by pipeline, then fit, then name", () => {
  const data = (leads) => ({ data: { leads: leads.map((l, i) => ({ ...LEAD_FIELDS, id: `L${i}`, ...l })), activities: [] } });
  const names = (state, q) => searchLeads(state, q).map((r) => r.lead.name);
  // The three names sort the other way round, so a tie broken by name cannot pass for this order.
  assert.deepEqual(names(data([{ name: "Seewirt", person: "Maria Krone" }, { name: "Alte Schlosskrone" }, { name: "Gasthaus Krone" }, { name: "Kronenwirt" }]), "krone"),
    ["Kronenwirt", "Gasthaus Krone", "Alte Schlosskrone", "Seewirt"]);
  // Every lead matches only by its city, so the score is the same.
  const graz = [["Adler", "disqualifiziert", 3], ["Berghof", "neu", 1], ["Dorfwirt", "neu", 3], ["Eck", "kontaktiert", 2], ["Café Anna", "kontaktiert", 3]];
  assert.deepEqual(names(data(graz.map(([name, status, fit]) => ({ name, status, fit, city: "Graz", lostReason: status === "disqualifiziert" ? "Kein Bedarf" : null }))), "graz"),
    ["Café Anna", "Dorfwirt", "Eck", "Berghof", "Adler"]);
});

test("search finds a phone number by its digits; of equal hits in the history it shows the newest, headed by its day and channel", () => {
  const leads = [{ ...LEAD_FIELDS, id: "L1", name: "Krone", phone: "+43 316 123456" }, { ...LEAD_FIELDS, id: "L2", name: "Seewirt" }];
  const activities = [
    { id: "A2", leadId: "L2", date: "2026-10-08", channel: "E-Mail", direction: "in", text: "Die Speisekarte schicken wir", createdAt: "2026-10-08T09:00:00.000Z" },
    { id: "A1", leadId: "L2", date: "2026-10-01", channel: "E-Mail", direction: "out", text: "Ihre Speisekarte gefällt uns", createdAt: "2026-10-01T09:00:00.000Z" },
  ];
  const state = { data: { leads, activities } };
  const [phone] = searchLeads(state, "0316/123456");
  assert.deepEqual([phone.lead.id, phone.hit.key], ["L1", "phone"]);
  const [history, ...rest] = searchLeads(state, "speisekarte");
  assert.deepEqual([history.lead.id, history.hit.act.id, rest.length], ["L2", "A2", 0]);
  assert.equal(hitLabel(history.hit), `Verlauf ${fmtDate("2026-10-08")} \xB7 Antwort`);
  assert.equal(hitLabel(searchLeads(state, "gefällt")[0].hit), `Verlauf ${fmtDate("2026-10-01")} \xB7 E-Mail`);
});

test("a lead's history is in timeline order, by day and then by when it was written, whatever order it was read in", () => {
  const act = (id, leadId, date, createdAt) => ({ id, leadId, date, channel: "E-Mail", direction: "out", text: "x", createdAt });
  const activities = [act("A3", "L1", "2026-10-08", "2026-10-08T12:00:00.000Z"), act("B1", "L2", "2026-10-02", "2026-10-02T09:00:00.000Z"), act("A1", "L1", "2026-10-01", "2026-10-09T09:00:00.000Z"), act("A2", "L1", "2026-10-08", "2026-10-08T09:00:00.000Z")];
  const byLead = activitiesByLead({ data: { leads: [], activities } });
  assert.deepEqual(byLead.get("L1").map((a) => a.id), ["A1", "A2", "A3"]);
  assert.deepEqual(byLead.get("L2").map((a) => a.id), ["B1"]);
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

test("Heute offers the new leads to write to first, the best first", async () => {
  const leads = [
    { ...LEAD_FIELDS, id: "L1", name: "Frisch", status: "neu", fit: 1 },
    { ...LEAD_FIELDS, id: "L2", name: "Dran", status: "kontaktiert", contactedAt: "2026-10-01", followUp: "2026-10-20" },
    { ...LEAD_FIELDS, id: "L3", name: "Besser", status: "neu", fit: 3 },
  ];
  assert.match(todayView(stateWith(leads), TODAY), /Bereit zum Anschreiben <small>2<\/small><\/h3><p class="note"[^>]*>2 neue Betriebe ohne Kontakt, die besten zuerst\.<\/p><button class="full" data-act="freshStart">/);
  assert.match(todayView(stateWith(leads.slice(0, 2)), TODAY), />1 neuer Betrieb ohne Kontakt/);
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    store.data("leads", leads);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    const { h, click } = fakeBrowser("#/heute", store, {});
    await click({ act: "freshStart" });
    assert.equal(h.location.hash, "#/betrieb/L3");
    await click({ act: "roundNext" });
    assert.equal(h.location.hash, "#/betrieb/L1");
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

test("the lead view: the status chip opens the usual moves and setting it directly, the reason picker, and since when the lead is contacted", () => {
  const lead = { id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-12" };
  const view = detailView(stateWith([lead], { leadId: "L1" }), TODAY);
  assert.match(view, /<button class="pill" data-act="statusMenu" aria-expanded="false">Kontaktiert ▾<\/button>/);
  assert.doesNotMatch(view, /data-status=|data-act="optOut"/);
  const menu = detailView(stateWith([lead], { leadId: "L1", statusMenu: true }), TODAY);
  assert.deepEqual([...menu.matchAll(/class="mitem[^"]*" data-act="(\w+)"/g)].map((m) => m[1]), ["callTermin", "lostPick", "closeWithoutReply", "statusDirect", "optOut"]);
  // Ohne Antwort abschließen waits for the last of the five contacts.
  assert.match(menu, /data-act="closeWithoutReply" disabled>/);
  const direct = detailView(stateWith([lead], { leadId: "L1", statusMenu: "direct" }), TODAY);
  assert.deepEqual([...direct.matchAll(/data-status="([^"]+)"/g)].map((m) => m[1]), ["neu", "kontaktiert", "qualifiziert", "kunde", "disqualifiziert"]);
  assert.match(view, /seit Mo\., 12\. Okt\./);
  assert.doesNotMatch(view, /data-lost=/);
  const picking = detailView(stateWith([lead], { leadId: "L1", lostPick: true }), TODAY);
  assert.equal([...picking.matchAll(/data-lost="/g)].length, 7);
  assert.match(picking, /Warum disqualifiziert\?/);
  assert.match(picking, /data-act="lostCancel"/);
  const fresh = detailView(stateWith([{ id: "L2", name: "Frisch", status: "neu" }], { leadId: "L2" }), TODAY);
  assert.match(fresh, /Nie kontaktiert/);
  const closed = detailView(stateWith([{ id: "L3", name: "Zu", status: "disqualifiziert", lostReason: "Zu klein" }], { leadId: "L3" }), TODAY);
  assert.match(closed, /Disqualifiziert \xB7 Zu klein ▾/);
  assert.match(detailView(stateWith([{ id: "L3", name: "Zu", status: "disqualifiziert", lostReason: "Zu klein" }], { leadId: "L3", statusMenu: true, nextEdit: true }), TODAY), /data-act="lostPick"><span><b>Grund \xE4ndern<\/b><small>Zu klein/);
  assert.doesNotMatch(closed, /id="fu"|class="next/);
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
  // A bare start, an unknown tab and a broken escape all open Heute; so does the search screen's address before 1.15.0,
  // as the search now opens over a screen and has none, and the Todos tab's before 1.17.0, as Heute took them in.
  for (const hash of ["", "#", "#/", "#/gibts-nicht", "#/betrieb/%E0", "#/suche", "#/todos"]) assert.deepEqual(parseRoute(hash), { view: null, tab: "heute" }, hash);
});

test("entering an address resets what belongs to the screen left, and keeps the rest", () => {
  const ui = { ...initialState().ui, tab: "betriebe", q: "krone", quick: true, icpEdit: true, searchOpen: true, compose: { text: "x" }, lostPick: true, trash: [{}], scroll: { betriebe: 300 } };
  const lead = enterRoute(ui, parseRoute("#/betrieb/L1"));
  assert.deepEqual([lead.view, lead.leadId, lead.tab, lead.compose, lead.lostPick, lead.q], ["detail", "L1", "betriebe", null, false, "krone"]);
  // The quick-add form and the ICP form show on their own tab only, so any address closes them, and the search too.
  assert.deepEqual([lead.quick, lead.icpEdit, lead.searchOpen], [false, false, false]);
  // Back from the edit form to the same lead keeps its open compose box.
  const again = enterRoute({ ...ui, view: "editLead", leadId: "L1" }, parseRoute("#/betrieb/L1"));
  assert.deepEqual(again.compose, { text: "x" });
  const mehr = enterRoute(ui, parseRoute("#/mehr"));
  assert.deepEqual([mehr.view, mehr.tab, mehr.quick, mehr.trash], [null, "mehr", false, null]);
  assert.deepEqual(enterRoute({ ...ui, tab: "mehr" }, parseRoute("#/mehr")).trash, [{}]);
});

test("the in-app back button goes to the screen above", () => {
  assert.equal(backRoute({ tab: "heute", view: "detail", leadId: "L1" }), "#/heute");
  assert.equal(backRoute({ tab: "heute", view: "editLead", leadId: "L1" }), "#/betrieb/L1");
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
  // What the test typed into the Kundenakte form, by field name; a checkbox takes true or false.
  const typed = {};
  // The search over the screen, and its result list, which the top bar's field fills. A search drawn whole draws
  // its list too, as the browser does from the markup.
  const results = { innerHTML: "" };
  let searchHtml = "";
  const search = {
    hidden: true,
    // How often the search was drawn whole, which would put its result list back at the top.
    drawn: 0,
    get innerHTML() {
      return searchHtml;
    },
    set innerHTML(html) {
      search.drawn++;
      searchHtml = results.innerHTML = html;
    },
    querySelector: (sel) => (sel === "#sres" && searchHtml.includes('id="sres"') ? results : null),
    // The rows of the result list, which the field's arrow keys and Enter go through.
    querySelectorAll: (sel) => sel === "#sres .srow" ? [...results.innerHTML.matchAll(/class="srow[^"]*" data-open="([^"]+)"/g)].map(([, open]) => ({ dataset: { open }, classList: { toggle() {} }, scrollIntoView() {} })) : [],
  };
  // The screen's own listeners: what is typed and changed in its fields.
  const rootOn = {};
  const focused = [];
  const root = {
    innerHTML: "",
    addEventListener: (type, f) => (rootOn[type] = f),
    contains: () => false,
    querySelector: (sel) => {
      // Name in + Neu and the list filter, drawn: a focus asked for is counted.
      if (sel === "#qaName" || sel === "#q") return root.innerHTML.includes(`id="${sel.slice(1)}"`) ? { focus: () => focused.push(sel), setSelectionRange() {} } : null;
      if (!root.innerHTML.includes("<form")) return null;
      // The Kundenakte form with its drawn fields; any other form with none: the use case fakes take whatever it holds.
      if (sel === "#aform") return { elements: formElements(root.innerHTML, typed) };
      return sel === "form" || sel === "#form" ? { elements: [] } : null;
    },
  };
  Object.assign(globalThis, {
    history: h.history,
    location: h.location,
    window: { scrollY: 0, scrollTo() {}, addEventListener: (type, f) => type === "popstate" && h.onPop(f) },
    document: { activeElement: null, addEventListener: (type, f) => (on[type] = f) },
    confirm: () => true,
  });
  const toastEl = { classList: { add() {}, remove() {} } };
  // The search field in the top bar, outside the screen; focus() fires a focus handler if there is one, as a browser does.
  const field = { value: "", disabled: false, on: {}, addEventListener(type, f) { field.on[type] = f; }, focus() { field.on.focus?.(); }, select() {}, blur() {} };
  const tabsEl = { innerHTML: "" };
  const app = mountApp({ root, tabsEl, searchEl: field, searchBox: search, toastEl, store, clock: { today: () => "2026-10-15" } });
  // A lead page loads its history on open; for a test's use cases that have none it stays on its way, so nothing
  // draws after the test.
  app.connect(uc && { history: () => new Promise(() => {}), ...uc });
  const click = (dataset) => on.click({ target: { closest: () => ({ dataset }) } });
  const type = (text) => {
    field.value = text;
    field.on.input();
  };
  const press = (key, mods = {}) => on.keydown({ key, target: { tagName: "BODY" }, preventDefault() {}, ...mods });
  const input = (id, value) => rootOn.input({ target: { id, value } });
  const change = (target) => rootOn.change({ target: { dataset: {}, ...target } });
  return { h, root, app, click, press, input, change, typed, toastEl, field, type, results, search, tabsEl, focused };
}
/** A drawn form's fields as form.elements holds them, by position and by name, with what the test typed over them. */
function formElements(html, typed = {}) {
  const attr = (tag, name) => tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1];
  const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);
  const fields = [
    ...[...html.matchAll(/<input([^>]*)>/g)].map(([, tag]) => ({ name: attr(tag, "name"), value: unesc(attr(tag, "value") ?? ""), checked: false })),
    ...[...html.matchAll(/<select name="([^"]*)">([^]*?)<\/select>/g)].map(([, name, opts]) => ({ name, value: unesc((opts.match(/<option value="([^"]*)" selected>/) ?? opts.match(/<option value="([^"]*)"/))[1]) })),
    ...[...html.matchAll(/<textarea name="([^"]*)"[^>]*>([^]*?)<\/textarea>/g)].map(([, name, text]) => ({ name, value: unesc(text) })),
  ];
  for (const f of fields) if (f.name in typed) typeof typed[f.name] === "boolean" ? (f.checked = typed[f.name]) : (f.value = typed[f.name]);
  return Object.assign(fields, Object.fromEntries(fields.map((f) => [f.name, f])));
}
/** The Worker with jo@bookete.com signed in, as the browser's fetch: a browser test that talks to the real server. */
async function signedInFetch() {
  const DB = createD1();
  await DB.batch([
    DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('jo@bookete.com', 'Jo', 'now')"),
    DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("jo"), Date.now() + 1e6),
  ]);
  const env = { DB, AUTH_LIMIT: { limit: async () => ({ success: true }) }, PUBLIC_URL: "https://crm.bookete.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", TOKEN_KEY: btoa("k".repeat(32)), CONSENT_SECRET: "c".repeat(32), ALLOWED_EMAILS: "jo@bookete.com" };
  return (url, init = {}) => worker.fetch(new Request("https://crm.bookete.com" + url, { ...init, headers: { ...init.headers, Cookie: "__Host-crm-session=jo" } }), { ...env, DB: DB.invocation() }, { waitUntil() {} });
}

// A full chunk of activities is the import's costliest request, close to D1's cap. The server takes no more records
// in one request, whichever collections they are in; the client's chunks stay within that.
test("an import request takes at most a full chunk, and a full chunk of activities, of a live and a deleted lead, stays within D1's queries", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  try {
    globalThis.fetch = await signedInFetch();
    const api = createApi(async () => {});
    const live = await api.addLead({ name: "Krone" });
    const trashed = await api.addLead({ name: "Linde" });
    await api.deleteLead({ id: trashed });
    const activities = Array.from({ length: IMPORT_CHUNK }, (_, i) => ({ id: `A${i}`, leadId: i % 2 ? trashed : live, direction: "in", channel: "E-Mail", date: "2026-10-01", text: `Antwort ${i}` }));
    const backup = { format: BACKUP_FORMAT, data: { activities, templates: [{ id: "T1", name: "Erstkontakt", purpose: "erstkontakt", body: "Hallo" }] } };
    const whole = await fetch("/api/rpc/importBackup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ backup }) });
    assert.equal(whole.status, 400);
    assert.equal(await api.importBackup(backup, "2026-10-15"), IMPORT_CHUNK + 1);
    await api.restoreLead(trashed);
    assert.equal((await api.changes(0)).changes.filter((c) => c.collection === "activities").length, IMPORT_CHUNK);
  } finally {
    Object.defineProperty(globalThis, "fetch", saved);
  }
});

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

test("four tabs, at the bottom on a phone and on the left from tablet width, and the one search field in the top bar", () => {
  assert.deepEqual([...tabBar(initialState(), "2026-10-15", false).matchAll(/data-tab="(\w+)"/g)].map(([, k]) => k), ["heute", "betriebe", "vorlagen", "mehr"]);
  assert.doesNotMatch(tabBar(initialState(), "2026-10-15", false), /disabled/);
  assert.equal(tabBar(initialState(), "2026-10-15", true).match(/ disabled>/g).length, TABS.length);
  const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(page, new RegExp(`\\.tabs \\.in\\{[^}]*repeat\\(${TABS.length},1fr\\)`));
  // From tablet width, if tall enough for the tabs, a rail on the left, under the top bar, with the screens, the
  // search and the toast right of it; never hidden. A shut tab takes no click on its icon or label.
  const wide = page.match(/@media \(min-width:760px\) and \(min-height:480px\)\{\n  :root\{--rail:[^]*?\n\}/)?.[0] ?? "";
  for (const rule of [/\.tabs\{top:calc\(env\(safe-area-inset-top,0px\) \+ var\(--topbar\)\);right:auto;width:var\(--rail\)/, /\.tabs \.in\{display:flex;flex-direction:column\}/, /#app\{margin-left:var\(--rail\)\}/, /\.sbox\{left:var\(--rail\);bottom:0\}/, /\.toast\{[^}]*left:calc\(50% \+ var\(--rail\) \/ 2\)\}/]) assert.match(wide, rule);
  assert.match(page, /\.tab:disabled\{pointer-events:none\}/);
  assert.doesNotMatch(page, /\.tabs\[hidden\]/);
  assert.match(page, /<header class="brandbar">[^]*<input type="search" id="gq"[^]*<\/header>/);
  // The search's own box, shut until the field opens it.
  assert.match(page, /<div class="sbox" id="sbox" hidden><\/div>/);
  assert.match(page, /\.sbox\[hidden\]\{display:none\}/);
  // With the tabs at the bottom it ends above them, by their own height, so a result picked by key never hides under them.
  assert.match(page, /\.tab\{[^}]*min-height:var\(--tabbar\);/);
  assert.match(page, /\.sbox\{position:fixed;left:0;right:0;bottom:calc\(var\(--tabbar\) \+ 1px \+ env\(safe-area-inset-bottom,0px\)\);/);
  // At 320px "CRM" makes room for the whole placeholder.
  assert.match(page, /@media \(max-width:359px\)\{\.brand \.sub\{display:none\}\}/);
  // While it shows, neither the click into the field, a key typed, nor a wheel or swipe outside it scrolls the screen under it.
  assert.match(page, /#gq\{scroll-margin-top:calc\(-1 \* \(env\(safe-area-inset-top,0px\) \+ var\(--topbar\) \+ 64px\)\)\}/);
  assert.match(page, /html\{scroll-padding-top:calc\(env\(safe-area-inset-top,0px\) \+ var\(--topbar\) \+ 64px\);/);
  assert.match(page, /html:has\(#sbox:not\(\[hidden\]\)\)\{scroll-padding-top:0;overflow:hidden\}/);
  // The top bar stays in view while results scroll; a lead page's or form's own bar sticks right under it.
  assert.match(page, /\.brandbar\{position:sticky;top:0;[^}]*background:var\(--bg\);height:calc\(env\(safe-area-inset-top,0px\) \+ var\(--topbar\)\)/);
  assert.match(page, /\.bar\{position:sticky;top:calc\(env\(safe-area-inset-top,0px\) \+ var\(--topbar\)\)/);
  assert.doesNotMatch(searchView(initialState(), "2026-10-15"), /<input/);
  // The Betriebe list's own field filters that list, so it says so and does not read as a second search.
  const placeholder = (html, id) => html.match(new RegExp(`id="${id}" placeholder="([^"]*)"`))[1];
  assert.deepEqual([placeholder(page, "gq"), placeholder(leadsView(initialState(), "2026-10-15"), "q")], ["Suchen …", "Liste filtern …"]);
});

test("the tabs show on every screen, shut while a form holds input; a lead page's tab leads to its screen", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    store.data("leads", [{ ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert" }]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    const { h, click, tabsEl } = fakeBrowser("#/betriebe", store, {});
    const tabs = () => [(tabsEl.innerHTML.match(/data-tab=/g) || []).length, (tabsEl.innerHTML.match(/ disabled>/g) || []).length, tabsEl.innerHTML.match(/data-tab="(\w+)" aria-current/)?.[1]];
    assert.deepEqual(tabs(), [4, 0, "betriebe"]);
    await click({ open: "L1" });
    assert.deepEqual([h.location.hash, ...tabs()], ["#/betrieb/L1", 4, 0, "betriebe"]);
    // A message being written holds input as a form does.
    await click({ compose: "E-Mail" });
    assert.deepEqual(tabs(), [4, 4, "betriebe"]);
    await click({ act: "composeCancel" });
    assert.deepEqual(tabs(), [4, 0, "betriebe"]);
    await click({ act: "edit" });
    assert.deepEqual([h.location.hash, ...tabs()], ["#/betrieb/L1/bearbeiten", 4, 4, "betriebe"]);
    h.history.go(-1);
    h.land();
    // The tab the lead page was opened from opens its screen, not the top of the lead page.
    await click({ tab: "betriebe" });
    assert.deepEqual([h.location.hash, ...tabs()], ["#/betriebe", 4, 0, "betriebe"]);
    await click({ act: "quick" });
    assert.deepEqual(tabs(), [4, 4, "betriebe"]);
    await click({ act: "quickCancel" });
    await click({ tab: "vorlagen" });
    await click({ act: "tplNew" });
    assert.deepEqual([h.location.hash, ...tabs()], ["#/vorlage/neu", 4, 4, "vorlagen"]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
test("a lead page opened by a link or a reload belongs to Betriebe; one opened from Heute keeps Heute", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const ready = () => {
    const store = createStore(initialState());
    store.data("leads", [{ ...LEAD_FIELDS, id: "L1", name: "Krone", status: "neu" }]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    return store;
  };
  const current = (tabsEl) => tabsEl.innerHTML.match(/data-tab="(\w+)" aria-current/)?.[1];
  try {
    const linked = fakeBrowser("#/betrieb/L1", ready(), {});
    assert.equal(current(linked.tabsEl), "betriebe");
    await linked.click({ tab: "betriebe" });
    assert.equal(linked.h.location.hash, "#/betriebe");
    const fromHeute = fakeBrowser("#/heute", ready(), {});
    await fromHeute.click({ open: "L1" });
    assert.deepEqual([fromHeute.h.location.hash, current(fromHeute.tabsEl)], ["#/betrieb/L1", "heute"]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
test("the top bar's field opens the search over any screen, which stays as it is, first with the recently changed leads", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const lead = (id, name, updatedAt) => ({ ...LEAD_FIELDS, id, name, status: "kontaktiert", updatedAt });
  const ready = (store) => {
    store.data("leads", [lead("L1", "Krone", "2026-10-14T09:00:00.000Z"), lead("L2", "Linde", "2026-10-15T09:00:00.000Z")]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
  };
  try {
    const store = createStore(initialState());
    ready(store);
    const { h, root, app, click, field, type, results, search } = fakeBrowser("#/betriebe", store, {});
    const betriebe = root.innerHTML;
    // Focus alone, as by Tab or on coming back to the window, opens nothing.
    field.focus();
    assert.equal(search.hidden, true);
    // A click opens the search over Betriebe: the address and the screen under it stay.
    field.on.click();
    assert.deepEqual([h.location.hash, search.hidden, root.innerHTML, root.inert], ["#/betriebe", false, betriebe, true]);
    assert.match(results.innerHTML, /Zuletzt bearbeitet[^]*data-open="L2"[^]*data-open="L1"/);
    type("krone");
    assert.match(results.innerHTML, /1 Treffer[^]*data-open="L1"/);
    assert.doesNotMatch(results.innerHTML, /data-open="L2"/);
    // A click into the field on the results keeps the query, also through the next redraw.
    const drawn = search.drawn;
    field.on.click();
    app.onDataChanged();
    assert.deepEqual([field.value, store.get().ui.gq, root.innerHTML, search.drawn], ["krone", "krone", betriebe, drawn]);
    assert.match(results.innerHTML, /1 Treffer[^]*data-open="L1"/);
    // The browser's Back closes the search and leaves the screen under it as it is, not drawn again; Forward opens it again.
    root.innerHTML = "the screen as it was";
    h.history.go(-1);
    h.land();
    assert.deepEqual([h.location.hash, field.value, search.hidden, root.innerHTML, h.seen().at], ["#/betriebe", "", true, "the screen as it was", 0]);
    h.history.go(1);
    h.land();
    assert.deepEqual([h.location.hash, search.hidden, root.innerHTML], ["#/betriebe", false, "the screen as it was"]);
    root.innerHTML = betriebe;
    // A result opens its lead in place of the search's entry; Back shows Betriebe, with the search shut.
    await click({ open: "L1" });
    assert.deepEqual([h.location.hash, field.value, search.hidden], ["#/betrieb/L1", "", true]);
    assert.deepEqual(h.seen(), { at: 1, entries: [["#/betriebe", null], ["#/betrieb/L1", 1]] });
    h.history.go(-1);
    h.land();
    assert.deepEqual([h.location.hash, field.value, search.hidden], ["#/betriebe", "", true]);
    // Schließen, or the dimmed screen around the search, shuts it as Back does and leaves the screen as it was.
    field.on.click();
    type("kr");
    await click({ act: "searchClose" });
    h.land();
    assert.deepEqual([h.location.hash, field.value, store.get().ui.gq, search.hidden, root.inert, h.seen().at], ["#/betriebe", "", "", true, false, 0]);
    // Each time it opens, it starts over.
    field.on.click();
    assert.equal(field.value, "");
    assert.match(results.innerHTML, /Zuletzt bearbeitet/);
    // The tab already shown shuts it and keeps its screen; another tab shuts it too.
    await click({ tab: "betriebe" });
    h.land();
    assert.deepEqual([h.location.hash, search.hidden], ["#/betriebe", true]);
    field.on.click();
    await click({ tab: "heute" });
    assert.deepEqual([h.location.hash, search.hidden], ["#/heute", true]);
    assert.deepEqual(h.seen(), { at: 1, entries: [["#/betriebe", null], ["#/heute", 1]] });
    // Typing into the field while the search is shut, as after Back, opens it with what is typed.
    type("lin");
    assert.deepEqual([h.location.hash, field.value, search.hidden], ["#/heute", "lin", false]);
    assert.match(results.innerHTML, /1 Treffer[^]*data-open="L2"/);
    // A result for the lead already shown shuts the search too, leaving no second entry of that lead behind.
    await click({ open: "L2" });
    field.on.click();
    await click({ open: "L2" });
    h.land();
    assert.deepEqual([h.location.hash, search.hidden], ["#/betrieb/L2", true]);
    // Behind it only the search's own entry, now a step Forward.
    const { at, entries } = h.seen();
    assert.deepEqual([at, entries.slice(0, at + 1)], [2, [["#/betriebe", null], ["#/heute", 1], ["#/betrieb/L2", 2]]]);
    // A lead picked in the search ends a round, as a tab does.
    store.ui({ round: { list: "calls", seen: [] } });
    field.on.click();
    await click({ open: "L1" });
    assert.deepEqual([h.location.hash, store.get().ui.round], ["#/betrieb/L1", null]);
    h.history.go(-1);
    h.land();
    // A form holds unsaved input, so search is shut there.
    assert.equal(field.disabled, false);
    await click({ act: "edit" });
    assert.equal(field.disabled, true);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
test("the field's keys: the arrows pick a result and Enter opens it; Escape empties the field, then shuts the search", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    store.data("leads", ["Krone", "Kronenhof", "Linde"].map((name, i) => ({ ...LEAD_FIELDS, id: `L${i + 1}`, name, status: "kontaktiert" })));
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    const { h, click, field, type, results, search } = fakeBrowser("#/heute", store, {});
    let blurs = 0;
    field.blur = () => blurs++;
    const key = (k) => field.on.keydown({ key: k, preventDefault() {} });
    field.on.click();
    // Only spaces typed: the recently changed leads show, and Enter opens none of them.
    type("  ");
    assert.match(results.innerHTML, /Zuletzt bearbeitet[^]*data-open/);
    key("Enter");
    assert.deepEqual([h.location.hash, search.hidden], ["#/heute", false]);
    type("kron");
    const rows = [...results.innerHTML.matchAll(/data-open="([^"]+)"/g)].map(([, id]) => id);
    assert.equal(rows.length, 2);
    key("ArrowDown");
    assert.equal(store.get().ui.sIdx, 1);
    key("ArrowUp");
    assert.equal(store.get().ui.sIdx, 0);
    key("ArrowDown");
    key("Enter");
    assert.deepEqual([h.location.hash, blurs, search.hidden], [`#/betrieb/${rows[1]}`, 1, true]);
    h.history.go(-1);
    h.land();
    field.on.click();
    type("kron");
    key("Escape");
    assert.deepEqual([field.value, store.get().ui.gq, blurs, search.hidden], ["", "", 1, false]);
    assert.match(results.innerHTML, /Zuletzt bearbeitet/);
    key("Escape");
    h.land();
    assert.deepEqual([h.location.hash, blurs, search.hidden], ["#/heute", 2, true]);
    // With the search shut, as after Back or Tab into the field, Escape only leaves the field and stays on the screen.
    await click({ open: rows[1] });
    key("Escape");
    h.land();
    assert.deepEqual([h.location.hash, blurs, search.hidden], [`#/betrieb/${rows[1]}`, 3, true]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
test("a step over several entries that lands on the search's entry shows its screen with the search open", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    for (const c of ["leads", "activities", "templates", "settings"]) store.data(c, []);
    const { h, field, click, search, root } = fakeBrowser("#/heute", store, {});
    await click({ tab: "betriebe" });
    field.on.click();
    h.history.go(-2);
    h.land();
    assert.deepEqual([h.location.hash, search.hidden], ["#/heute", true]);
    h.history.go(2);
    h.land();
    assert.deepEqual([h.location.hash, search.hidden, root.inert], ["#/betriebe", false, true]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
test("the search closes without a connection to the database", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    for (const c of ["leads", "activities", "templates", "settings"]) store.data(c, []);
    const { h, field, click, search, toastEl } = fakeBrowser("#/heute", store, null);
    let toasts = 0;
    toastEl.classList.add = () => toasts++;
    field.on.click();
    await click({ act: "searchClose" });
    h.land();
    assert.deepEqual([search.hidden, toasts], [true, 0]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
test("while the lead page holds unsaved input the field is shut, and it opens again once the lead is left", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    store.data("leads", [
      { ...LEAD_FIELDS, id: "L1", name: "Krone", phone: "+43 1 234", status: "kontaktiert", contactedAt: "2026-10-01" },
      { ...LEAD_FIELDS, id: "L2", name: "Linde", status: "qualifiziert", contactedAt: "2026-10-01", followUp: "2026-10-15", nextStep: "Termin 10 Uhr" },
    ]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    const { h, click, press, field, search } = fakeBrowser("#/heute", store, {});
    // The outcome forms of a call and of an appointment take a typed date, time, reason or note.
    await click({ open: "L1" });
    // The open call sheet holds nothing yet; a picked outcome does.
    await click({ act: "callOpen" });
    assert.equal(field.disabled, false);
    await click({ call: "rueckruf" });
    assert.equal(field.disabled, true);
    await click({ act: "callCancel" });
    assert.equal(field.disabled, false);
    await click({ edit: "notes" });
    assert.equal(field.disabled, true);
    await click({ act: "qeCancel" });
    assert.equal(field.disabled, false);
    await click({ act: "back" });
    h.land();
    await click({ open: "L2" });
    await click({ meeting: "neuer-termin" });
    assert.equal(field.disabled, true);
    await click({ act: "back" });
    h.land();
    await click({ open: "L1" });
    await click({ compose: "E-Mail" });
    assert.equal(field.disabled, true);
    // Nor do / and Ctrl+K jump into it, and the keys keep their own meaning, such as Ctrl+K in a text field.
    let prevented = 0;
    for (const [key, mods] of [["/"], ["k", { ctrlKey: true }]]) {
      press(key, { ...mods, preventDefault: () => prevented++ });
      assert.deepEqual([h.location.hash, field.disabled, search.hidden, prevented], ["#/betrieb/L1", true, true, 0], key);
    }
    // Zurück leaves the lead and its message, so the field and / work on every screen after it.
    await click({ act: "back" });
    h.land();
    assert.deepEqual([h.location.hash, field.disabled], ["#/heute", false]);
    await click({ tab: "vorlagen" });
    assert.equal(field.disabled, false);
    press("/");
    assert.deepEqual([h.location.hash, search.hidden], ["#/vorlagen", false]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

test("the quick-add form on Betriebe and the ICP form on Mehr shut the field while they show", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    store.data("leads", [{ ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-01" }]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    const added = [];
    const icps = [];
    const uc = { addLead: async (lead) => (added.push(lead), "L9"), saveIcp: async (icp) => icps.push(icp) };
    const { h, root, app, click, input, change, field, search, focused } = fakeBrowser("#/betriebe", store, uc);
    // What is typed into + Neu is drawn back by every redraw under it: a sync, the sort, a filter. Forward onto the
    // search's entry steps off it again, so the search stays shut and Back leaves the page; Hinzufügen saves what was typed.
    field.on.click();
    h.history.go(-1);
    h.land();
    await click({ act: "quick" });
    // Name takes the focus as + Neu opens, and only then: typing into the list filter keeps it there.
    input("q", "kr");
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(focused, ["#q", "#qaName"]);
    input("q", "");
    input("qaName", "Neuer Wirt");
    input("qaCity", "Graz");
    app.onDataChanged();
    change({ id: "sort", value: "name" });
    change({ dataset: { filter: "status" }, value: "neu" });
    h.history.go(1);
    h.land();
    assert.match(root.innerHTML, /id="qaName" autocomplete="off" value="Neuer Wirt"/);
    assert.match(root.innerHTML, /id="qaCity" value="Graz"/);
    assert.equal(search.hidden, true);
    assert.equal(h.seen().at, 0);
    await click({ act: "quickSave" });
    assert.deepEqual(added, [{ name: "Neuer Wirt", city: "Graz", instagram: "", hook: "" }]);
    // The next search opens on one entry, and one Back shuts it.
    field.on.click();
    assert.equal(search.hidden, false);
    h.history.go(-1);
    h.land();
    assert.deepEqual([search.hidden, h.seen().at], [true, 0]);
    await click({ act: "quick" });
    assert.equal(field.disabled, true);
    // The search stays shut by every way in, the list's hits outside its filters too, whose button is shut as well.
    store.ui({ status: "neu", q: "krone" });
    assert.match(leadsView(store.get(), "2026-10-15"), /data-act="toSearch" disabled>1 weitere/);
    await click({ act: "toSearch" });
    assert.equal(search.hidden, true);
    store.ui({ status: "offen", q: "" });
    await click({ act: "quickCancel" });
    assert.equal(field.disabled, false);
    // A lead opened from the list while the form is open has nothing to lose, and Back shows the list without the form.
    await click({ act: "quick" });
    await click({ open: "L1" });
    assert.deepEqual([h.location.hash, field.disabled], ["#/betrieb/L1", false]);
    h.history.go(-1);
    h.land();
    assert.deepEqual([h.location.hash, field.disabled], ["#/betriebe", false]);
    assert.doesNotMatch(root.innerHTML, /id="qaName"/);
    await click({ tab: "mehr" });
    await click({ act: "icpEdit" });
    assert.equal(field.disabled, true);
    // The ICP form too keeps what was typed through a sync, and saves it.
    input("icpFit", "Neu eröffnet\nAbends");
    app.onDataChanged();
    assert.match(root.innerHTML, /<textarea id="icpFit" rows="7">Neu eröffnet\nAbends<\/textarea>/);
    await click({ act: "icpSave" });
    assert.deepEqual(icps.map(({ fit, noFit }) => [fit, noFit]), [[["Neu eröffnet", "Abends"], [""]]]);
    await click({ act: "icpEdit" });
    await click({ act: "icpCancel" });
    assert.equal(field.disabled, false);
    // Another tab closes the ICP form, so the field is open there, and back on Mehr the form is closed.
    await click({ act: "icpEdit" });
    await click({ tab: "heute" });
    assert.equal(field.disabled, false);
    await click({ tab: "mehr" });
    assert.doesNotMatch(root.innerHTML, /id="icpFit"/);
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

test("a sync asked for while one runs waits for one that starts after it", async () => {
  const done = [];
  let n = 0;
  const sync = coalesced(async () => {
    const run = n++;
    await new Promise((r) => setTimeout(r, 1));
    done.push(run);
    if (run === 0) throw new Error("offline");
  });
  const first = sync();
  const second = sync();
  assert.equal(sync(), second);
  await assert.rejects(first);
  // The first run failing does not stop the one asked for after it.
  await second;
  assert.deepEqual(done, [0, 1]);
});

test("the Kundenakte form saves through the server what it showed, reopens at once with the save, and drops a contact", async () => {
  const saved = ["history", "location", "window", "document", "confirm", "fetch"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    globalThis.fetch = await signedInFetch();
    const store = createStore(initialState());
    let browser = null;
    // The live sync, a moment late as over a network.
    const api = createApi(async () => {
      await new Promise((r) => setTimeout(r, 5));
      const { changes } = await api.changes(0);
      for (const c of COLLECTIONS) store.data(c, changes.filter((x) => x.collection === c).map((x) => x.record));
      browser?.app.onDataChanged();
    });
    const id = await api.addLead({ name: "Krone", status: "kunde" });
    browser = fakeBrowser(`#/betrieb/${id}`, store, api);
    const { h, root, click, typed } = browser;
    const shown = () => JSON.parse(formElements(root.innerHTML).before.value);
    const stored = async () => (await api.changes(0)).changes.find((c) => c.id === id).record.account;
    const save = async (fields) => {
      await click({ act: "accountEdit" });
      for (const k of Object.keys(typed)) delete typed[k];
      Object.assign(typed, fields);
      await click({ act: "accountSave" });
      h.land();
    };
    await save({ "systems.domain.what": "krone.at", "contacts.0.name": "Max Muster" });
    // Opened again at once, the form holds the save, so the next save is not refused as over a changed Kundenakte.
    await click({ act: "accountEdit" });
    const max = shown().contacts[0];
    assert.deepEqual([shown().systems.domain.what, max.name], ["krone.at", "Max Muster"]);
    await save({ "systems.domain.by": max.id });
    assert.equal((await stored()).systems.domain.by, max.id);
    // The form sends every system's "betreut von", so removing Max there also clears who runs the domain.
    await save({ "contacts.0.drop": true });
    const a = await stored();
    assert.deepEqual([a.contacts, a.systems.domain], [[], { what: "krone.at", by: "" }]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

test("the Papierkorb pages back through the server, and a restore or erase keeps the page", async () => {
  const saved = ["history", "location", "window", "document", "confirm", "fetch"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    globalThis.fetch = await signedInFetch();
    const api = createApi(async () => {});
    const ids = [];
    for (let i = 0; i < TRASH_SHOWN + 2; i++) {
      const id = await api.addLead({ name: `Betrieb ${i}` });
      await api.deleteLead({ id });
      ids.push(id);
    }
    // The oldest and the last on the first page are opted out by the link while in the trash: written last, each stays on the
    // page its deletion puts it on, and the page boundary stays where the deletions put it.
    for (const id of [ids[0], ids[2]]) {
      const link = new URL(await unsubscribeUrl({ PUBLIC_URL: "https://crm.bookete.com", CONSENT_SECRET: "c".repeat(32) }, id));
      assert.equal((await fetch(link.pathname, { method: "POST" })).status, 200);
    }
    const store = createStore(initialState());
    for (const c of COLLECTIONS) store.data(c, []);
    const { root, click } = fakeBrowser("#/mehr", store, api);
    const shown = () => [...root.innerHTML.matchAll(/data-restore="([^"]+)"/g)].map(([, id]) => id);
    const newest = ids.slice(2).reverse();
    await click({ act: "showTrash" });
    assert.deepEqual(shown(), newest);
    await click({ act: "trashOlder", before: root.innerHTML.match(/data-act="trashOlder" data-before="(\d+)"/)[1] });
    assert.deepEqual(shown(), [ids[1], ids[0]]);
    await click({ restore: ids[0] });
    assert.deepEqual(shown(), [ids[1]]);
    await click({ purge: ids[1] });
    assert.match(root.innerHTML, /Keine \xE4lteren gel\xF6schten Betriebe/);
    assert.match(root.innerHTML, /data-act="showTrash">Zu den neuesten</);
    // Exactly a page is left: no "Ältere anzeigen" that would open an empty page.
    await click({ act: "showTrash" });
    assert.deepEqual([shown(), /trashOlder/.test(root.innerHTML)], [newest, false]);
    assert.equal(newest.length, TRASH_SHOWN);
    assert.equal((await fetch("/api/trash?before=x")).status, 400);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

test("the call list: due calls first by date then fit, then new businesses by fit; no phone, opt-out or appointment, no call", async () => {
  const { callList } = await import("../src/web/selectors.js");
  const today = "2026-10-15";
  const state = initialState();
  const l = (id, extra) => ({ ...LEAD_FIELDS, id, name: id, phone: "+43 1", status: "kontaktiert", contactedAt: "2026-10-01", ...extra });
  state.data.leads = [
    l("neu2", { status: "neu", contactedAt: null, fit: 2 }), l("neu3", { status: "neu", contactedAt: null, fit: 3 }),
    l("due14", { followUp: "2026-10-14", fit: 1 }), l("due13", { followUp: "2026-10-13" }), l("due14fit3", { followUp: "2026-10-14", fit: 3 }),
    l("later", { followUp: "2026-10-20" }), l("nophone", { followUp: today, phone: "" }), l("kunde", { status: "kunde", followUp: today }),
    l("termin", { status: "qualifiziert", followUp: today, nextStep: "Termin um 10:00" }), l("rueckruf", { status: "qualifiziert", followUp: today, nextStep: "R\xFCckruf" }),
  ];
  assert.deepEqual(callList(state, today).map((x) => x.id), ["due13", "due14fit3", "due14", "rueckruf", "neu3", "neu2"]);
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  assert.match(todayView(state, today), /Anrufliste <small>6<\/small><\/h3><p class="note"[^>]*>Am besten 14:30–17:00 Uhr, Montag und Dienstag schw\xE4cher\.<\/p><button class="primary full" data-act="callStart">/);
});

test("the lead page asks how a call ended, and what saving does, and on the appointment's day how the appointment went", () => {
  const today = "2026-10-15";
  const state = initialState();
  const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", phone: "+43 1 234", status: "kontaktiert", contactedAt: "2026-10-01" };
  state.data.leads = [lead];
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  state.ui = { ...state.ui, view: "detail", leadId: "L1" };
  let html = detailView(state, today);
  // Anrufen dials and opens the call sheet; no sheet before.
  assert.match(html, /<a class="btn" href="tel:\+431234" data-act="callOpen">Anrufen<\/a>/);
  assert.doesNotMatch(html, /data-call=|roundNext|agDate|Wie war der Termin/);
  state.ui = { ...state.ui, call: {} };
  html = detailView(state, today);
  assert.match(html, /href="tel:\+431234">\+43 1 234 anrufen/);
  assert.deepEqual([...html.matchAll(/data-call="([^"]+)"/g)].map((m) => m[1]), ["nicht-erreicht", "rueckruf", "termin", "kein-interesse"]);
  assert.match(html, /data-act="callSave" disabled>Speichern</);
  assert.doesNotMatch(html, /Beim Speichern/);
  // Each outcome says before saving what it does to the status and the next step.
  state.ui = { ...state.ui, call: { outcome: "nicht-erreicht" } };
  assert.match(detailView(state, today), /Beim Speichern: Status bleibt Kontaktiert · N\xE4chster Schritt Sa\., 17\. Okt\.</);
  state.ui = { ...state.ui, call: { outcome: "termin", date: "2026-10-20", time: "10:00" }, round: { list: "calls", seen: [] } };
  html = detailView(state, today);
  assert.match(html, /id="agDate" min="2026-10-15" value="2026-10-20"/);
  assert.match(html, /Beim Speichern: Status wird Qualifiziert · N\xE4chster Schritt Di\., 20\. Okt\. · Termin um 10:00</);
  assert.match(html, /data-act="callSave">Speichern und weiter ›/);
  assert.match(html, /data-act="roundNext"/);
  state.ui = { ...state.ui, call: { outcome: "kein-interesse", reason: "Zu klein" } };
  html = detailView(state, today);
  assert.match(html, /id="agReason"/);
  assert.match(html, /Beim Speichern: Status wird Disqualifiziert \(Zu klein\) · kein n\xE4chster Schritt/);
  assert.doesNotMatch(html, /<option value="Nicht erreicht">/);
  state.data.leads = [{ ...lead, status: "qualifiziert", followUp: today, nextStep: "Termin" }];
  html = detailView(state, today);
  assert.match(html, /Wie war der Termin\?/);
  assert.doesNotMatch(html, /data-call=/);
  assert.match(html, /data-act="roundNext"/);
  state.data.leads = [{ ...lead, status: "disqualifiziert", lostReason: "Zu klein" }];
  html = detailView(state, today);
  assert.doesNotMatch(html, /data-call=|Wie war der Termin/);
  assert.match(html, /data-act="roundNext"/);
});

test("a round shows where it stands; Weiter opens the next in place of this page, past those seen, then the round ends; Später moves the follow-up and goes on", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const l = (id, fit) => ({ ...LEAD_FIELDS, id, name: id, phone: "+43 1", status: "neu", fit });
  try {
    const store = createStore(initialState());
    store.data("leads", [l("A", 3), l("B", 2), l("C", 1)]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    const { h, root, click, toastEl } = fakeBrowser("#/heute", store, {});
    await click({ act: "callStart" });
    const at = () => [store.get().ui.leadId, h.seen()];
    const page = (id) => ({ at: 1, entries: [["#/heute", null], [`#/betrieb/${id}`, 1]] });
    assert.deepEqual(at(), ["A", page("A")]);
    assert.match(root.innerHTML, /<span class="q-pos"><b>Anrufliste<\/b> · 1 von 3<\/span>/);
    await click({ act: "roundNext" });
    assert.deepEqual(at(), ["B", page("B")]);
    assert.match(root.innerHTML, /<b>Anrufliste<\/b> · 2 von 3/);
    await click({ act: "roundNext" });
    assert.deepEqual(at(), ["C", page("C")]);
    await click({ act: "roundNext" });
    h.land();
    assert.deepEqual([toastEl.textContent, store.get().ui.view, store.get().ui.tab, store.get().ui.round], ["Liste erledigt", null, "heute", null]);

    // In Heute's queue, a row starts the round at its lead; Später sets the follow-up and opens the next.
    const queue = createStore(initialState());
    const due = (id, followUp) => ({ ...LEAD_FIELDS, id, name: id, status: "kontaktiert", contactedAt: "2026-10-01", followUp });
    queue.data("leads", [due("Q1", "2026-10-13"), due("Q2", "2026-10-14"), due("Q3", "2026-10-15")]);
    for (const c of ["activities", "templates", "settings"]) queue.data(c, []);
    const set = [];
    const b = fakeBrowser("#/heute", queue, { setFollowUp: async (lead, date) => set.push([lead.id, date]) });
    await b.click({ queue: "Q2" });
    assert.equal(queue.get().ui.leadId, "Q2");
    assert.match(b.root.innerHTML, /<b>Heute · \xDCberf\xE4llig<\/b> · 2 von 3/);
    await b.click({ act: "later" });
    assert.match(b.root.innerHTML, /data-later="1">Morgen[^]*data-later="7">N\xE4chste Woche[^]*id="laterDate"/);
    await b.click({ later: "7" });
    assert.deepEqual([set, queue.get().ui.leadId, queue.get().ui.later], [[["Q2", "2026-10-22"]], "Q3", false]);
    b.change({ id: "laterDate", value: "2026-11-02" });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(set.at(-1), ["Q3", "2026-11-02"]);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

test("the opt-out reason in the picker asks first, as the Opt-out button does; another reason does not", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const OPT_OUT = "Keine Kontaktaufnahme gew\xFCnscht";
  const calls = [];
  const uc = { changeStatus: async (lead, status, reason) => calls.push(reason) };
  try {
    const store = createStore(initialState());
    store.data("leads", [{ ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert" }]);
    for (const c of ["activities", "templates", "settings"]) store.data(c, []);
    const { click } = fakeBrowser("#/betrieb/L1", store, uc);
    const asked = [];
    let answer = false;
    globalThis.confirm = (text) => (asked.push(text), answer);
    await click({ status: "disqualifiziert" });
    await click({ lost: OPT_OUT });
    assert.deepEqual([calls, store.get().ui.lostPick], [[], true]);
    answer = true;
    await click({ lost: OPT_OUT });
    await click({ status: "disqualifiziert" });
    await click({ lost: "Zu klein" });
    assert.deepEqual(calls, [OPT_OUT, "Zu klein"]);
    assert.equal(asked.length, 2);
    assert.match(asked[0], /^\u201EKrone\u201C m\xF6chte keine Nachrichten mehr\?/);
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});

test("a write asked for again while it is on its way is sent once; a different one goes out at once", async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = (url, init) => new Promise((answer) => sent.push({ url, body: init.body, answer }));
  try {
    const api = createApi(() => {});
    const lead = { id: "L1" };
    const first = api.logCall(lead, { outcome: "nicht-erreicht" });
    const again = api.logCall(lead, { outcome: "nicht-erreicht" });
    const other = api.setNextStep(lead, "Vor 15 Uhr");
    assert.deepEqual(sent.map((x) => x.url), ["/api/rpc/logCall", "/api/rpc/setNextStep"]);
    for (const x of sent) x.answer(new Response(JSON.stringify({ result: x.url })));
    assert.deepEqual(await Promise.all([first, again, other]), ["/api/rpc/logCall", "/api/rpc/logCall", "/api/rpc/setNextStep"]);
    // Once answered, the next tap is a new call.
    api.logCall(lead, { outcome: "nicht-erreicht" });
    assert.equal(sent.length, 3);
    sent[2].answer(new Response("{}"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a round lasts while moving between leads and ends on a tab; an open outcome form belongs to its lead and ends with it", () => {
  const ui = { ...initialState().ui, view: "detail", leadId: "L1", call: { outcome: "termin" }, meeting: { result: "kunde" }, round: { list: "calls", seen: ["L0"] }, statusMenu: true, later: true };
  const next = enterRoute(ui, parseRoute("#/betrieb/L2"));
  assert.deepEqual([next.call, next.meeting, next.round, next.statusMenu, next.later], [null, null, { list: "calls", seen: ["L0"] }, false, false]);
  assert.deepEqual(enterRoute(ui, parseRoute("#/betrieb/L1/bearbeiten")).call, { outcome: "termin" });
  assert.equal(enterRoute(next, parseRoute("#/heute")).round, null);
  const left = enterRoute(ui, parseRoute("#/heute"));
  assert.deepEqual([left.call, left.meeting], [null, null]);
});

// Mail in a lead's feed, as the Gmail sync logs it: a sent mail in both mailboxes, then an answer only in Anna's.
const SUBJECT = "bookete – Tischreservierung";
const mail = (id, mailbox, extra) => ({ id, leadId: "L1", channel: "E-Mail", templateId: "", ...extra, mail: { gmailId: "g" + id, threadId: "T1", mailbox, subject: SUBJECT, from: "jo@bookete.com", to: "k@krone.at", ...extra.mail } });
const SENT = { direction: "out", date: "2026-10-10", createdAt: "2026-10-10T08:00:00.000Z", text: "Hallo Krone" };
const FEED = [
  mail("M1", "jo@bookete.com", SENT),
  mail("M2", "anna@bookete.com", { direction: "in", date: "2026-10-14", createdAt: "2026-10-14T09:00:00.000Z", text: "Was kostet das?", mail: { subject: "Re: " + SUBJECT, from: "k@krone.at", to: "anna@bookete.com" } }),
  { id: "C1", leadId: "L1", direction: "out", channel: "Telefon", date: "2026-10-12", createdAt: "2026-10-12T15:00:00.000Z", outcome: "nicht-erreicht", text: "" },
  { id: "W1", leadId: "L1", direction: "out", channel: "WhatsApp", date: "2026-10-11", createdAt: "2026-10-11T15:00:00.000Z", text: "Servus" },
];
const MOVED = { seq: 1, at: "2026-10-10T08:00:01.000Z", actor: "jo@bookete.com (web)", deleted: false, wasDeleted: false, before: { ...LEAD_FIELDS, status: "neu" }, after: { ...LEAD_FIELDS, status: "kontaktiert" } };

test("the feed groups mail by its thread and names a colleague's mailbox; the chips filter it, and status moves are grey lines", () => {
  const state = stateWith([{ id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-10", email: "k@krone.at", followUp: "2026-10-20" }], { leadId: "L1", changes: { leadId: "L1", rows: [MOVED] } });
  state.data.activities = FEED;
  state.me = { email: "jo@bookete.com" };
  const html = detailView(state, TODAY);
  assert.equal(html.match(/class="card thread"/g).length, 1);
  assert.match(html, /<div class="th-head"><b>Re: bookete – Tischreservierung<\/b><span class="pill new">Neue Antwort<\/span><\/div>\s*<p class="note"[^>]*>2 Nachrichten · Gmail · Postfach von anna<\/p>/);
  // The newest message open, from whom and in whose mailbox; the older one in a line.
  assert.match(html, /↙ Empfangen · k@krone\.at · Mi\., 14\. Okt\. · Postfach von anna/);
  assert.deepEqual([...html.matchAll(/data-expand="a:(M\w+)"/g)].map(([, id]) => id), ["M1"]);
  assert.match(html, /data-act="reply" data-thread="T1">Antworten/);
  // Newest first: the thread by its newest message, the call, the WhatsApp message, then the move to Kontaktiert.
  const order = ["card thread", "Anruf · Nicht erreicht", "↗ Gesendet · WhatsApp", 'class="sline">Sa., 10. Okt. · Status Neu → Kontaktiert'].map((s) => html.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), String(order));
  // The call is not the newest entry, so it cannot be taken back.
  assert.doesNotMatch(html, /data-undo/);
  assert.match(html, /data-feed="mail" aria-pressed="false">E-Mail <small>2<\/small>[^]*data-feed="call" aria-pressed="false">Anrufe <small>1<\/small>/);
  const only = (feed) => detailView({ ...state, ui: { ...state.ui, feed } }, TODAY);
  assert.doesNotMatch(only("mail"), /Anruf ·|WhatsApp ·|class="sline"/);
  assert.match(only("call"), /Anruf · Nicht erreicht/);
  assert.doesNotMatch(only("call"), /card thread|class="sline"/);
  assert.match(only("note"), /<h3>Notizen<\/h3>/);
  assert.doesNotMatch(only("note"), /card thread|Anruf ·/);
});

test("Rückgängig shows on the newest activity when it is a call, and never on an opted-out lead", () => {
  const lead = { id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-10", phone: "+43 1" };
  const call = (id, date) => ({ id, leadId: "L1", direction: "out", channel: "Telefon", date, createdAt: date + "T15:00:00.000Z", outcome: "nicht-erreicht", text: "" });
  const page = (l, activities) => {
    const state = stateWith([l], { leadId: "L1" });
    state.data.activities = activities;
    return [...detailView(state, TODAY).matchAll(/data-undo="(\w+)"/g)].map(([, id]) => id);
  };
  assert.deepEqual(page(lead, [call("C1", "2026-10-12"), call("C2", "2026-10-14")]), ["C2"]);
  assert.deepEqual(page(lead, [call("C1", "2026-10-12"), { ...call("N1", "2026-10-14"), channel: "E-Mail", outcome: null, text: "Hallo" }]), []);
  assert.deepEqual(page({ ...lead, status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", optOutAt: "2026-10-14" }, [call("C1", "2026-10-14")]), []);
});

test("the composer says what comes after: the sequence's next contact, the answer asked for, or the day picked", () => {
  const state = stateWith([{ id: "L1", name: "Krone", status: "neu", email: "k@krone.at" }], { leadId: "L1" });
  const compose = (c) => detailView({ ...state, ui: { ...state.ui, compose: { direction: "out", channel: "E-Mail", templateId: "", date: TODAY, subject: "S", text: "Hallo", missing: [], followUp: null, fuEdit: false, ...c } } }, TODAY).match(/<p class="note after">([^<]*)/)?.[1];
  assert.equal(compose({}), "Danach: Nachfassen So., 18. Okt. (+3 Tage, Kontakt 1 von 5) ");
  assert.equal(compose({ direction: "in" }), "Danach: Antworten, heute ");
  assert.equal(compose({ followUp: "2026-10-25" }), "Danach: Nachfassen So., 25. Okt. ");
});

test("Betriebe counts, filters and ranks a lead with mail only where its address is open", () => {
  const OPT_OUT = "Keine Kontaktaufnahme gew\xFCnscht";
  const leads = [
    { id: "L1", name: "Offen", status: "neu", email: "a@a.at" },
    { id: "L2", name: "Zu", status: "disqualifiziert", lostReason: OPT_OUT, optOutAt: "2026-10-01", email: "b@b.at" },
    // Another business at the closed address; a Kunde there still gets its service mail.
    { id: "L3", name: "Daneben", status: "neu", email: "B@b.at" },
    { id: "L4", name: "Kundin", status: "kunde", contactedAt: "2026-10-01", email: "b@b.at" },
  ];
  assert.match(leadsView(stateWith(leads, { status: "alle" }), TODAY), /4 Betriebe · 2 mit E-Mail/);
  assert.deepEqual(optionsOf(filterBar(stateWith(leads)), "contact").at(-1), "email mit E-Mail (2)");
  assert.deepEqual(scoped(stateWith(leads, { contact: "email" })).map((l) => l.id), ["L1", "L4"]);
  // Of two new businesses alike, the one that can be mailed first.
  assert.deepEqual(freshLeads(stateWith([leads[1], leads[2], leads[0]].map((l) => ({ ...l, fit: 1 })))).map((l) => l.id), ["L1", "L3"]);
});

test("Mehr says whether Gmail is connected, and asks to connect it again where it cannot read the answers", () => {
  const line = (caps) => moreView({ ...stateWith([]), caps: { db: true, ...caps }, me: { email: "jo@bookete.com" } }).match(/ · Gmail ([^]*?)<\/p>/)[1];
  assert.equal(line({ gmail: false, gmailRead: false }), 'nicht verbunden – <a href="/auth/login">neu anmelden</a>');
  assert.equal(line({ gmail: true, gmailRead: false }), 'verbunden – <a href="/auth/login">Gmail neu verbinden, damit Antworten erscheinen</a>');
  assert.equal(line({ gmail: true, gmailRead: true }), "verbunden");
});

test("the lead page loads its history once per version of the lead; Antworten writes in the thread, Rückgängig takes the call back, a note goes into Notizen, and after an opt-out E-Mail only writes a note", async () => {
  const saved = ["history", "location", "window", "document", "confirm"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  try {
    const store = createStore(initialState());
    const lead = { ...LEAD_FIELDS, id: "L1", name: "Krone", status: "kontaktiert", contactedAt: "2026-10-10", email: "k@krone.at", notes: "Ruhetag Mo", updatedAt: "v1" };
    store.data("leads", [lead]);
    const call = { id: "C9", leadId: "L1", direction: "out", channel: "Telefon", date: "2026-10-15", createdAt: "2026-10-15T15:00:00.000Z", outcome: "nicht-erreicht", text: "" };
    store.data("activities", [...FEED, call]);
    for (const c of ["templates", "settings"]) store.data(c, []);
    const done = [];
    const uc = {
      history: async (l) => (done.push(["history", l.id]), [MOVED]),
      undoCall: async (a) => done.push(["undoCall", a.id]),
      addNote: async (l, text) => done.push(["addNote", text]),
      sendEmail: async (l, msg) => done.push(["sendEmail", msg.subject, msg.replyTo]),
    };
    const { root, app, click, input } = fakeBrowser("#/betrieb/L1", store, uc);
    // The data arrives, as after the first sync; a redraw of the same version asks for nothing more.
    app.onDataChanged();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(root.innerHTML, /class="sline">Sa\., 10\. Okt\. · Status Neu → Kontaktiert/);
    app.onDataChanged();
    await new Promise((r) => setTimeout(r, 0));
    store.data("leads", [{ ...lead, updatedAt: "v2" }]);
    app.onDataChanged();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(done, [["history", "L1"], ["history", "L1"]]);
    await click({ undo: "C9" });
    assert.deepEqual(done.at(-1), ["undoCall", "C9"]);
    await click({ act: "reply", thread: "T1" });
    assert.deepEqual([store.get().ui.compose.channel, store.get().ui.compose.subject, store.get().ui.compose.direction], ["E-Mail", "Re: " + SUBJECT, "out"]);
    assert.match(root.innerHTML, /Antwort im Verlauf „Re: bookete – Tischreservierung“/);
    // Sent, it answers the thread's newest mail; a mail written fresh answers none.
    await click({ act: "sendEmail" });
    assert.deepEqual(done.at(-1), ["sendEmail", "Re: " + SUBJECT, "M2"]);
    await click({ compose: "E-Mail" });
    await click({ act: "sendEmail" });
    assert.equal(done.at(-1)[2], null);
    await click({ mode: "note" });
    input("cText", "Chef ist ab 15 Uhr da");
    await click({ act: "saveNote" });
    assert.deepEqual(done.at(-1), ["addNote", "Chef ist ab 15 Uhr da"]);
    // After an opt-out, E-Mail opens the composer for a note: nothing goes out to the business.
    store.data("leads", [{ ...lead, status: "disqualifiziert", lostReason: "Keine Kontaktaufnahme gew\xFCnscht", optOutAt: "2026-10-15", updatedAt: "v3" }]);
    app.onDataChanged();
    await click({ compose: "E-Mail" });
    assert.equal(store.get().ui.compose.direction, "note");
    // The new version's history arrives before the test ends.
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
