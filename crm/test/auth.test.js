import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { allowedUser, sessionUser, startLogin, finishLogin, safeNext, logoutEverywhere } from "../src/server/auth.js";
import { readConfig } from "../src/server/config.js";
import { sha256 } from "../src/server/crypto.js";

const config = readConfig({
  PUBLIC_URL: "https://crm.bookete.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
  TOKEN_KEY: btoa("k".repeat(32)), CONSENT_SECRET: "c".repeat(32), ALLOWED_EMAILS: "jo@bookete.com",
  AUTH_LIMIT: { limit: async () => ({ success: true }) },
});
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function withSession(email, expiresAt) {
  const env = { DB: createD1() };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES (?, 'X', 'now')").bind(email),
    env.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?)").bind(await sha256("tok"), email, expiresAt),
  ]);
  return env;
}
const withCookie = (cookie) => new Request("https://crm.bookete.com/api/me", { headers: { Cookie: cookie } });

test("a session counts only while unexpired and while the email is allowlisted", async () => {
  const live = await withSession("jo@bookete.com", Date.now() + 1e6);
  assert.equal((await sessionUser(withCookie("__Host-crm-session=tok"), live, config)).email, "jo@bookete.com");
  assert.equal(await sessionUser(withCookie("__Host-crm-session=other"), live, config), null);
  assert.equal(await sessionUser(withCookie(""), live, config), null);
  const expired = await withSession("jo@bookete.com", Date.now() - 1);
  assert.equal(await sessionUser(withCookie("__Host-crm-session=tok"), expired, config), null);
  const removed = await withSession("ex@bookete.com", Date.now() + 1e6);
  assert.equal(await sessionUser(withCookie("__Host-crm-session=tok"), removed, config), null);
  assert.equal(await allowedUser(removed, config, "ex@bookete.com"), null);
  assert.equal(await allowedUser(removed, config, undefined), null);
});

test("after login only same-site paths are followed", () => {
  const base = "https://crm.bookete.com";
  assert.equal(safeNext("/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx.json", base), "/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx.json");
  for (const evil of ["//evil.com", "/\\evil.com", "https://evil.com/", "/\\evil%2Ecom", "/.//evil.com", "/..//evil.com", "/%2e//evil.com"]) assert.equal(safeNext(evil, base), "/", evil);
  assert.equal(safeNext(null, base), "/");
  // The screen the user was on: the browser never sends the fragment, so the web app puts it into `next`.
  assert.equal(safeNext("/#/betrieb/L1", base), "/#/betrieb/L1");
  assert.equal(safeNext("https://evil.com/#/betrieb/L1", base), "/");
});

function stubGoogle(profile) {
  globalThis.fetch = async (url) => {
    if (String(url).includes("/token")) return Response.json({ access_token: "at", refresh_token: "rt" });
    if (String(url).includes("userinfo")) return Response.json(profile);
    throw new Error("unexpected fetch " + url);
  };
}

async function login(env, next) {
  const start = await startLogin(new Request(`https://crm.bookete.com/auth/login?next=${encodeURIComponent(next)}`), config);
  const loginCookie = start.headers.get("Set-Cookie").split(";")[0];
  const state = new URL(start.headers.get("Location")).searchParams.get("state");
  return finishLogin(new Request(`https://crm.bookete.com/auth/callback?state=${state}&code=c`, { headers: { Cookie: loginCookie } }), env, config);
}

test("login returns to the full MCP authorize URL and stores the Gmail token encrypted", async () => {
  const env = { DB: createD1() };
  stubGoogle({ email: "Jo@bookete.com", email_verified: true, name: "Jo" });
  const next = "/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fmeta.json&state=a.b";
  const res = await login(env, next);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), next);
  const user = await env.DB.prepare("SELECT refresh_token FROM users WHERE email = 'jo@bookete.com'").first();
  assert.ok(user.refresh_token && user.refresh_token !== "rt");
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first()).n, 1);
});

test("login refuses unlisted and unverified accounts, and a forged state", async () => {
  const env = { DB: createD1() };
  stubGoogle({ email: "stranger@bookete.com", email_verified: true });
  assert.equal((await login(env, "/")).status, 403);
  stubGoogle({ email: "jo@bookete.com", email_verified: false });
  assert.equal((await login(env, "/")).status, 403);
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first()).n, 0);
  const forged = await finishLogin(new Request("https://crm.bookete.com/auth/callback?state=x&code=c", { headers: { Cookie: "__Host-crm-login=y.v.%2F" } }), env, config);
  assert.equal(forged.status, 400);
});

test("signing out everywhere revokes every agent grant first, then ends all of the user's sessions", async () => {
  const env = await withSession("jo@bookete.com", Date.now() + 1e6);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions VALUES (?, 'jo@bookete.com', ?)").bind(await sha256("tok2"), Date.now() + 1e6),
    env.DB.prepare("INSERT INTO users (email, name, updated_at) VALUES ('partner@bookete.com', 'P', 'now')"),
    env.DB.prepare("INSERT INTO sessions VALUES (?, 'partner@bookete.com', ?)").bind(await sha256("tok3"), Date.now() + 1e6),
  ]);
  const log = [];
  const pages = { undefined: { items: [{ id: "g1" }, { id: "g2" }], cursor: "c2" }, c2: { items: [{ id: "g3" }] } };
  env.OAUTH_PROVIDER = {
    listUserGrants: async (user, { cursor }) => pages[cursor],
    revokeGrant: async (id, user) => {
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE email = 'jo@bookete.com'").first();
      log.push([id, user, n]);
    },
  };
  const post = (origin) => new Request("https://crm.bookete.com/auth/logout-all", { method: "POST", headers: { Origin: origin } });
  // A page on another bookete.com subdomain is same-site, so the cookie alone does not prove the request is ours.
  assert.equal((await logoutEverywhere(post("https://evil.bookete.com"), env, config, { email: "jo@bookete.com" })).status, 403);
  assert.deepEqual(log, []);
  const res = await logoutEverywhere(post("https://crm.bookete.com"), env, config, { email: "jo@bookete.com" });
  assert.deepEqual(log, [["g1", "jo@bookete.com", 2], ["g2", "jo@bookete.com", 2], ["g3", "jo@bookete.com", 2]]);
  assert.deepEqual((await env.DB.prepare("SELECT email FROM sessions").all()).results.map((r) => r.email), ["partner@bookete.com"]);
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.some((c) => /^__Host-crm-session=; .*Max-Age=0/.test(c)));
  // Remembered agent approvals go too, or a disconnected agent would get back in without the consent page.
  assert.ok(cookies.some((c) => /^__Host-oauth-approvals=; .*Max-Age=0/.test(c)));
});
