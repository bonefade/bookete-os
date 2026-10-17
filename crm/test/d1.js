import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// D1 refuses a query with more bound parameters than this; node:sqlite would take 250000.
const D1_MAX_PARAMS = 100;
// D1 runs at most this many queries in one Worker invocation on the Free plan; each statement of a batch is one.
const D1_MAX_QUERIES = 50;

/**
 * The slice of the D1 API the app uses, on node:sqlite, with D1's parameter limit. Applies every migration, or
 * those up to and including `until` (e.g. "0002"), so a test can seed the rows a later migration rewrites.
 * `invocation()` is a handle on the same database that also counts queries as one Worker invocation does and
 * refuses the one past D1's cap; a test takes one per request. The handle createD1 returns counts nothing.
 */
export function createD1({ until } = {}) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql") && (!until || f.split("_")[0] <= until)).sort();
  for (const file of files) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const handle = (count) => {
    const statement = (sql, params = []) => ({
      bind: (...p) => {
        if (p.length > D1_MAX_PARAMS) throw new Error("D1_ERROR: too many SQL variables");
        return statement(sql, p);
      },
      first: async () => (count(1), db.prepare(sql).get(...params) ?? null),
      all: async () => (count(1), { results: db.prepare(sql).all(...params) }),
      run: async () => (count(1), db.prepare(sql).run(...params)),
      exec: () => /^\s*(select|with)\b/i.test(sql) ? { results: db.prepare(sql).all(...params) } : (db.prepare(sql).run(...params), { results: [] }),
    });
    return {
      prepare: (sql) => statement(sql),
      /** Several statements, as D1's exec runs them: not in one transaction. */
      exec: async (sql) => void db.exec(sql),
      async batch(statements) {
        count(statements.length);
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
  };
  return {
    ...handle(() => {}),
    invocation() {
      let queries = 0;
      return handle((n) => {
        queries += n;
        if (queries > D1_MAX_QUERIES) throw new Error(`D1_ERROR: more than ${D1_MAX_QUERIES} queries in one Worker invocation`);
      });
    },
  };
}
