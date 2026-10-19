import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { ValidationError } from "../src/domain/errors.js";
import { BACKUP_FORMAT } from "../src/domain/backup.js";
import { describeChange } from "../src/web/format.js";
import { dueTodo, TODO_LIMIT } from "../src/domain/todos.js";

let today = "2026-10-15";
const clock = { today: () => today, now: () => today + "T10:00:00.000Z" };
function setup() {
  today = "2026-10-15";
  const store = createStore(createD1());
  let n = 0;
  const uc = createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "jo@bookete.com (test)", email: "jo@bookete.com", team: ["jo@bookete.com"] });
  return { store, uc };
}
const rejects = (promise, field) => assert.rejects(promise, (e) => e instanceof ValidationError && e.field === field);
const shown = async (store, id) => (await store.get("leads", id)).todos.map((t) => [t.text, t.due, t.done]);

test("todos on any business: added with a due day or none, open first by due day, done ones after, newest first", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Linde", status: "kunde" });
  await uc.changeTodo(id, { add: "Website-Vertrag schicken", due: "2026-10-20" });
  await uc.changeTodo(id, { add: "Fotos anfragen" });
  await uc.changeTodo(id, { add: "Agentur anrufen", due: "2026-10-16" });
  assert.deepEqual(await shown(store, id), [["Agentur anrufen", "2026-10-16", ""], ["Website-Vertrag schicken", "2026-10-20", ""], ["Fotos anfragen", "", ""]]);
  const [first, second] = (await store.get("leads", id)).todos;
  await uc.changeTodo(id, { todo: first.id, done: true });
  today = "2026-10-17";
  await uc.changeTodo(id, { todo: second.id, done: true });
  assert.deepEqual(await shown(store, id), [["Fotos anfragen", "", ""], ["Website-Vertrag schicken", "2026-10-20", "2026-10-17"], ["Agentur anrufen", "2026-10-16", "2026-10-15"]]);
  // Its text and its day change, together or alone; a text can't be emptied.
  await uc.changeTodo(id, { todo: first.id, text: "Agentur Pixel anrufen", due: "2026-10-18" });
  await rejects(uc.changeTodo(id, { todo: first.id, text: "  " }), "todo");
  assert.deepEqual((await store.get("leads", id)).todos.find((t) => t.id === first.id).text, "Agentur Pixel anrufen");
  await uc.changeTodo(id, { todo: first.id, text: "Agentur anrufen" });
  // Open again, a new day, gone; a todo gone already is no change.
  await uc.changeTodo(id, { todo: first.id, done: false });
  await uc.changeTodo(id, { todo: first.id, due: "" });
  await uc.changeTodo(id, { todo: second.id, remove: true });
  assert.equal(await uc.changeTodo(id, { todo: second.id, remove: true }), false);
  assert.deepEqual(await shown(store, id), [["Agentur anrufen", "", ""], ["Fotos anfragen", "", ""]]);
  // Todos belong to nobody: the history says who wrote them.
  assert.deepEqual(Object.keys((await store.get("leads", id)).todos[0]), ["id", "text", "due", "done"]);
});

test("the list keeps every open todo and the newest 100 done ones", async () => {
  const { store, uc } = setup();
  const done = Array.from({ length: 105 }, (_, i) => ({ id: `d${i}`, text: `erledigt ${i}`, due: "", done: `2026-0${1 + Math.floor(i / 28)}-${String(i % 28 + 1).padStart(2, "0")}` }));
  const open = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, text: `offen ${i}`, due: "", done: "" }));
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ id: "L1", name: "Krone", status: "neu", schemaVersion: 3, todos: [...open, ...done] }] } });
  await uc.changeTodo("L1", { add: "noch eins" });
  const todos = (await store.get("leads", "L1")).todos;
  assert.deepEqual([todos.filter((t) => !t.done).length, todos.filter((t) => t.done).length], [31, 100]);
  // The oldest done ones left the list.
  assert.equal(todos.some((t) => ["d0", "d1", "d2", "d3", "d4"].includes(t.id)), false);
});

test("a todo needs a text and a real day; at most 50 open", async () => {
  const { store, uc } = setup();
  const id = await uc.addLead({ name: "Krone" });
  await rejects(uc.changeTodo(id, { add: "   " }), "todo");
  await rejects(uc.changeTodo(id, { add: "Anrufen", due: "morgen" }), "due");
  for (let i = 0; i < TODO_LIMIT; i++) await uc.changeTodo(id, { add: `Todo ${i}` });
  await rejects(uc.changeTodo(id, { add: "eins zu viel" }), "todos");
  // Reopening one past 50 is refused too, as is a backup with more.
  const first = (await store.get("leads", id)).todos[0];
  await uc.changeTodo(id, { todo: first.id, done: true });
  await uc.changeTodo(id, { add: "der fünfzigste" });
  await rejects(uc.changeTodo(id, { todo: first.id, done: false }), "todos");
  const many = Array.from({ length: TODO_LIMIT + 1 }, (_, i) => ({ id: `o${i}`, text: `offen ${i}`, due: "", done: "" }));
  await assert.rejects(uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ id: "L2", name: "Post", status: "neu", schemaVersion: 3, todos: many }] } }));
  assert.equal(await store.get("leads", "L2"), null);
});

test("the todo due first by today is the one Heute shows; a backup keeps the todos; the history names the change", async () => {
  const { store, uc } = setup();
  const lead = { todos: [{ id: "a", text: "später", due: "2026-10-20", done: "" }, { id: "b", text: "erledigt", due: "2026-10-10", done: "2026-10-11" }, { id: "c", text: "jetzt", due: "2026-10-14", done: "" }] };
  assert.equal(dueTodo(lead, "2026-10-15").text, "jetzt");
  assert.equal(dueTodo(lead, "2026-10-13"), null);
  await uc.importBackup({ format: BACKUP_FORMAT, data: { leads: [{ id: "L9", name: "Krone", status: "neu", schemaVersion: 3, ...lead }] } });
  assert.deepEqual((await store.get("leads", "L9")).todos.map((t) => t.id), ["c", "a", "b"]);
  assert.deepEqual(describeChange({ before: { name: "x", todos: [] }, after: { name: "x", todos: lead.todos } }), ["Todos ge\xE4ndert"]);
  const ok = (input) => COMMANDS.changeTodo[0].safeParse({ id: "L9", ...input }).success;
  assert.equal(ok({ add: "Anrufen", due: "2026-10-20" }), true);
  assert.equal(ok({ todo: "a", done: true }), true);
  assert.equal(ok({ todo: "a", due: "" }), true);
  assert.equal(ok({ todo: "a", text: "Neu", due: "2026-10-20" }), true);
  assert.equal(ok({ todo: "a" }), false);
  assert.equal(ok({ todo: "a", text: "" }), false);
  assert.equal(ok({ todo: "a", remove: true }), true);
  assert.equal(ok({ add: "" }), false);
  assert.equal(ok({ todo: "a", done: true, remove: true }), false);
  assert.equal(ok({ todo: "a", remove: false }), false);
});

test("two writing at once: a todo added while the other adds one keeps both", async () => {
  const store = createStore(createD1());
  let n = 0, raced = false;
  const ids = { newId: () => `id${++n}` };
  const make = (s) => createUseCases({ store: s, clock, ids, actor: "jo@bookete.com (test)" });
  const b = make(store);
  // The other user's todo lands between this read and this write.
  const racing = { ...store, get: async (...args) => {
    const found = await store.get(...args);
    if (!raced && args[0] === "leads") { raced = true; await b.changeTodo(args[1], { add: "vom anderen" }); }
    return found;
  } };
  const a = make(racing);
  const id = await b.addLead({ name: "Krone" });
  await a.changeTodo(id, { add: "meins" });
  assert.deepEqual((await store.get("leads", id)).todos.map((t) => t.text).sort(), ["meins", "vom anderen"]);
});
