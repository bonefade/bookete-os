import { ValidationError } from './errors.js';
import { isDate } from './dates.js';
import { str, oneLine as line } from './lead.js';

/**
 * A business's notes, each its own entry: the day it was written, who wrote it (an email, "" when not known) and its
 * text; shown newest first as cards in the lead's feed. Since 1.25.0 they are `lead.noteEntries`, a list beside the
 * notes text of before (`lead.notes`), which stays as it was: it reads as entries (notesFromText) until one of them
 * is changed or removed, when they all move into the list and the text is emptied. The text keeps its type, so a
 * page or a Worker of 1.24.0 still reads it. The list lives on the lead record, so the write guard, history, trash,
 * erase and backup cover it; a list, as the store's RFC 7396 patch replaces a list whole.
 */
export const NOTE_LIMIT = 300;
/** The longest note written; a stored one, such as the text of before (which had no cap), is never cut. */
export const NOTE_MAX = 20000;
/** All notes' text together at most, so a lead stays well within the store's size for one record. */
export const NOTES_TOTAL = 400000;
const DATED = /^(\d{1,2})\.(\d{1,2})\.(\d{4}):[ \t]*/;

/** Stored entries in today's shape. Reading never fails nor cuts: an entry without text, or a second one with an id, is left out. */
export function normalizeEntries(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((n, i) => ({ id: line(n?.id, 100) || `x${i + 1}`, date: isDate(n?.date) ? n.date : "", by: line(n?.by, 200), text: str(n?.text), createdAt: typeof n?.createdAt === "string" ? n.createdAt.slice(0, 40) : "" }))
    .filter((n) => n.text && !seen.has(n.id) && seen.add(n.id));
}
const key = (n) => (n.date || "0") + (n.createdAt || "");
// Newest first; equal ones keep their order, which notesFromText gives newest first too.
const newestFirst = (notes) => notes.map((n, i) => [n, i]).sort(([a, i], [b, j]) => key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : i - j).map(([n]) => n);
/** All of a lead's notes: the entries and those the text of before reads as, newest first, undated last. */
export const notesOf = (lead) => newestFirst([...normalizeEntries(lead.noteEntries), ...notesFromText(lead.notes)]);

/**
 * The notes text of before as entries: each paragraph that starts with a day ("19.10.2026: …") is a note of that day,
 * the others together one undated note, the notes from before. Newest paragraph first; the ids follow the paragraphs,
 * so the same text always gives the same entries.
 */
export function notesFromText(text) {
  const dated = [], undated = [];
  String(text ?? "").split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean).forEach((para, i) => {
    const m = para.match(DATED);
    const date = m && `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (m && isDate(date) && para.length > m[0].length) dated.unshift({ id: `n${i + 1}`, date, by: "", text: para.slice(m[0].length), createdAt: "" });
    else undated.push(para);
  });
  return undated.length ? [...dated, { id: "n0", date: "", by: "", text: undated.join("\n\n"), createdAt: "" }] : dated;
}

/**
 * One change to a lead's notes, by the note's id, as the patch to write, or null for none: a new one (`add`, its
 * text, by whoever writes, today), its text changed (`text`), or gone (`remove`). Changing a note of the text of before
 * moves all its notes into the list and empties the text. A note already gone is no change. At most 300 notes.
 */
export function notesAfter(lead, change, { today, now, by, newId }) {
  const entries = normalizeEntries(lead.noteEntries);
  if ("add" in change) {
    const text = str(change.add, NOTE_MAX);
    if (!text) throw new ValidationError("text", "Die Notiz ist leer");
    if (notesOf(lead).length >= NOTE_LIMIT) throw new ValidationError("notes", `H\xF6chstens ${NOTE_LIMIT} Notizen`);
    return fits({ noteEntries: [{ id: newId(), date: today, by, text, createdAt: now }, ...entries] }, lead);
  }
  const all = notesOf(lead);
  if (!all.some((n) => n.id === change.note)) return null;
  let text = null;
  if (!change.remove) {
    if (!("text" in change)) throw new ValidationError("note", "Keine \xC4nderung");
    text = str(change.text, NOTE_MAX);
    if (!text) throw new ValidationError("text", "Die Notiz ist leer");
  }
  const after = (list) => change.remove ? list.filter((n) => n.id !== change.note) : list.map((n) => n.id === change.note ? { ...n, text } : n);
  // A note of the list changes there; one of the text takes all of the text's notes into the list.
  // The same text again is no change.
  if (text !== null && all.find((n) => n.id === change.note).text === text) return null;
  if (entries.some((n) => n.id === change.note)) return fits({ noteEntries: after(entries) }, lead);
  return fits({ noteEntries: after(all), notes: "" }, lead);
}
const size = (notes) => notes.reduce((n, x) => n + x.text.length, 0);
/** The patch, unless it makes the notes longer than NOTES_TOTAL; shortening or removing is always allowed. */
function fits(patch, lead) {
  const after = notesOf({ ...lead, ...patch });
  if (size(after) > NOTES_TOTAL && size(after) > size(notesOf(lead))) throw new ValidationError("notes", "Die Notizen sind zu lang. Bitte k\xFCrzen oder alte l\xF6schen.");
  return patch;
}
