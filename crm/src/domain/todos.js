import { ValidationError } from './errors.js';
import { isDate } from './dates.js';
import { oneLine as line } from './lead.js';

/**
 * A business's todos: anything to do for a lead or a customer, beside its one next step. Each has a text, a day it is
 * due ("" for none) and the day it was done ("" while open); they belong to nobody, and the history says who wrote
 * them. They live on the lead record, so the write guard, history, trash, erase and backup cover them; a list, as the
 * store's RFC 7396 patch replaces a list whole, and empty is "", never null. At most 50 open (one more, added,
 * reopened or imported, is refused) and the newest 100 done: an older done one leaves the list, its text kept in the
 * history.
 */
export const TODO_LIMIT = 50;
export const DONE_KEPT = 100;
const day = (v) => isDate(v) ? v : "";

/** Stored todos in today's shape: open first by due day (none last), then the done ones, newest first. */
export function normalizeTodos(list, newId) {
  const todos = (Array.isArray(list) ? list : []).map((t) => ({ id: line(t?.id, 100) || newId(), text: line(t?.text, 300), due: day(t?.due), done: day(t?.done) })).filter((t) => t.text);
  if (new Set(todos.map((t) => t.id)).size !== todos.length) throw new ValidationError("todos", "Doppeltes Todo");
  if (todos.filter((t) => !t.done).length > TODO_LIMIT) throw new ValidationError("todos", `H\xF6chstens ${TODO_LIMIT} offene Todos`);
  const open = todos.filter((t) => !t.done).sort((a, b) => (a.due || "9") < (b.due || "9") ? -1 : (a.due || "9") > (b.due || "9") ? 1 : 0);
  const done = todos.filter((t) => t.done).sort((a, b) => a.done < b.done ? 1 : a.done > b.done ? -1 : 0);
  return [...open, ...done.slice(0, DONE_KEPT)];
}
export const todosOf = (lead) => normalizeTodos(lead.todos, () => "");

/**
 * One change to the todos, by the todo's id: a new one (`add`, with a `due` day or none), done or open again (`done`),
 * its text or due day changed (`text`, `due`: "" for none; either or both), or gone (`remove`). A todo already gone
 * is no change.
 */
export function todosAfter(list, change, { today, newId }) {
  if ("add" in change) {
    const text = line(change.add, 300);
    if (!text) throw new ValidationError("todo", "Was ist zu tun?");
    if (change.due && !isDate(change.due)) throw new ValidationError("due", "Datum ung\xFCltig");
    return normalizeTodos([...list, { id: newId(), text, due: change.due || "", done: "" }], newId);
  }
  if (change.remove) return list.filter((t) => t.id !== change.todo);
  if ("done" in change) return normalizeTodos(list.map((t) => t.id === change.todo ? { ...t, done: change.done ? today : "" } : t), newId);
  if ("text" in change || "due" in change) {
    const text = "text" in change ? line(change.text, 300) : null;
    if (text === "") throw new ValidationError("todo", "Was ist zu tun?");
    if (change.due && !isDate(change.due)) throw new ValidationError("due", "Datum ung\xFCltig");
    return normalizeTodos(list.map((t) => t.id === change.todo ? { ...t, ...(text !== null && { text }), ...("due" in change && { due: change.due || "" }) } : t), newId);
  }
  throw new ValidationError("todo", "Keine \xC4nderung");
}

/** The open todo due first by `today`, if any: what Heute shows for the business. */
export const dueTodo = (lead, today) => todosOf(lead).find((t) => !t.done && t.due && t.due <= today) || null;
