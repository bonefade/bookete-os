import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import worker, { rateKey } from "../src/server/index.js";
import { COMMANDS } from "../src/server/commands.js";
import { sha256 } from "../src/server/crypto.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { unsubscribeUrl, unsubscribeLeadId } from "../src/server/unsubscribe.js";
import { readFileSync } from "node:fs";
// The unsubscribe route stamps an opt-out with the Worker's own clock, not the test's, so its date is that clock's today.
import { systemClock } from "../src/adapters/system.js";

// The authorization walk: every command and API route, called without a valid session, is refused
// before its input is read. The exact list makes each new command a conscious addition to this walk.
const RPC = ["addLead", "updateLead", "updateField", "deleteLead", "restoreLead", "purgeLead", "changeStatus", "setLostReason", "closeWithoutReply", "setFollowUp", "setNextStep", "logActivity", "logCall", "meetingOutcome", "optOut", "clearOptOut", "saveTemplate", "deleteTemplate", "saveIcp", "saveAccount", "sendEmail", "importBackup", "undoCall", "changeNote", "addNote", "signature", "scheduleMeeting", "changeCustomer", "changeTodo", "changeDeal"];

const kv = () => {
  const m = new Map();
  return { get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), list: async () => ({ keys: [], list_complete: true }) };
};
/** A rate limiter that records each key and refuses once `allowed` calls are used up. */
const limiter = (allowed = Infinity) => ({ keys: [], async limit({ key }) { this.keys.push(key); return { success: this.keys.length <= allowed }; } });
async function env(limit = limiter()) {
  const e = {
    AUTH_LIMIT: limit,
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
const fetchAs = async (e, cookie, method, path, body, headers = {}) => worker.fetch(new Request(`https://crm.bookete.com${path}`, {
  method, headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }), ...headers }, body,
}), e, { waitUntil() {} });

test("the RPC surface is exactly this list", () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [...RPC].sort());
});

test("without an allowlisted session every API route and command is refused", async () => {
  const e = await env();
  const routes = [["GET", "/api/me"], ["GET", "/api/sync?since=0"], ["GET", "/api/history?id=x"], ["GET", "/api/trash"], ["POST", "/auth/logout-all"], ...RPC.map((name) => ["POST", `/api/rpc/${name}`])];
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

test("sign-in and the open OAuth endpoints are rate limited per IP before anything else runs", async () => {
  const limit = limiter(0);
  const e = await env(limit);
  for (const [method, path] of [["GET", "/auth/login"], ["GET", "/auth/callback?code=x&state=y"], ["POST", "/oauth/register"], ["POST", "/oauth/token"]]) {
    const res = await fetchAs(e, null, method, path, method === "POST" ? "{}" : undefined, { "CF-Connecting-IP": "2a02:8388:1:2:aaaa::1" });
    assert.equal(res.status, 429, `${method} ${path}`);
  }
  assert.deepEqual(new Set(limit.keys), new Set(["2a02:8388:1:2::/64"]));
  assert.equal((await fetchAs(e, null, "GET", "/api/me", undefined, { "CF-Connecting-IP": "1.2.3.4" })).status, 401);
  assert.equal(limit.keys.length, 4);
});

test("a failing rate limiter lets sign-in through", async () => {
  const e = await env({ limit: async () => { throw new Error("down"); } });
  assert.equal((await fetchAs(e, null, "GET", "/auth/login")).status, 302);
});

test("rate-limit keys: IPv4 as is, IPv6 by its /64", () => {
  assert.equal(rateKey("203.0.113.9"), "203.0.113.9");
  assert.equal(rateKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(rateKey("2a02:8388:0001:0002:aaaa:bbbb:cccc:dddd"), "2a02:8388:1:2::/64");
  assert.equal(rateKey("2a02:8388::1"), "2a02:8388:0:0::/64");
  assert.equal(rateKey("2a02:8388:1:2::"), "2a02:8388:1:2::/64");
});

test("a write that keeps losing races answers 409 with a message, not 500", async () => {
  const e = await env();
  e.ALLOWED_EMAILS = "jo@bookete.com";
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('jo@bookete.com', 'Jo', 'now')"),
    e.DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("jo"), Date.now() + 1e6),
    e.DB.prepare(`INSERT INTO docs (collection, id, data, seq) VALUES ('leads', 'L1', '{"name":"Krone","status":"neu"}', 1)`),
  ]);
  // What D1 raises when the write guard's CHECK fails.
  const db = e.DB;
  e.DB = { prepare: (sql) => db.prepare(sql), batch: async () => { throw new Error("D1_ERROR: CHECK constraint failed: stale_write: SQLITE_CONSTRAINT"); } };
  const res = await fetchAs(e, "__Host-crm-session=jo", "POST", "/api/rpc/setNextStep", JSON.stringify({ id: "L1", text: "Anrufen" }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /gerade von jemand anderem/);
});

test("a signed-in user can see which version is deployed, and who is on the team to look after a customer", async () => {
  const e = await env();
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('jo@bookete.com', 'Jo', 'now')"),
    e.DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("jo-tok"), Date.now() + 1e6),
  ]);
  const me = await (await fetchAs(e, "__Host-crm-session=jo-tok", "GET", "/api/me")).json();
  assert.equal(me.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.deepEqual([me.gmail, me.caps], [false, { gmailRead: false }]);
  // The allowlist, as the Worker read it once (env's ALLOWED_EMAILS).
  assert.deepEqual(me.team, ["jo@bookete.com"]);
});

test("through the Worker, a customer won is owned by the signed-in user, and only someone of the team can look after one", async () => {
  const e = await env();
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('jo@bookete.com', 'Jo', 'now')"),
    e.DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("jo-tok"), Date.now() + 1e6),
  ]);
  const rpc = async (name, body) => fetchAs(e, "__Host-crm-session=jo-tok", "POST", `/api/rpc/${name}`, JSON.stringify(body));
  const { result: id } = await (await rpc("addLead", { input: { name: "Linde", status: "qualifiziert" } })).json();
  assert.equal((await rpc("changeStatus", { id, status: "kunde" })).status, 200);
  const owner = async () => JSON.parse((await e.DB.prepare("SELECT data FROM docs WHERE id = ?").bind(id).first()).data).customer.owner;
  assert.equal(await owner(), "jo@bookete.com");
  assert.equal((await rpc("changeCustomer", { id, owner: "" })).status, 200);
  assert.equal((await rpc("changeCustomer", { id, owner: "anna@bookete.com" })).status, 400);
  assert.equal((await rpc("changeCustomer", { id, owner: "jo@bookete.com" })).status, 200);
  assert.equal(await owner(), "jo@bookete.com");
});

const config = { PUBLIC_URL: "https://crm.bookete.com", CONSENT_SECRET: "c".repeat(32) };
const path = (url) => new URL(url).pathname;
async function withLeads(e, ...names) {
  let n = 0;
  const uc = createUseCases({ store: createStore(e.DB), clock: { today: () => "2026-10-17", now: () => "2026-10-17T10:00:00.000Z" }, ids: { newId: () => `L${++n}` }, actor: "jo@bookete.com (test)" });
  return { uc, ids: await Promise.all(names.map((name) => uc.addLead({ name, email: "wirt@example.at" }))) };
}

test("an unsubscribe link opts out only the lead it was made for", async () => {
  const url = await unsubscribeUrl(config, "L1");
  assert.match(url, /^https:\/\/crm\.bookete\.com\/abmelden\/[\w-]+\.[\w-]{43}$/);
  assert.equal(await unsubscribeLeadId(config, path(url)), "L1");
  const [id, mac] = path(url).slice(10).split(".");
  const other = path(await unsubscribeUrl(config, "L2")).slice(10).split(".")[1];
  for (const token of [`${id}.${other}`, `${id}.${mac.slice(0, -1)}A`, `${btoa("L2").replace(/=/g, "")}.${mac}`, id, `${id}.${mac}x`, "x.y"]) {
    assert.equal(await unsubscribeLeadId(config, "/abmelden/" + token), null, token);
  }
  assert.equal(await unsubscribeLeadId({ ...config, CONSENT_SECRET: "d".repeat(32) }, path(url)), null);
  // The longest id a lead can have, in letters that take three bytes each.
  const longest = "\u20AC".repeat(100);
  assert.equal(await unsubscribeLeadId(config, path(await unsubscribeUrl(config, longest))), longest);
  // Signed, but not a shape we send: refused before the HMAC is looked at.
  assert.equal(await unsubscribeLeadId(config, `${path(url)}.x`), null);
  assert.equal(await unsubscribeLeadId(config, path(await unsubscribeUrl(config, "a".repeat(301)))), null);
});

test("the unsubscribe page needs no session; GET only asks, POST opts out once", async () => {
  const e = await env();
  const { ids: [id] } = await withLeads(e, "Krone");
  const link = path(await unsubscribeUrl(config, id));
  const asked = await fetchAs(e, null, "GET", link);
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /<form method="post"><button>Abmelden<\/button><\/form>/);
  assert.equal((await createStore(e.DB).get("leads", id)).optOutAt, null);
  for (const body of ["", "List-Unsubscribe=One-Click"]) {
    const done = await fetchAs(e, null, "POST", link, body, { "Content-Type": "application/x-www-form-urlencoded" });
    assert.equal(done.status, 200);
    assert.match(await done.text(), /Sie sind abgemeldet/);
    assert.equal(done.headers.get("Cache-Control"), "no-store");
  }
  const l = await createStore(e.DB).get("leads", id);
  assert.deepEqual([l.optOutAt, l.status, l.lostReason], [systemClock.today(), "disqualifiziert", "Keine Kontaktaufnahme gew\xFCnscht"]);
  const acts = await createStore(e.DB).activitiesOf(id);
  assert.deepEqual(acts.map((a) => [a.direction, a.text]), [["in", "Opt-out \xFCber den Abmeldelink in einer E-Mail."]]);
  const [row] = (await e.DB.prepare("SELECT updated_by FROM docs WHERE collection = 'leads' AND id = ?").bind(id).all()).results;
  assert.equal(row.updated_by, "Empf\xE4nger (Abmeldelink)");
});

test("the unsubscribe page reads the same for a lead already opted out or deleted, and refuses a forged link", async () => {
  const e = await env();
  const { uc, ids: [out, gone] } = await withLeads(e, "Krone", "Post");
  await uc.optOut(out, "am Telefon");
  await uc.deleteLead(gone);
  const pages = [];
  for (const id of [out, gone]) {
    const res = await fetchAs(e, null, "POST", path(await unsubscribeUrl(config, id)), "");
    pages.push([res.status, await res.text()]);
  }
  assert.deepEqual(pages[0], pages[1]);
  assert.equal((await createStore(e.DB).activitiesOf(out)).length, 1);
  const forged = await fetchAs(e, null, "POST", "/abmelden/TDE.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "");
  assert.equal(forged.status, 400);
  assert.equal((await fetchAs(e, null, "PUT", path(await unsubscribeUrl(config, out)), "")).status, 405);
});

test("the link opts out a lead in the Papierkorb there, so a restore brings it back opted out", async () => {
  const e = await env();
  const { uc, ids: [id] } = await withLeads(e, "Krone");
  await uc.deleteLead(id);
  assert.equal((await fetchAs(e, null, "POST", path(await unsubscribeUrl(config, id)), "")).status, 200);
  const store = createStore(e.DB);
  assert.equal(await store.get("leads", id), null);
  assert.deepEqual((await store.activitiesOf(id)).length, 0);
  // The Papierkorb still names who deleted it, not the recipient.
  const [entry] = await store.trash();
  assert.deepEqual([entry.lead.optOutAt, entry.actor], [systemClock.today(), "jo@bookete.com (test)"]);
  await uc.restoreLead(id);
  assert.deepEqual((await store.activitiesOf(id)).map((a) => a.text), ["Opt-out \xFCber den Abmeldelink in einer E-Mail."]);
  await assert.rejects(uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Hallo" }), (err) => err.field === "optOutAt");
});

test("the Papierkorb lists by deletion, not by a later opt-out by the link", async () => {
  const e = await env();
  const { uc, ids: [first, second] } = await withLeads(e, "Krone", "Post");
  await uc.deleteLead(first);
  await uc.deleteLead(second);
  await fetchAs(e, null, "POST", path(await unsubscribeUrl(config, first)), "");
  assert.deepEqual((await createStore(e.DB).trash()).map((t) => t.lead.id), [second, first]);
});

test("the link keeps a Kunde Kunde, with its win date and next step", async () => {
  const e = await env();
  const { uc, ids: [id] } = await withLeads(e, "Krone");
  await uc.changeStatus(id, "kunde");
  await uc.setNextStep(id, "Onboarding: Widget einbauen");
  await fetchAs(e, null, "POST", path(await unsubscribeUrl(config, id)), "");
  const l = await createStore(e.DB).get("leads", id);
  assert.deepEqual([l.status, l.wonAt, l.nextStep, l.optOutAt], ["kunde", "2026-10-17", "Onboarding: Widget einbauen", systemClock.today()]);
});

test("the link records the recipient, even in a browser signed in to the CRM", async () => {
  const e = await env();
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('jo@bookete.com', 'Jo', 'now')"),
    e.DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("jo"), Date.now() + 1e6),
  ]);
  const { ids: [id] } = await withLeads(e, "Krone");
  await fetchAs(e, "__Host-crm-session=jo", "POST", path(await unsubscribeUrl(config, id)), "");
  const [row] = (await e.DB.prepare("SELECT updated_by FROM docs WHERE collection = 'leads' AND id = ?").bind(id).all()).results;
  assert.equal(row.updated_by, "Empf\xE4nger (Abmeldelink)");
});

test("a failed unsubscribe says so and asks to try again, not a bare error", async () => {
  const e = await env();
  const { ids: [id] } = await withLeads(e, "Krone");
  const db = e.DB;
  e.DB = { prepare: (sql) => db.prepare(sql), batch: async () => { throw new Error("D1_ERROR: network"); } };
  const res = await fetchAs(e, null, "POST", path(await unsubscribeUrl(config, id)), "");
  assert.equal(res.status, 503);
  assert.match(await res.text(), /noch einmal/);
});

test("the Worker waits a random time before it runs a lost write again, for a signed-in user and for the unsubscribe link", async (t) => {
  const e = await env();
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('jo@bookete.com', 'Jo', 'now')"),
    e.DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("jo"), Date.now() + 1e6),
  ]);
  const { ids: [id] } = await withLeads(e, "Krone");
  // The first commit after `lost = false` loses a race, as D1 reports it; the retry commits.
  const db = e.DB;
  let lost = false;
  e.DB = { prepare: (sql) => db.prepare(sql), batch: async (statements) => {
    if (lost) return db.batch(statements);
    lost = true;
    throw new Error("D1_ERROR: CHECK constraint failed: stale_write: SQLITE_CONSTRAINT");
  } };
  const waits = [];
  t.mock.method(globalThis, "setTimeout", (resolve, ms) => { waits.push(ms); resolve(); });
  t.mock.method(Math, "random", () => 0.5);
  // retryPause after the first attempt: half of 100 ms, by the mocked Math.random.
  assert.equal((await fetchAs(e, "__Host-crm-session=jo", "POST", "/api/rpc/setNextStep", JSON.stringify({ id, text: "Anrufen" }))).status, 200);
  assert.deepEqual(waits, [50], "web write");
  assert.equal((await createStore(db).get("leads", id)).nextStep, "Anrufen");
  lost = false;
  assert.equal((await fetchAs(e, null, "POST", path(await unsubscribeUrl(config, id)), "")).status, 200);
  assert.deepEqual(waits, [50, 50], "unsubscribe");
  assert.ok((await createStore(db).get("leads", id)).optOutAt);
});

test("the unsubscribe link is rate limited per IP in its own bucket, after its shape and before its HMAC is checked", async () => {
  const limit = limiter(0);
  const e = await env(limit);
  const res = await fetchAs(e, null, "POST", path(await unsubscribeUrl(config, "L1")), "", { "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(res.status, 429);
  assert.deepEqual(limit.keys, ["abmelden 1.2.3.4"]);
  // A forged link shaped like ours is limited too, so guessing costs the limit before any HMAC check.
  const forged = await fetchAs(e, null, "POST", "/abmelden/TDE.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "", { "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(forged.status, 429);
  // A path no link of ours has costs no limiter call.
  const junk = await fetchAs(e, null, "POST", "/abmelden/nicht-von-uns", "", { "CF-Connecting-IP": "1.2.3.4" });
  assert.equal(junk.status, 400);
  assert.equal(limit.keys.length, 2);
});
