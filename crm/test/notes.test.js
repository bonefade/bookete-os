import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { BACKUP_FORMAT } from "../src/domain/backup.js";
import { notesFromText, notesOf, NOTE_LIMIT } from "../src/domain/notes.js";
import { initialState } from "../src/web/store.js";
import { detailView, unshownSheets } from "../src/web/views.js";
import { LEAD_FIELDS } from "../src/domain/lead.js";
import { SCHEMA_VERSION } from "../src/domain/constants.js";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };
function setup() {
  const store = createStore(createD1());
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)", email: "jo@bookete.com" });
  return { store, uc };
}
const mcp = async (context, name, args) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), context)).json()).result;

test("the notes text before 1.25.0 reads as entries: each dated paragraph a note of its day, the other paragraphs together the notes from before", () => {
  const text = "Nutzt Quandoo\n\n12.10.2026: Chef nicht da\n\n14.10.2026: Ruft zur\xFCck\n\nWebsite alt\n\n14.10.2026: Sp\xE4ter: ab 15 Uhr\n\n1.9.2026: Kurz";
  assert.deepEqual(notesFromText(text), [
    { id: "n6", date: "2026-09-01", by: "", text: "Kurz", createdAt: "" },
    { id: "n5", date: "2026-10-14", by: "", text: "Sp\xE4ter: ab 15 Uhr", createdAt: "" },
    { id: "n3", date: "2026-10-14", by: "", text: "Ruft zur\xFCck", createdAt: "" },
    { id: "n2", date: "2026-10-12", by: "", text: "Chef nicht da", createdAt: "" },
    { id: "n0", date: "", by: "", text: "Nutzt Quandoo\n\nWebsite alt", createdAt: "" },
  ]);
  // Read from a lead: newest first, of one day the later paragraph first, the undated last; nothing is cut.
  assert.deepEqual(notesOf({ notes: text }).map((n) => n.id), ["n5", "n3", "n2", "n6", "n0"]);
  const long = "x".repeat(19000);
  assert.equal(notesOf({ notes: `12.10.2026: ${long}` })[0].text, long);
  assert.deepEqual(notesOf({ notes: "" }), []);
  // The list and the text together; reading never fails, even with more than the limit or an id twice.
  const many = Array.from({ length: NOTE_LIMIT + 5 }, (_, i) => ({ id: `e${i}`, date: "2026-10-01", text: "x" }));
  assert.equal(notesOf({ noteEntries: [...many, many[0]], notes: "Alt" }).length, NOTE_LIMIT + 6);
});

test("adding a note leaves the text of before as it is; changing or removing one of its notes moves them all into the list", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone" });
  const before = await store.get("leads", id);
  await store.commit([{ type: "patch", collection: "leads", id, base: before, data: { notes: "Alt\n\n12.10.2026: Chef nicht da" } }], "test");
  await uc.changeNote(id, { add: "Neu" });
  let l = await store.get("leads", id);
  assert.deepEqual([l.notes, l.noteEntries.map((n) => n.text)], ["Alt\n\n12.10.2026: Chef nicht da", ["Neu"]]);
  await uc.changeNote(id, { note: "n2", text: "Chef erst ab Mittwoch" });
  l = await store.get("leads", id);
  assert.deepEqual([l.notes, l.noteEntries.map((n) => [n.id, n.date, n.text])], ["", [["id2", "2026-10-15", "Neu"], ["n2", "2026-10-12", "Chef erst ab Mittwoch"], ["n0", "", "Alt"]]]);
  await uc.changeNote(id, { note: "n0", remove: true });
  assert.deepEqual((await store.get("leads", id)).noteEntries.map((n) => n.id), ["id2", "n2"]);
  assert.equal(await uc.changeNote(id, { note: "n0", remove: true }), false);
  // The same text again writes nothing.
  const rows = (await store.history(id)).length;
  assert.equal(await uc.changeNote(id, { note: "n2", text: "Chef erst ab Mittwoch" }), false);
  assert.equal((await store.history(id)).length, rows);
});

test("agents read all notes as one list and add one by giving text; null or empty text changes none; the web command takes a note, its text or its removal", async () => {
  const { store, uc } = setup();
  const context = { store, clock, uc };
  const id = await uc.addLead({ name: "Krone", notes: "Erste" });
  const l0 = await store.get("leads", id);
  await store.commit([{ type: "patch", collection: "leads", id, base: l0, data: { notes: "12.10.2026: Von fr\xFCher" } }], "test");
  assert.ok(!(await mcp(context, "update_lead", { id, fields: { notes: "Zweite" } })).isError);
  for (const notes of [null, "", "  "]) assert.ok(!(await mcp(context, "update_lead", { id, fields: { notes, phone: "1" } })).isError);
  const got = JSON.parse((await mcp(context, "get_lead", { id })).content[0].text).lead;
  assert.deepEqual(got.notes.map((n) => [n.text, n.by, n.date]), [["Zweite", "jo@bookete.com", "2026-10-15"], ["Erste", "jo@bookete.com", "2026-10-15"], ["Von fr\xFCher", "", "2026-10-12"]]);
  assert.equal("noteEntries" in got, false);
  // A note as long as the notes text could be is kept whole.
  const long = "y".repeat(20000);
  assert.ok(!(await mcp(context, "update_lead", { id, fields: { notes: long } })).isError);
  assert.equal((await store.get("leads", id)).noteEntries[0].text, long);
  const parse = (args) => COMMANDS.changeNote[0].safeParse(args).success;
  assert.deepEqual([parse({ id, add: "x" }), parse({ id, note: "n1", text: "x" }), parse({ id, note: "n1", remove: true }), parse({ id, add: "" }), parse({ id, note: "n1" }), parse({ id, add: "x", by: "anna@bookete.com" }), parse({ id, add: "z".repeat(20001) })], [true, true, true, false, false, false, false]);
});

test("a note of the text of before longer than any note written stays whole, moved into the list and after; all notes together have a cap, which never stops a shortening", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Lang" });
  const before = await store.get("leads", id);
  const old = "x".repeat(15000) + "\n\n12.10.2026: Chef\n\n" + "y".repeat(15000);
  await store.commit([{ type: "patch", collection: "leads", id, base: before, data: { notes: old } }], "test");
  await uc.changeNote(id, { note: "n2", text: "Chef ab Mittwoch" });
  await uc.changeNote(id, { add: "Neu" });
  const undated = notesOf(await store.get("leads", id)).find((n) => n.id === "n0");
  assert.equal(undated.text.length, 30002);
  const total = await uc.addLead({ name: "Voll" });
  const t = await store.get("leads", total);
  await store.commit([{ type: "patch", collection: "leads", id: total, base: t, data: { noteEntries: Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, date: "2026-10-01", text: "z".repeat(20000) })) } }], "test");
  await assert.rejects(uc.changeNote(total, { add: "Eine mehr" }), { message: "Die Notizen sind zu lang. Bitte k\xFCrzen oder alte l\xF6schen." });
  await uc.changeNote(total, { note: "t0", text: "kurz" });
  await uc.changeNote(total, { note: "t1", remove: true });
  assert.equal((await store.get("leads", total)).noteEntries.length, 20);
});

test("a page of 1.24.0 still open adds a note with its old command", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone" });
  await COMMANDS.addNote[1](uc, COMMANDS.addNote[0].parse({ id, text: "Von der alten Seite" }));
  assert.deepEqual((await store.get("leads", id)).noteEntries.map((n) => n.text), ["Von der alten Seite"]);
});

test("at most 300 notes, the text's included; a backup's notes, as text or as a list, come in as they were", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Voll" });
  const before = await store.get("leads", id);
  const full = Array.from({ length: NOTE_LIMIT - 1 }, (_, i) => ({ id: `f${i}`, date: "2026-10-01", by: "", text: `Notiz ${i}` }));
  await store.commit([{ type: "patch", collection: "leads", id, base: before, data: { noteEntries: full, notes: "Alt" } }], "test");
  await assert.rejects(uc.changeNote(id, { add: "Eine mehr" }), { message: `H\xF6chstens ${NOTE_LIMIT} Notizen` });
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ ...LEAD_FIELDS, schemaVersion: SCHEMA_VERSION, id: "B1", name: "Alt", notes: "12.10.2026: Chef nicht da" }, { ...LEAD_FIELDS, schemaVersion: SCHEMA_VERSION, id: "B2", name: "Neu", noteEntries: [{ id: "a", date: "2026-10-14", by: "anna@bookete.com", text: "Hallo" }] }] } }, "2026-10-15");
  assert.equal((await store.get("leads", "B1")).notes, "12.10.2026: Chef nicht da");
  assert.deepEqual((await store.get("leads", "B2")).noteEntries.map((n) => [n.by, n.text]), [["anna@bookete.com", "Hallo"]]);
});

test("the timeline shows each note as a card with who wrote it and when, the notes from before last; one being changed is a form", () => {
  const state = initialState();
  const noteEntries = [{ id: "a", date: "2026-10-14", by: "anna@bookete.com", text: "Chef ab 15 Uhr", createdAt: "2026-10-14T09:00:00.000Z" }];
  state.data = { leads: [{ ...LEAD_FIELDS, id: "L1", name: "Krone", status: "neu", noteEntries, notes: "Nutzt Quandoo" }], activities: [{ id: "A1", leadId: "L1", direction: "out", channel: "E-Mail", date: "2026-10-13", createdAt: "2026-10-13T09:00:00.000Z", text: "Hallo" }, { id: "A2", leadId: "L1", direction: "out", channel: "Vor Ort", date: "2026-10-12", createdAt: "2026-10-12T09:00:00.000Z", text: "Besucht" }], templates: [], settings: [] };
  state.status = { leads: true, activities: true, templates: true, settings: true, failed: "" };
  const page = (ui = {}) => detailView({ ...state, ui: { ...state.ui, view: "detail", leadId: "L1", ...ui } }, "2026-10-15");
  const html = page();
  assert.match(html, /<div class="entry note"><div class="h"><span>Notiz · anna · Mi\., 14\. Okt\.<\/span><span class="h-acts"><button data-note-edit="a">Bearbeiten<\/button><button data-note-remove="a"/);
  // Newest first: the note of the 14th, the mail of the 13th, the notes from before.
  const at = (s) => html.indexOf(s);
  assert.ok(at("Chef ab 15 Uhr") < at("↗ Gesendet") && at("↗ Gesendet") < at("Notiz · Bisherige Notizen"));
  assert.match(html, /data-feed="note" aria-pressed="false">Notizen <small>2<\/small>/);
  // A visit reads as one, not as something sent.
  assert.match(html, /<span>Besuch vor Ort · Mo\., 12\. Okt\./);
  assert.match(html, /<textarea id="ntText" rows="2" placeholder="Notiz hinzuf\xFCgen …"[^>]*><\/textarea><button class="primary" data-act="noteAdd" disabled>/);
  assert.match(page({ noteEdit: { id: "a", text: "Chef ab 16 Uhr" } }), /<textarea id="neText" rows="4" aria-label="Notiz">Chef ab 16 Uhr<\/textarea>[^]*data-act="noteSave"/);
  // A note removed meanwhile closes its form; what was typed becomes a new note to save.
  const unshown = (ui) => unshownSheets({ ...state, ui: { ...state.ui, view: "detail", leadId: "L1", ...ui } }, "2026-10-15");
  assert.deepEqual(unshown({ noteEdit: { id: "weg", text: "x" } }), { noteEdit: null, noteDraft: "x" });
  // Drafts a page of 1.24.0 kept on this device: a note in the composer, or the notes text being edited.
  assert.deepEqual(unshown({ compose: { direction: "note", text: "Intern" } }), { compose: null, noteDraft: "Intern" });
  assert.deepEqual(unshown({ editField: "notes", editDraft: { value: "Alt und neu", from: "Alt" } }), { editField: null, editDraft: null, noteDraft: "Alt und neu" });
  assert.deepEqual(unshown({ compose: { direction: "out", text: "Hallo" }, editField: "city" }), {});
});
