import { LEAD_FIELDS } from "../domain/lead.js";
import { ConflictError } from "../domain/errors.js";
import { TRASH_SHOWN } from "../domain/constants.js";

const DEFAULTS = { leads: LEAD_FIELDS, activities: { templateId: null } };
const SEQ = "(SELECT seq FROM counter WHERE id = 1)";
/** The row's seq when it was read: a write based on that read names the record as `base`. Not enumerable, so it never reaches data or JSON. */
const VERSION = Symbol("version");
/** Whether the row was in the trash when read: a write based on it applies only while it still is. */
const DELETED = Symbol("deleted");

function toRecord(collection, row) {
  const record = { ...DEFAULTS[collection], ...JSON.parse(row.data), id: row.id };
  return Object.defineProperties(record, { [VERSION]: { value: row.seq }, [DELETED]: { value: !!row.deleted } });
}

/** Document store on D1. `commit` applies a list of writes in one transaction; history rows come from triggers (migration 0002). */
export function createStore(db) {
  // One counter bump per commit; op i of n gets seq - (n - 1 - i), so seqs stay unique and ordered.
  const statement = (op, actor, back) => {
    const NEXT_SEQ = `(${SEQ} - ${back})`;
    const { id: _id, ...data } = op.data || {};
    switch (op.type) {
      // `trashed` puts the record straight into the trash, beside the deleted lead it belongs to.
      case "put":
        return db.prepare(`INSERT INTO docs (collection, id, data, seq, deleted, updated_by) VALUES (?, ?, ?, ${NEXT_SEQ}, ?, ?)
          ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, seq = excluded.seq, deleted = excluded.deleted, updated_by = excluded.updated_by`)
          .bind(op.collection, op.id, JSON.stringify(data), op.trashed ? 1 : 0, actor);
      // json_patch is RFC 7396: a null value removes the key, and toRecord restores it from DEFAULTS.
      // A patch applies where its base was read, live or in the trash.
      case "patch":
        return db.prepare(`UPDATE docs SET data = json_patch(data, ?), seq = ${NEXT_SEQ}, updated_by = ? WHERE collection = ? AND id = ? AND deleted = ?`)
          .bind(JSON.stringify(data), actor, op.collection, op.id, op.base[DELETED] ? 1 : 0);
      // Soft delete: the data stays, so the record can be restored until it is purged.
      case "remove":
        return db.prepare(`UPDATE docs SET deleted = 1, seq = ${NEXT_SEQ}, updated_by = ? WHERE collection = ? AND id = ? AND deleted = 0`)
          .bind(actor, op.collection, op.id);
      case "restore":
        return db.prepare(`UPDATE docs SET deleted = 0, seq = ${NEXT_SEQ}, updated_by = ? WHERE collection = ? AND id = ? AND deleted = 1`)
          .bind(actor, op.collection, op.id);
      // Only purgeLead erases: it empties a deleted record and moves its seq, so a restore based on the old read fails.
      case "erase":
        return db.prepare(`UPDATE docs SET data = '{}', seq = ${NEXT_SEQ}, updated_by = ? WHERE collection = ? AND id = ? AND deleted = 1`)
          .bind(actor, op.collection, op.id);
      default:
        throw new Error("Unknown op " + op.type);
    }
  };
  // Ops with a `base` only apply if their record is still exactly as read: same seq, same deleted state.
  // One statement for the whole commit; a mismatch fails write_guard's CHECK and rolls everything back.
  // The bases go in as one JSON parameter: D1 takes at most 100 bound parameters per query.
  function guard(ops) {
    const based = ops.filter((op) => op.base);
    if (!based.length) return [];
    if (new Set(based.map((op) => `${op.collection}/${op.id}`)).size !== based.length) throw new Error("Two guarded ops on one record");
    const expected = JSON.stringify(based.map((op) => [op.collection, op.id, op.base[VERSION], op.base[DELETED] ? 1 : 0]));
    return [db.prepare(`INSERT OR REPLACE INTO write_guard (id, hit) SELECT 1, COUNT(*) = ? FROM json_each(?) AS b JOIN docs AS d
      ON d.collection = json_extract(b.value, '$[0]') AND d.id = json_extract(b.value, '$[1]') AND d.seq = json_extract(b.value, '$[2]') AND d.deleted = json_extract(b.value, '$[3]')`)
      .bind(based.length, expected)];
  }
  // A lead's activities go into the trash or out of it in two statements however many there are (D1 runs at most
  // 50 queries per Worker invocation), all that are there at commit, also one added since the lead was read.
  // The counter makes room for them first; each gets its own seq, in their old order.
  const moveActivities = (leadId, toTrash, actor) => {
    const of = "FROM docs WHERE collection = 'activities' AND deleted = ? AND json_extract(data, '$.leadId') = ?";
    return [
      db.prepare(`UPDATE counter SET seq = seq + (SELECT COUNT(*) ${of}) WHERE id = 1`).bind(toTrash ? 0 : 1, leadId),
      db.prepare(`UPDATE docs SET deleted = ?, seq = ${SEQ} - m.back, updated_by = ?
        FROM (SELECT id, COUNT(*) OVER () - ROW_NUMBER() OVER (ORDER BY seq) AS back ${of}) AS m WHERE docs.collection = 'activities' AND docs.id = m.id`)
        .bind(toTrash ? 1 : 0, actor, toTrash ? 0 : 1, leadId),
    ];
  };
  const leadMoves = (ops, type, actor) => ops.filter((op) => op.collection === "leads" && op.type === type).flatMap((op) => moveActivities(op.id, type === "remove", actor));
  // One counter bump, then the ops' statements. A lead's activities go to the trash before it and come back after it.
  const writes = (ops, actor) => [
    ...leadMoves(ops, "remove", actor),
    db.prepare("UPDATE counter SET seq = seq + ? WHERE id = 1").bind(ops.length),
    ...ops.map((op, i) => statement(op, actor, ops.length - 1 - i)),
    ...leadMoves(ops, "restore", actor),
  ];
  async function batch(statements) {
    try {
      return await db.batch(statements);
    } catch (e) {
      if (/stale_write/.test(e.message)) throw new ConflictError();
      throw e;
    }
  }
  const one = (sql, ...params) => db.prepare(sql).bind(...params).first();
  const many = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
  return {
    async get(collection, id) {
      const row = await one("SELECT id, data, seq FROM docs WHERE collection = ? AND id = ? AND deleted = 0", collection, id);
      return row ? toRecord(collection, row) : null;
    },
    /** A deleted record that can still be restored (purged ones have no data left). */
    async getDeleted(collection, id) {
      const row = await one("SELECT id, data, seq, deleted FROM docs WHERE collection = ? AND id = ? AND deleted = 1 AND data != '{}'", collection, id);
      return row ? toRecord(collection, row) : null;
    },
    async list(collection) {
      return (await many("SELECT id, data, seq FROM docs WHERE collection = ? AND deleted = 0", collection)).map((row) => toRecord(collection, row));
    },
    /** Every id the collection has held, deleted ones included. */
    async ids(collection) {
      return new Set((await many("SELECT id FROM docs WHERE collection = ?", collection)).map((row) => row.id));
    },
    /**
     * A lead with an opt-out that holds this email address, live or in the trash (an erased one holds nothing), and
     * whether it is in the trash; null for none. Compared as lead.js's optOutByAddress compares. One query, live first.
     */
    async optOutByAddress(email) {
      const row = await one(`SELECT id, data, seq, deleted FROM docs WHERE collection = 'leads' AND json_extract(data, '$.optOutAt') IS NOT NULL
        AND lower(trim(json_extract(data, '$.email'))) = lower(trim(?)) ORDER BY deleted, seq DESC LIMIT 1`, email);
      return row ? { lead: toRecord("leads", row), trashed: !!row.deleted } : null;
    },
    /** Of these leads, the ones that still hold data, by id: live, or in the trash (`trashed`). An erased lead is not among them. */
    async heldLeads(ids) {
      const rows = await many("SELECT id, data, seq, deleted FROM docs WHERE collection = 'leads' AND data != '{}' AND id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
      return new Map(rows.map((row) => [row.id, { lead: toRecord("leads", row), trashed: !!row.deleted }]));
    },
    async activitiesOf(leadId, { deleted = false } = {}) {
      const rows = await many("SELECT id, data, seq, deleted FROM docs WHERE collection = 'activities' AND deleted = ? AND json_extract(data, '$.leadId') = ?", deleted ? 1 : 0, leadId);
      return rows.map((row) => toRecord("activities", row));
    },
    /**
     * A change to an existing record (patch, remove, restore) must name the read it is based on; only a put may go without.
     * `unchanged` ({ collection, id, base }) are records the writes depend on but do not change: the commit applies only while each is still as read.
     */
    async commit(ops, actor, unchanged = []) {
      if (!ops.length) return;
      const unbased = ops.find((op) => op.type !== "put" && !op.base);
      if (unbased) throw new Error(`${unbased.type} of ${unbased.collection}/${unbased.id} without a base`);
      await batch([...guard([...ops, ...unchanged]), ...writes(ops, actor)]);
    },
    /**
     * Erases a deleted lead for good: its data, the data of all its activities (any still live go to the trash
     * first; one the unsubscribe link or a backup import added to the deleted lead is erased with it) and every history row of both. The rows stay as empty, deleted tombstones (the lead's row
     * names who erased it), so sync and the import still know the ids. Fails with ConflictError unless the lead is
     * still in the trash as read.
     */
    async purgeLead(base, actor) {
      const acts = "SELECT id FROM docs WHERE collection = 'activities' AND json_extract(data, '$.leadId') = ?";
      // History goes after the writes (their triggers add rows) and before the activities are emptied (the query reads their leadId).
      await batch([
        ...guard([{ type: "restore", collection: "leads", id: base.id, base }]),
        ...moveActivities(base.id, true, actor),
        ...writes([{ type: "erase", collection: "leads", id: base.id }], actor),
        db.prepare(`DELETE FROM history WHERE collection = 'activities' AND id IN (${acts})`).bind(base.id),
        db.prepare("DELETE FROM history WHERE collection = 'leads' AND id = ?").bind(base.id),
        db.prepare(`UPDATE docs SET data = '{}' WHERE collection = 'activities' AND deleted = 1 AND id IN (${acts})`).bind(base.id),
      ]);
    },
    /**
     * Deleted leads that can be restored, TRASH_SHOWN at a time, newest first: those deleted before `before` (an
     * entry's `seq`) if given. Each with who deleted it and when: the version that moved the lead to the trash, not
     * a later write there (an opt-out by the link).
     */
    async trash(before) {
      const rows = await many(`SELECT d.id, d.data, d.seq, d.deleted, COALESCE(h.actor, d.updated_by) AS actor, h.at, COALESCE(h.seq, d.seq) AS deleted_seq FROM docs d
        LEFT JOIN history h ON h.seq = (SELECT MIN(x.seq) FROM history x WHERE x.collection = d.collection AND x.id = d.id AND x.deleted = 1
          AND x.seq > (SELECT COALESCE(MAX(y.seq), 0) FROM history y WHERE y.collection = d.collection AND y.id = d.id AND y.deleted = 0))
        WHERE d.collection = 'leads' AND d.deleted = 1 AND d.data != '{}' ${before ? "AND COALESCE(h.seq, d.seq) < ?" : ""} ORDER BY deleted_seq DESC LIMIT ?`, ...(before ? [before] : []), TRASH_SHOWN);
      return rows.map((row) => ({ lead: toRecord("leads", row), actor: row.actor, at: row.at, seq: row.deleted_seq }));
    },
    /** A lead's newest 100 versions, newest first: each with the data before and after, who wrote it and when, and whether it was deleted before. */
    async history(leadId) {
      const rows = await many(`SELECT * FROM (SELECT seq, before, after, deleted, LAG(deleted) OVER (ORDER BY seq) AS was_deleted, actor, at
        FROM history WHERE collection = 'leads' AND id = ?) ORDER BY seq DESC LIMIT 100`, leadId);
      return rows.map((row) => ({ seq: row.seq, at: row.at, actor: row.actor, deleted: !!row.deleted, wasDeleted: !!row.was_deleted, before: row.before ? JSON.parse(row.before) : null, after: JSON.parse(row.after) }));
    },
    /** Everything written after `since`. A first load (since 0) skips deleted records. */
    async changes(since) {
      const [{ results }, counter] = await db.batch([
        db.prepare(`SELECT collection, id, data, deleted FROM docs WHERE seq > ? ${since ? "" : "AND deleted = 0"} ORDER BY seq`).bind(since),
        db.prepare("SELECT seq FROM counter WHERE id = 1"),
      ]);
      return {
        seq: counter.results[0].seq,
        changes: results.map((row) => row.deleted ? { collection: row.collection, id: row.id, deleted: true } : { collection: row.collection, id: row.id, record: toRecord(row.collection, row) }),
      };
    },
  };
}
