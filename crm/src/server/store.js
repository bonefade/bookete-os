import { LEAD_FIELDS } from "../domain/lead.js";

const DEFAULTS = { leads: LEAD_FIELDS, activities: { templateId: null } };
const NEXT_SEQ = "(SELECT seq FROM counter WHERE id = 1)";

const toRecord = (collection, row) => ({ ...DEFAULTS[collection], ...JSON.parse(row.data), id: row.id });

/** Document store on D1. `commit` applies a list of writes in one transaction. */
export function createStore(db) {
  const bump = () => db.prepare("UPDATE counter SET seq = seq + 1 WHERE id = 1");
  const statement = (op, actor) => {
    const { id: _id, ...data } = op.data || {};
    switch (op.type) {
      case "put":
        return db.prepare(`INSERT INTO docs (collection, id, data, seq, deleted, updated_by) VALUES (?, ?, ?, ${NEXT_SEQ}, 0, ?)
          ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, seq = excluded.seq, deleted = 0, updated_by = excluded.updated_by`)
          .bind(op.collection, op.id, JSON.stringify(data), actor);
      // json_patch is RFC 7396: a null value removes the key, and toRecord restores it from DEFAULTS.
      case "patch":
        return db.prepare(`UPDATE docs SET data = json_patch(data, ?), seq = ${NEXT_SEQ}, updated_by = ? WHERE collection = ? AND id = ? AND deleted = 0`)
          .bind(JSON.stringify(data), actor, op.collection, op.id);
      case "remove":
        return db.prepare(`UPDATE docs SET data = '{}', deleted = 1, seq = ${NEXT_SEQ}, updated_by = ? WHERE collection = ? AND id = ?`)
          .bind(actor, op.collection, op.id);
      default:
        throw new Error("Unknown op " + op.type);
    }
  };
  return {
    async get(collection, id) {
      const row = await db.prepare("SELECT id, data FROM docs WHERE collection = ? AND id = ? AND deleted = 0").bind(collection, id).first();
      return row ? toRecord(collection, row) : null;
    },
    async list(collection) {
      const { results } = await db.prepare("SELECT id, data FROM docs WHERE collection = ? AND deleted = 0").bind(collection).all();
      return results.map((row) => toRecord(collection, row));
    },
    async activitiesOf(leadId) {
      const { results } = await db.prepare("SELECT id, data FROM docs WHERE collection = 'activities' AND deleted = 0 AND json_extract(data, '$.leadId') = ?").bind(leadId).all();
      return results.map((row) => toRecord("activities", row));
    },
    async commit(ops, actor) {
      if (ops.length) await db.batch(ops.flatMap((op) => [bump(), statement(op, actor)]));
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
