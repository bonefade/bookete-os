import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// D1 refuses a query with more bound parameters than this; node:sqlite would take 250000.
const D1_MAX_PARAMS = 100;

/** The slice of the D1 API the app uses, on node:sqlite, with every migration applied and D1's parameter limit. */
export function createD1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...p) => {
      if (p.length > D1_MAX_PARAMS) throw new Error("D1_ERROR: too many SQL variables");
      return statement(sql, p);
    },
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
