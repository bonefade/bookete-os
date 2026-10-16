import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/** The slice of the D1 API the app uses, on node:sqlite, with the real migration applied. */
export function createD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...p) => statement(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => db.prepare(sql).run(...params),
    exec: () => /^\s*(select|with)\b/i.test(sql) ? { results: db.prepare(sql).all(...params) } : (db.prepare(sql).run(...params), { results: [] }),
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => s.exec());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
