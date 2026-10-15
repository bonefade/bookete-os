-- CRM records (leads, activities, templates, settings) as JSON documents.
-- Every write takes the next value of counter.seq, so clients sync with "everything after seq N".
CREATE TABLE docs (
  collection TEXT NOT NULL CHECK (collection IN ('leads', 'activities', 'templates', 'settings')),
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  PRIMARY KEY (collection, id)
);
CREATE INDEX docs_seq ON docs (seq);
CREATE INDEX docs_activity_lead ON docs (json_extract(data, '$.leadId')) WHERE collection = 'activities';

CREATE TABLE counter (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
INSERT INTO counter VALUES (1, 0);

-- refresh_token is AES-GCM encrypted with the TOKEN_KEY secret.
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  refresh_token TEXT,
  updated_at TEXT NOT NULL
);

-- Only the SHA-256 of the session token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES users (email) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
