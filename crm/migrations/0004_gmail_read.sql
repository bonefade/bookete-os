-- Expand only: two new columns on users, NULL on every existing row; nothing existing changes shape.

-- The OAuth scopes Google granted with the stored refresh token, space-separated as its token response gives them.
-- NULL until the user signs in again; the Gmail sync reads a mailbox only once they include gmail.readonly.
ALTER TABLE users ADD COLUMN scopes TEXT;

-- Where the Gmail sync of this mailbox stands, as JSON (src/server/sync.js): NULL before its first run.
ALTER TABLE users ADD COLUMN gmail_cursor TEXT;
