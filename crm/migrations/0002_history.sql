-- Expand only: two new tables and two triggers; nothing existing changes shape.

-- Every version of every record: written by triggers, so no write path can skip it.
-- seq is the doc's seq after the write; `before` is NULL for a new record.
CREATE TABLE history (
  seq INTEGER PRIMARY KEY,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  before TEXT,
  after TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  actor TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX history_doc ON history (collection, id, seq);

CREATE TRIGGER docs_history_insert AFTER INSERT ON docs BEGIN
  INSERT INTO history (seq, collection, id, before, after, deleted, actor)
  VALUES (NEW.seq, NEW.collection, NEW.id, NULL, NEW.data, NEW.deleted, NEW.updated_by);
END;

-- An upsert of a held id or a restore moves seq; a purge empties data without moving seq and leaves no copy.
CREATE TRIGGER docs_history_update AFTER UPDATE ON docs WHEN NEW.seq != OLD.seq BEGIN
  INSERT INTO history (seq, collection, id, before, after, deleted, actor)
  VALUES (NEW.seq, NEW.collection, NEW.id, OLD.data, NEW.data, NEW.deleted, NEW.updated_by);
END;

-- Optimistic concurrency: a commit first writes how many of the records it read are still as it read them.
-- Fewer than expected fails this CHECK, which rolls back the whole batch (store.js maps it to ConflictError).
CREATE TABLE write_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hit INTEGER NOT NULL,
  CONSTRAINT stale_write CHECK (hit = 1)
);
