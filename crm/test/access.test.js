import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import worker from "../src/server/index.js";
import { COMMANDS } from "../src/server/commands.js";
import { sha256 } from "../src/server/crypto.js";

// The authorization walk: every command and API route, called without a valid session, is refused
// before its input is read. The exact list makes each new command a conscious addition to this walk.
const RPC = ["addLead", "updateLead", "updateField", "deleteLead", "restoreLead", "purgeLead", "changeStatus", "setLostReason", "closeWithoutReply", "setFollowUp", "setNextStep", "logActivity", "optOut", "clearOptOut", "saveTemplate", "deleteTemplate", "saveIcp", "sendEmail", "importBackup"];

const kv = () => {
  const m = new Map();
  return { get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), list: async () => ({ keys: [], list_complete: true }) };
};
async function env() {
  const e = {
    DB: createD1(), OAUTH_KV: kv(), PUBLIC_URL: "https://crm.bookete.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
    TOKEN_KEY: btoa("k".repeat(32)), CONSENT_SECRET: "c".repeat(32), ALLOWED_EMAILS: "jo@bookete.com",
  };
  // A live session for an address that is no longer allowlisted.
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('ex@bookete.com', 'X', 'now')"),
    e.DB.prepare("INSERT INTO sessions VALUES (?, 'ex@bookete.com', ?)").bind(await sha256("tok"), Date.now() + 1e6),
  ]);
  return e;
}
const fetchAs = async (e, cookie, method, path, body) => worker.fetch(new Request(`https://crm.bookete.com${path}`, {
  method, headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) }, body,
}), e, { waitUntil() {} });

test("the RPC surface is exactly this list", () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [...RPC].sort());
});

test("without an allowlisted session every API route and command is refused", async () => {
  const e = await env();
  const routes = [["GET", "/api/me"], ["GET", "/api/sync?since=0"], ["GET", "/api/history?id=x"], ["GET", "/api/trash"], ...RPC.map((name) => ["POST", `/api/rpc/${name}`])];
  for (const cookie of [null, "__Host-crm-session=wrong", "__Host-crm-session=tok"]) {
    for (const [method, path] of routes) {
      const res = await fetchAs(e, cookie, method, path, method === "POST" ? "{}" : undefined);
      assert.equal(res.status, 401, `${method} ${path} with ${cookie}`);
    }
  }
});

test("without a session the MCP consent page sends to login, and MCP itself needs a token", async () => {
  const e = await env();
  const consent = await fetchAs(e, null, "GET", "/authorize?client_id=x");
  assert.equal(consent.status, 302);
  assert.match(consent.headers.get("Location"), /^https:\/\/crm\.bookete\.com\/auth\/login\?next=/);
  assert.equal((await fetchAs(e, null, "POST", "/mcp", "{}")).status, 401);
});

test("a write that keeps losing races answers 409 with a message, not 500", async () => {
  const e = await env();
  e.ALLOWED_EMAILS = "jo@bookete.com";
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('jo@bookete.com', 'Jo', 'now')"),
    e.DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("jo"), Date.now() + 1e6),
    e.DB.prepare(`INSERT INTO docs (collection, id, data, seq) VALUES ('leads', 'L1', '{"name":"Krone","status":"recherchiert"}', 1)`),
  ]);
  // What D1 raises when the write guard's CHECK fails.
  const db = e.DB;
  e.DB = { prepare: (sql) => db.prepare(sql), batch: async () => { throw new Error("D1_ERROR: CHECK constraint failed: stale_write: SQLITE_CONSTRAINT"); } };
  const res = await fetchAs(e, "__Host-crm-session=jo", "POST", "/api/rpc/setNextStep", JSON.stringify({ id: "L1", text: "Anrufen" }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /gerade von jemand anderem/);
});
