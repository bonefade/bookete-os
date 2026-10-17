import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { COMMANDS } from "../src/server/commands.js";
import { handleMcp } from "../src/server/mcp.js";
import { mimeMessage, createMailer } from "../src/server/gmail.js";
import { encrypt } from "../src/server/crypto.js";
import { unsubscribeUrl } from "../src/server/unsubscribe.js";
import { readConfig } from "../src/server/config.js";
import { ConflictError } from "../src/domain/errors.js";
import { readdirSync, readFileSync } from "node:fs";

const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };

function mcpContext() {
  const store = createStore(createD1());
  let n = 0;
  return { store, clock, uc: createUseCases({ store, clock, ids: { newId: () => `id${++n}` }, actor: "agent" }) };
}
const call = async (context, method, params) => (await (await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), context)).json());

test("optOutAt can only be set through optOut, never through lead input", () => {
  assert.equal(COMMANDS.updateLead[0].safeParse({ id: "a", input: { optOutAt: null } }).success, false);
  assert.equal(COMMANDS.updateField[0].safeParse({ id: "a", key: "optOutAt", value: null }).success, false);
  assert.equal(COMMANDS.updateLead[0].safeParse({ id: "a", input: { name: "ok" } }).success, true);
});

test("no code outside the web app imports the web layer", () => {
  // Every file under src/, so a new directory is checked too.
  const src = new URL("../src/", import.meta.url);
  for (const file of readdirSync(src, { recursive: true }).filter((f) => f.endsWith(".js") && !f.startsWith("web/")))
    assert.doesNotMatch(readFileSync(new URL(file, src), "utf8"), /(?:from|import)\s*\(?\s*["'][^"']*\/web\//, file);
});

test("MCP exposes exactly these tools: no delete, no send", async () => {
  const { result } = await call(mcpContext(), "tools/list");
  assert.deepEqual(result.tools.map((t) => t.name).sort(), [
    "change_status", "create_gmail_draft", "create_lead", "get_lead", "list_templates",
    "log_activity", "log_call", "render_template", "search_leads", "set_follow_up", "update_account", "update_lead",
  ]);
});

test("MCP writes go through the use cases and their rules", async () => {
  const context = mcpContext();
  const created = await call(context, "tools/call", { name: "create_lead", arguments: { name: "Agent Wirt", email: "a@example.at" } });
  const { id } = JSON.parse(created.result.content[0].text);
  await context.uc.optOut(id);
  const blocked = await call(context, "tools/call", { name: "log_activity", arguments: { id, direction: "out", channel: "E-Mail", text: "Hallo" } });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /Opt-out/);
  const bad = await call(context, "tools/call", { name: "create_lead", arguments: {} });
  assert.equal(bad.result.isError, true);
});

test("an agent cannot fill a call script as a message", async () => {
  const context = mcpContext();
  const id = await context.uc.addLead({ name: "Agent Wirt" });
  const templateId = await context.uc.saveTemplate(null, { name: "Leitfaden", purpose: "leitfaden", body: "Gr\xFC\xDF Gott, {Betrieb}" });
  const res = await call(context, "tools/call", { name: "render_template", arguments: { id, templateId } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /keine Nachricht/);
});

test("an agent whose write keeps losing races gets the conflict as a tool error, not a crash", async () => {
  const context = mcpContext();
  const id = await context.uc.addLead({ name: "Agent Wirt" });
  const busy = { ...context.store, commit: async () => { throw new ConflictError(); } };
  const res = await call({ ...context, uc: createUseCases({ store: busy, clock, ids: { newId: () => "x" }, actor: "agent" }) }, "tools/call", { name: "update_lead", arguments: { id, fields: { notes: "Neu" } } });
  assert.equal(res.result.isError, true);
  assert.equal(res.result.content[0].text, new ConflictError().message);
});

test("MCP answers notifications with 202 and unknown methods with a JSON-RPC error", async () => {
  const res = await handleMcp(new Request("https://crm/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), mcpContext());
  assert.equal(res.status, 202);
  assert.equal((await call(mcpContext(), "resources/list")).error.code, -32601);
});

test("mail headers refuse line breaks", () => {
  assert.throws(() => mimeMessage({ from: { email: "jo@bookete.com", name: "Jo" }, to: "a@example.at", subject: "Hi\r\nBcc: x@evil.test", text: "t" }));
  const raw = Buffer.from(mimeMessage({ from: { email: "jo@bookete.com", name: "Jö" }, to: "a@example.at", subject: "Grüße", text: "Grüß Gott" }), "base64url").toString();
  assert.match(raw, /^From: =\?UTF-8\?B\?/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
});

test("a mail, sent or drafted, ends with the lead's unsubscribe link and carries the one-click headers; a service mail goes without", async () => {
  const config = { PUBLIC_URL: "https://crm.bookete.com", CONSENT_SECRET: "c".repeat(32), TOKEN_KEY: btoa("k".repeat(32)), GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" };
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://oauth2")) return Response.json({ access_token: "a" });
    posted.push(JSON.parse(init.body));
    return Response.json({ id: "m1", threadId: "t1" });
  };
  try {
    const mailer = await createMailer(config, { email: "jo@bookete.com", name: "Jo", refreshToken: await encrypt(config.TOKEN_KEY, "rt") });
    await mailer.send({ leadId: "L1", to: "a@example.at", subject: "Hallo", text: "Grüß Gott" });
    await mailer.draft({ leadId: "L1", to: "a@example.at", subject: "Hallo", text: "Grüß Gott" });
    await mailer.send({ leadId: "L1", to: "a@example.at", subject: "Hallo", text: "Grüß Gott", serviceMail: true });
  } finally {
    globalThis.fetch = realFetch;
  }
  const link = await unsubscribeUrl(config, "L1");
  for (const raw of [posted[0].raw, posted[1].message.raw]) {
    const [head, body] = Buffer.from(raw, "base64url").toString().split("\r\n\r\n");
    assert.match(head, new RegExp(`\r\nList-Unsubscribe: <${link.replace(/[.]/g, "\\.")}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`));
    assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString(), `Grüß Gott\n\nSie möchten keine E-Mails mehr von uns? Abmelden: ${link}`);
  }
  const [head, body] = Buffer.from(posted[2].raw, "base64url").toString().split("\r\n\r\n");
  assert.doesNotMatch(head, /List-Unsubscribe/);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString(), "Grüß Gott");
  assert.throws(() => mimeMessage({ from: { email: "jo@bookete.com", name: "Jo" }, to: "a@example.at", subject: "Hi", text: "t", unsubscribe: "https://x\r\nBcc: x@evil.test" }));
});

test("configuration fails closed", () => {
  const ok = { PUBLIC_URL: "https://crm.bookete.com", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", TOKEN_KEY: btoa("x".repeat(32)), CONSENT_SECRET: "c".repeat(32), ALLOWED_EMAILS: "Jo@bookete.com, partner@bookete.com", AUTH_LIMIT: { limit: async () => ({ success: true }) } };
  assert.deepEqual(readConfig(ok).ALLOWED_EMAILS, ["jo@bookete.com", "partner@bookete.com"]);
  assert.throws(() => readConfig({ ...ok, TOKEN_KEY: btoa("short") }));
  assert.throws(() => readConfig({ ...ok, ALLOWED_EMAILS: "" }));
  assert.throws(() => readConfig({ ...ok, GOOGLE_CLIENT_SECRET: undefined }));
  assert.throws(() => readConfig({ ...ok, AUTH_LIMIT: undefined }));
});
