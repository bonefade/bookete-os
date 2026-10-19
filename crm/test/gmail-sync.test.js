import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1.js";
import { createStore } from "../src/server/store.js";
import { createUseCases } from "../src/application/use-cases.js";
import { createMailer, mailText } from "../src/server/gmail.js";
import { syncMail } from "../src/server/sync.js";
import { allowedUser } from "../src/server/auth.js";
import { readConfig } from "../src/server/config.js";
import { encrypt } from "../src/server/crypto.js";
import { mailActivityId } from "../src/domain/activity.js";

const READ = "openid email profile https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly";
const config = readConfig({
  PUBLIC_URL: "https://crm.bookete.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
  TOKEN_KEY: btoa("k".repeat(32)), CONSENT_SECRET: "c".repeat(32), ALLOWED_EMAILS: "jo@bookete.com,partner@bookete.com",
  AUTH_LIMIT: { limit: async () => ({ success: true }) },
});
const clock = { today: () => "2026-10-15", now: () => "2026-10-15T10:00:00.000Z" };
const [realFetch, realError] = [globalThis.fetch, console.error];
afterEach(() => { [globalThis.fetch, console.error] = [realFetch, realError]; });

/**
 * Gmail for each mailbox, behind a fetch double that counts every call of a run: its messages, in the order they
 * came, and a history record for each. Searches give 3 results a page, so a backfill takes several.
 */
function fakeGmail() {
  const boxes = new Map();
  const box = (email) => {
    if (!boxes.has(email)) boxes.set(email, { messages: new Map(), history: [], historyId: 1000, oldest: 0, n: 0, signature: "" });
    return boxes.get(email);
  };
  const addressesIn = (m) => [m.from, m.to, m.cc].join(" ").toLowerCase();
  // In the metadata format, only the headers asked for, as Gmail answers.
  const json = (m, full, wanted) => ({
    id: m.id, threadId: m.threadId, labelIds: m.labels, internalDate: String(Date.parse(m.at)),
    payload: { mimeType: "text/plain", headers: [["From", m.from], ["To", m.to], ["Cc", m.cc], ["Subject", m.subject], ["Message-ID", m.messageId ?? `<${m.id}@mail>`], ...(m.auto ? [["Auto-Submitted", m.auto]] : [])].filter(([name]) => full || wanted.includes(name)).map(([name, value]) => ({ name, value })), ...(full && { body: { data: Buffer.from(m.text).toString("base64url") } }) },
  });
  const gmail = {
    calls: 0,
    /** What was sent: the raw message and the thread Gmail was asked to put it in. */
    sent: [],
    /** The raw messages of the drafts made. */
    drafts: [],
    box,
    /**
     * A message arriving in `email`'s mailbox now, in a history record of its own or, `join`, in the last one; its Gmail
     * id. `messageId`, its Message-ID when it is a copy of one in another mailbox; `auto`, its Auto-Submitted header.
     */
    add(email, { threadId, from, to, cc = "", subject = "Tische", text = "Hallo", at = "2026-10-14T08:00:00.000Z", labels = ["INBOX"], join = false, messageId, auto }) {
      const b = box(email);
      const id = `${email.split("@")[0]}-${++b.n}`;
      b.messages.set(id, { id, threadId: threadId ?? `t-${id}`, from, to, cc, subject, text, at, labels, messageId, auto });
      const added = { message: { id, threadId: threadId ?? `t-${id}`, labelIds: labels } };
      if (join) b.history.at(-1).messagesAdded.push(added);
      else b.history.push({ id: String(++b.historyId), messagesAdded: [added] });
      return id;
    },
    async fetch(url, init = {}) {
      gmail.calls++;
      const u = new URL(url);
      if (u.host === "oauth2.googleapis.com") return Response.json({ access_token: "at:" + new URLSearchParams(init.body.toString()).get("refresh_token").slice(3) });
      const b = box(init.headers.Authorization.slice("Bearer at:".length));
      const path = u.pathname.replace("/gmail/v1/users/me/", "");
      const p = u.searchParams;
      if (path === "profile") return Response.json({ historyId: String(b.historyId) });
      if (path === "settings/sendAs" && b.signature === null) return new Response("{}", { status: 500 });
      if (path === "settings/sendAs") return Response.json({ sendAs: [{ sendAsEmail: "alias@bookete.com", signature: "<b>Alias</b>" }, { sendAsEmail: init.headers.Authorization.slice("Bearer at:".length).toUpperCase(), signature: b.signature }] });
      if (path === "history") {
        const start = Number(p.get("startHistoryId"));
        if (start < b.oldest) return new Response("{}", { status: 404 });
        const after = b.history.filter((h) => Number(h.id) > start);
        const page = after.slice(0, Number(p.get("maxResults")));
        return Response.json({ historyId: String(b.historyId), history: page, ...(after.length > page.length && { nextPageToken: "more" }) });
      }
      if (path === "messages") {
        const q = p.get("q");
        const after = Number(q.match(/after:(\d+)/)[1]) * 1000;
        const wanted = [...q.matchAll(/from:(\S+)/g)].map((m) => m[1]);
        const found = [...b.messages.values()].filter((m) => Date.parse(m.at) > after && wanted.some((a) => addressesIn(m).includes(a))).reverse();
        const offset = Number(p.get("pageToken") || 0);
        return Response.json({ messages: found.slice(offset, offset + 3).map(({ id, threadId }) => ({ id, threadId })), ...(found.length > offset + 3 && { nextPageToken: String(offset + 3) }) });
      }
      if (path === "drafts") {
        gmail.drafts.push(Buffer.from(JSON.parse(init.body).message.raw, "base64url").toString());
        return Response.json({ id: `d${gmail.drafts.length}` });
      }
      if (path === "messages/send") {
        const { raw: encoded, threadId } = JSON.parse(init.body);
        const raw = Buffer.from(encoded, "base64url").toString();
        gmail.sent.push({ raw, threadId });
        const to = raw.match(/^To: (.*)$/m)[1];
        return Response.json(b.messages.get(gmail.add(init.headers.Authorization.slice("Bearer at:".length), { threadId, from: "jo@bookete.com", to, labels: ["SENT"], at: clock.now() })));
      }
      const m = b.messages.get(decodeURIComponent(path.replace("messages/", "")));
      return m ? Response.json(json(m, p.get("format") === "full", p.getAll("metadataHeaders"))) : new Response("{}", { status: 404 });
    },
  };
  return gmail;
}

async function setup({ users = { "jo@bookete.com": READ } } = {}) {
  const db = createD1();
  for (const [email, scopes] of Object.entries(users)) {
    await db.prepare("INSERT INTO users (email, name, refresh_token, scopes, updated_at) VALUES (?, ?, ?, ?, 'now')").bind(email, email.split("@")[0], await encrypt(config.TOKEN_KEY, "rt:" + email), scopes).run();
  }
  const store = createStore(db);
  let n = 0;
  const ids = { newId: () => `id${++n}` };
  const gmail = fakeGmail();
  globalThis.fetch = gmail.fetch;
  const errors = [];
  console.error = (...args) => errors.push(args);
  return {
    db, store, gmail,
    uc: createUseCases({ store, clock, ids, actor: "jo@bookete.com (web)" }),
    /** One cron run, as one Worker invocation: past 50 D1 queries the store throws, and the run logs that as a failure. */
    async run() {
      gmail.calls = 0;
      await syncMail({ env: { DB: db.invocation() }, config, clock, ids });
      assert.ok(gmail.calls <= 50, `${gmail.calls} subrequests`);
      assert.deepEqual(errors, []);
    },
    cursor: async (email = "jo@bookete.com") => JSON.parse((await db.prepare("SELECT gmail_cursor FROM users WHERE email = ?").bind(email).first()).gmail_cursor),
    sender: async () => createUseCases({ store, clock, ids, actor: "jo@bookete.com (web)", mailer: await createMailer(config, await allowedUser({ DB: db }, config, "jo@bookete.com")) }),
  };
}
/** A mail's parts, decoded: the text, then the HTML when it has one. */
const parts = (raw) => [...raw.matchAll(/Content-Type: text\/(?:plain|html); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/g)]
  .map(([, b]) => Buffer.from(b.replace(/\r\n/g, ""), "base64").toString());
const texts = async (store, id) => (await store.activitiesOf(id)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map((a) => `${a.direction} ${a.text}`);

test("the first run logs a lead's mail of the last 30 days, oldest first; later runs what Gmail adds", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "Info@Krone.at " });
  s.gmail.add("jo@bookete.com", { from: "Krone <info@krone.at>", to: "jo@bookete.com", text: "Gibt es das auch für uns?", at: "2026-10-01T08:00:00.000Z" });
  s.gmail.add("jo@bookete.com", { from: "Jo <jo@bookete.com>", to: "INFO@krone.at", subject: "Re: Tische", text: "Gerne!\n\nAm Mi., 1. Okt. 2026 um 10:00 Uhr schrieb Krone <\ninfo@krone.at>:\n> Gibt es das auch für uns?", at: "2026-10-02T08:00:00.000Z", labels: ["SENT"] });
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Zu alt", at: "2026-09-01T08:00:00.000Z" });
  s.gmail.add("jo@bookete.com", { from: "news@shop.at", to: "jo@bookete.com", text: "Angebot" });
  await s.run();
  assert.deepEqual(await texts(s.store, id), ["in Gibt es das auch für uns?", "out Gerne!"]);
  const [first, answer] = (await s.store.activitiesOf(id)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const gmailId = answer.mail.gmailId;
  assert.equal(answer.id, await mailActivityId("jo@bookete.com", gmailId));
  assert.deepEqual(answer.mail, { gmailId, threadId: `t-${gmailId}`, mailbox: "jo@bookete.com", subject: "Re: Tische", from: "jo@bookete.com", to: "INFO@krone.at", messageId: `<${gmailId}@mail>` });
  assert.deepEqual([first.date, first.createdAt, first.channel], ["2026-10-01", "2026-10-01T08:00:00.000Z", "E-Mail"]);
  // Their mail came first and was answered: the reply was to be answered, and then it was.
  const l = await s.store.get("leads", id);
  assert.deepEqual([l.status, l.contactedAt, l.followUp, l.nextStep], ["kontaktiert", "2026-10-01", "2026-10-15", ""]);
  assert.deepEqual(await s.cursor(), { historyId: "1004" });

  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Passt Donnerstag?", at: "2026-10-15T09:00:00.000Z" });
  await s.run();
  assert.equal((await texts(s.store, id)).at(-1), "in Passt Donnerstag?");
  const after = await s.store.get("leads", id);
  assert.deepEqual([after.followUp, after.nextStep], ["2026-10-15", "Antworten"]);
  assert.deepEqual(await s.cursor(), { historyId: "1005" });
});

test("a reply in a thread the CRM sent is logged on that lead from any address, and the sent mail only once", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  await s.run();
  const sent = await (await s.sender()).sendEmail(id, { subject: "Tische", text: "Grüß Gott" });
  assert.deepEqual(sent.activity.mail, { gmailId: sent.gmail.id, threadId: sent.gmail.threadId, mailbox: "jo@bookete.com", subject: "Tische", from: "jo@bookete.com", to: "info@krone.at", messageId: `<${sent.gmail.id}@mail>` });
  assert.equal(sent.activity.id, await mailActivityId("jo@bookete.com", sent.gmail.id));
  s.gmail.add("jo@bookete.com", { threadId: sent.gmail.threadId, from: "Maria Huber <chefin@gmail.com>", to: "jo@bookete.com", text: "Rufen Sie mich an.", at: "2026-10-15T10:30:00.000Z" });
  await s.run();
  assert.deepEqual(await texts(s.store, id), ["out Grüß Gott", "in Rufen Sie mich an."]);
  const l = await s.store.get("leads", id);
  assert.deepEqual([l.followUp, l.nextStep], ["2026-10-15", "Antworten"]);
  // The answer goes into that thread, referring to the mail it answers; one answering nothing starts a thread of its own.
  const reply = (await s.store.activitiesOf(id)).find((a) => a.direction === "in");
  const answer = await (await s.sender()).sendEmail(id, { subject: "Re: Tische", text: "Gerne, wann?", replyTo: reply.id });
  assert.equal(answer.activity.mail.threadId, sent.gmail.threadId);
  assert.equal(s.gmail.sent.at(-1).threadId, sent.gmail.threadId);
  assert.match(s.gmail.sent.at(-1).raw, new RegExp(`^In-Reply-To: <${reply.mail.gmailId}@mail>\r\nReferences: <${reply.mail.gmailId}@mail>\r$`, "m"));
  await (await s.sender()).sendEmail(id, { subject: "Neu", text: "Noch etwas" });
  assert.deepEqual([s.gmail.sent.at(-1).threadId, /In-Reply-To/.test(s.gmail.sent.at(-1).raw)], [undefined, false]);
  await assert.rejects((await s.sender()).sendEmail(id, { subject: "Re", text: "x", replyTo: "gone" }), { message: "Die beantwortete E-Mail gibt es nicht mehr." });
});

test("in a thread the CRM sent, mail with no one else on it, an out-of-office reply and a bounce are not logged", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  await s.run();
  const sent = await (await s.sender()).sendEmail(id, { subject: "Tische", text: "Grüß Gott" });
  const threadId = sent.gmail.threadId;
  s.gmail.add("jo@bookete.com", { threadId, from: "jo@bookete.com", to: "partner@bookete.com", text: "Was meinst du?", at: "2026-10-15T10:10:00.000Z" });
  s.gmail.add("jo@bookete.com", { threadId, from: "info@krone.at", to: "jo@bookete.com", text: "Bin auf Urlaub", auto: "auto-replied", at: "2026-10-15T10:11:00.000Z" });
  s.gmail.add("jo@bookete.com", { threadId, from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", to: "jo@bookete.com", text: "Nicht zugestellt", at: "2026-10-15T10:12:00.000Z" });
  s.gmail.add("jo@bookete.com", { threadId, from: "info@krone.at", to: "jo@bookete.com", text: "Gerne", auto: "no", at: "2026-10-15T10:13:00.000Z" });
  await s.run();
  assert.deepEqual(await texts(s.store, id), ["out Grüß Gott", "in Gerne"]);
});

test("the first run leaves what a lead holds as it is: a mail logged without Gmail, which takes that mail, and the plan a later contact made", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  // Sent before 1.17.0, logged with no Gmail id; then, spoken with, planned by hand.
  await s.uc.logActivity(id, { direction: "out", channel: "E-Mail", date: "2026-10-05", text: "Grüß Gott" });
  await s.uc.changeStatus(id, "kontaktiert");
  await s.uc.setFollowUp(id, "2026-10-25");
  await s.uc.setNextStep(id, "Anrufen am Dienstag");
  s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: "info@krone.at", text: "Grüß Gott", labels: ["SENT"], at: "2026-10-05T08:00:00.000Z" });
  // Written in Gmail before it, never logged: logged now, and the plan stays.
  s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: "info@krone.at", text: "Vorab", labels: ["SENT"], at: "2026-10-03T08:00:00.000Z" });
  await s.run();
  assert.deepEqual((await s.store.activitiesOf(id)).sort((a, b) => a.date < b.date ? -1 : 1).map((a) => `${a.date} ${a.text}`), ["2026-10-03 Vorab", "2026-10-05 Grüß Gott"]);
  const l = await s.store.get("leads", id);
  // Mails of ours are attempts: they leave the day we first spoke with them as it is.
  assert.deepEqual([l.status, l.followUp, l.nextStep, l.contactedAt], ["kontaktiert", "2026-10-25", "Anrufen am Dienstag", "2026-10-15"]);
  const entry = (await s.store.activitiesOf(id)).find((a) => a.text === "Grüß Gott");
  assert.equal(entry.mail.gmailId, "jo-1");
});

test("an entry made without Gmail stands for one mail that came before it; later mail of that day is logged", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const later = await s.uc.addLead({ name: "Post", email: "info@post.at" });
  const ours = await s.uc.addLead({ name: "Stern", email: "info@stern.at" });
  for (const lead of [id, later]) await s.uc.logActivity(lead, { direction: "in", channel: "E-Mail", text: "Antwort per Hand" });
  // Entered as sent, then sent from Gmail.
  await s.uc.logActivity(ours, { direction: "out", channel: "E-Mail", text: "Gesendet per Hand" });
  s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: "info@stern.at", text: "Grüß Gott", labels: ["SENT"], at: "2026-10-15T10:20:00.000Z" });
  for (const [hour, text] of [["08", "Eins"], ["09", "Zwei"], ["12", "Drei"]]) {
    s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text, at: `2026-10-15T${hour}:00:00.000Z` });
  }
  s.gmail.add("jo@bookete.com", { from: "info@post.at", to: "jo@bookete.com", text: "Nachher", at: "2026-10-15T12:00:00.000Z" });
  await s.run();
  await s.run();
  // The entry took the first mail and its time.
  assert.deepEqual(await texts(s.store, id), ["in Antwort per Hand", "in Zwei", "in Drei"]);
  assert.equal((await s.store.activitiesOf(id)).find((a) => a.text === "Antwort per Hand").mail.gmailId, "jo-2");
  assert.deepEqual(await texts(s.store, later), ["in Antwort per Hand", "in Nachher"]);
  assert.deepEqual(await texts(s.store, ours), ["out Gesendet per Hand"]);
  // Found again (the backfill runs again after a long pause): the entry is that message, Message-ID or not.
  const taken = (await s.store.activitiesOf(id)).find((a) => a.text === "Antwort per Hand");
  assert.equal(await s.uc.recordMail(id, { direction: "in", date: "2026-10-15", at: "2026-10-15T08:00:00.000Z", text: "Eins", mail: { ...taken.mail, messageId: "" } }), null);
});

test("a reply entered by hand after our answer went from Gmail sorts where it came, so the answer ends \"Antworten\"", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Was kostet das?", at: "2026-10-15T08:00:00.000Z" });
  s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: "info@krone.at", text: "Nichts", labels: ["SENT"], at: "2026-10-15T09:00:00.000Z" });
  await s.uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Antwort per Hand" });
  await s.run();
  assert.deepEqual(await texts(s.store, id), ["in Antwort per Hand", "out Nichts"]);
  const l = await s.store.get("leads", id);
  assert.deepEqual([l.followUp, l.nextStep], ["2026-10-19", ""]);
});

test("of two entries a mail can be, the one made first takes it", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const [later, first] = [await s.uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Später" }), await s.uc.logActivity(id, { direction: "in", channel: "E-Mail", text: "Zuerst" })];
  // Made at 11:00 and 10:30 (an import keeps such times), though held in the other order.
  for (const [{ activity }, at] of [[later, "2026-10-15T11:00:00.000Z"], [first, "2026-10-15T10:30:00.000Z"]]) {
    await s.db.prepare("UPDATE docs SET data = json_set(data, '$.createdAt', ?) WHERE collection = 'activities' AND id = ?").bind(at, activity.id).run();
  }
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Eins", at: "2026-10-15T08:00:00.000Z" });
  await s.run();
  assert.deepEqual((await s.store.activitiesOf(id)).map((a) => `${a.text} ${a.mail?.gmailId ?? "-"}`).sort(), ["Später -", "Zuerst jo-1"]);
});

test("a business closed after a mail came stays closed when the sync finds the mail; one that came after reopens it", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  await s.uc.logActivity(id, { direction: "out", channel: "Telefon", date: "2026-10-06", text: "Angerufen" });
  // Added and called on 10-01, as the history says; closed now, on 10-15.
  await s.db.prepare("UPDATE history SET after = json_set(after, '$.updatedAt', '2026-10-01T08:00:00.000Z') WHERE collection = 'leads' AND id = ?").bind(id).run();
  await s.uc.changeStatus(id, "disqualifiziert", "Kein Bedarf");
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Kein Interesse", at: "2026-10-07T08:00:00.000Z" });
  await s.run();
  const closed = await s.store.get("leads", id);
  assert.deepEqual([closed.status, closed.lostReason, closed.followUp, closed.nextStep], ["disqualifiziert", "Kein Bedarf", null, ""]);
  assert.deepEqual(await texts(s.store, id), ["in Kein Interesse", "out Angerufen"]);
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Doch, gerne", at: "2026-10-15T10:30:00.000Z" });
  await s.run();
  const reopened = await s.store.get("leads", id);
  assert.deepEqual([reopened.status, reopened.lostReason, reopened.followUp, reopened.nextStep], ["kontaktiert", null, "2026-10-15", "Antworten"]);
});

test("a reply the sync finds after a person planned the lead leaves the plan; one that came after it is to be answered", async () => {
  const s = await setup();
  const old = (id) => s.db.prepare("UPDATE history SET after = json_set(after, '$.updatedAt', '2026-10-01T08:00:00.000Z') WHERE collection = 'leads' AND id = ?").bind(id).run();
  // Called and planned on 10-01, as the history says; then one part of the plan set again now, on 10-15.
  const plan = [["Krone", "info@krone.at", (id) => s.uc.setFollowUp(id, "2026-10-25")], ["Post", "info@post.at", (id) => s.uc.setNextStep(id, "Angebot schicken")]];
  const ids = [];
  for (const [name, email, setNow] of plan) {
    const id = await s.uc.addLead({ name, email });
    await s.uc.logActivity(id, { direction: "out", channel: "Vor Ort", date: "2026-10-06", text: "Besucht" });
    await s.uc.setFollowUp(id, "2026-10-20");
    await s.uc.setNextStep(id, "Nachfragen");
    await old(id);
    await setNow(id);
    s.gmail.add("jo@bookete.com", { from: email, to: "jo@bookete.com", text: "Schicken Sie mehr", at: "2026-10-07T08:00:00.000Z" });
    ids.push(id);
  }
  await s.run();
  const planned = await Promise.all(ids.map((id) => s.store.get("leads", id)));
  // What was set since stays; the rest the reply plans.
  assert.deepEqual(planned.map((l) => [l.followUp, l.nextStep]), [["2026-10-25", "Antworten"], ["2026-10-15", "Angebot schicken"]]);
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Und?", at: "2026-10-15T10:30:00.000Z" });
  await s.run();
  const after = await s.store.get("leads", ids[0]);
  assert.deepEqual([after.followUp, after.nextStep], ["2026-10-15", "Antworten"]);
});

test("an answer written in Gmail ends \"Antworten\" though a person moved the lead on before the sync found it; a reply leaves a status set since", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const kunde = await s.uc.addLead({ name: "Post", email: "info@post.at" });
  const only = await s.uc.addLead({ name: "Stern", email: "info@stern.at" });
  for (const email of ["info@krone.at", "info@stern.at"]) s.gmail.add("jo@bookete.com", { from: email, to: "jo@bookete.com", text: "Was kostet das?", at: "2026-10-15T08:00:00.000Z" });
  await s.run();
  for (const email of ["info@krone.at", "info@stern.at"]) s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: email, text: "Nichts", labels: ["SENT"], at: "2026-10-15T09:30:00.000Z" });
  s.gmail.add("jo@bookete.com", { from: "info@post.at", to: "jo@bookete.com", text: "Wir nehmen es", at: "2026-10-15T09:40:00.000Z" });
  await s.uc.setFollowUp(id, "2026-10-25");
  await s.uc.changeStatus(id, "qualifiziert");
  await s.uc.changeStatus(kunde, "kunde");
  // Only the status set since: the answer dates the next follow-up.
  await s.uc.changeStatus(only, "qualifiziert");
  await s.run();
  const leads = await Promise.all([id, kunde, only].map((x) => s.store.get("leads", x)));
  assert.deepEqual(leads.map((l) => [l.status, l.followUp, l.nextStep]), [["qualifiziert", "2026-10-25", ""], ["kunde", "2026-10-15", "Vertrag unterschrieben"], ["qualifiziert", "2026-10-19", ""]]);
});

test("a mail sent from the CRM and found again stays on its own entry, not on one entered by hand that day", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const { activity } = await s.uc.logActivity(id, { direction: "out", channel: "E-Mail", text: "Per Hand eingetragen" });
  await s.db.prepare("UPDATE docs SET data = json_set(data, '$.createdAt', '2026-10-15T07:00:00.000Z') WHERE collection = 'activities' AND id = ?").bind(activity.id).run();
  const sent = await (await s.sender()).sendEmail(id, { subject: "Tische", text: "Per CRM gesendet" });
  assert.equal(await s.uc.recordMail(id, { direction: "out", date: "2026-10-15", at: sent.activity.createdAt, text: "Per CRM gesendet", mail: sent.activity.mail }), null);
  assert.deepEqual((await s.store.activitiesOf(id)).map((a) => `${a.text} ${a.mail?.gmailId ?? "-"}`).sort(), ["Per CRM gesendet jo-1", "Per Hand eingetragen -"]);
});

test("a mail from the CRM carries the user's Gmail signature, as HTML and as text after \"-- \", before the Abmeldelink; a draft too", async () => {
  const s = await setup();
  const box = s.gmail.box("jo@bookete.com");
  box.signature = '<div>Jo Meindl<br><a href="https://bookete.com">bookete.com</a></div>';
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const kunde = await s.uc.addLead({ name: "Post", email: "info@post.at" });
  await s.uc.changeStatus(kunde, "kunde");
  const sender = await s.sender();
  assert.deepEqual(await sender.signature(), { has: true, text: "Jo Meindl\nbookete.com" });
  await sender.sendEmail(id, { subject: "Tische", text: "Grüß Gott <Chef>" });
  const raw = s.gmail.sent.at(-1).raw;
  assert.match(raw, /^Content-Type: multipart\/alternative; boundary="=_bookete-crm"\r$/m);
  const [plain, html] = parts(raw);
  assert.match(plain, /^Grüß Gott <Chef>\n\n-- \nJo Meindl\nbookete\.com\n\nSie möchten keine E-Mails mehr von uns\? Abmelden: https:\/\/crm\.bookete\.com\/\S+$/);
  assert.match(html, /^<div dir="ltr">Grüß Gott &lt;Chef&gt;<\/div><br><div class="gmail_signature"><div>Jo Meindl<br><a href="https:\/\/bookete\.com">bookete\.com<\/a><\/div><\/div><p [^>]+>Sie möchten keine E-Mails mehr von uns\? <a href="https:\/\/crm\.bookete\.com\/[^"]+">Abmelden<\/a><\/p>$/);
  // Logged as written, without the signature.
  assert.deepEqual(await texts(s.store, id), ["out Grüß Gott <Chef>"]);
  // A Kunde's service mail: signed, no Abmeldelink.
  await sender.sendEmail(kunde, { subject: "Rechnung", text: "Anbei" });
  assert.deepEqual(parts(s.gmail.sent.at(-1).raw).map((p) => /Abmelden/.test(p)), [false, false]);
  // Left out, or none in Gmail: plain text, as before.
  await sender.sendEmail(id, { subject: "Kurz", text: "Danke", signed: false });
  box.signature = "";
  assert.deepEqual(await sender.signature(), { has: false, text: "" });
  await sender.sendEmail(id, { subject: "Kurz", text: "Bis bald" });
  for (const { raw: plainOnly } of s.gmail.sent.slice(-2)) {
    assert.doesNotMatch(plainOnly, /multipart/);
    assert.doesNotMatch(parts(plainOnly)[0], /-- \n/);
  }
  box.signature = "<b>Jo</b>";
  await sender.draftEmail(id, { subject: "Entwurf", text: "Hallo" });
  assert.match(parts(s.gmail.drafts.at(-1))[0], /^Hallo\n\n-- \nJo\n\n/);
  // Only a logo: in the HTML part, and no empty "-- " block in the text.
  box.signature = '<div><img src="https://lh3.googleusercontent.com/logo.png" width="120"></div>';
  assert.deepEqual(await sender.signature(), { has: true, text: "" });
  await sender.sendEmail(kunde, { subject: "Logo", text: "Hallo" });
  const [logoText, logoHtml] = parts(s.gmail.sent.at(-1).raw);
  assert.deepEqual([logoText, /<img src="https:\/\/lh3\.googleusercontent\.com\/logo\.png"/.test(logoHtml)], ["Hallo", true]);
  // When Gmail cannot give the signature, nothing goes out and nothing is logged.
  box.signature = null;
  const before = [s.gmail.sent.length, (await s.store.activitiesOf(id)).length];
  await assert.rejects(sender.sendEmail(id, { subject: "Tische", text: "Noch einmal" }), { message: "Gmail-Fehler 500" });
  assert.deepEqual([s.gmail.sent.length, (await s.store.activitiesOf(id)).length], before);
});

test("without the gmail.readonly grant, mail goes out without a signature and the composer is told so", async () => {
  const s = await setup({ users: { "jo@bookete.com": "openid email profile https://www.googleapis.com/auth/gmail.compose" } });
  s.gmail.box("jo@bookete.com").signature = "<b>Jo</b>";
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const sender = await s.sender();
  assert.equal(await sender.signature(), null);
  await sender.sendEmail(id, { subject: "Tische", text: "Grüß Gott" });
  assert.doesNotMatch(s.gmail.sent.at(-1).raw, /multipart/);
});

test("a mail in both mailboxes is logged once", async () => {
  const s = await setup({ users: { "jo@bookete.com": READ, "partner@bookete.com": READ } });
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  for (const box of ["jo@bookete.com", "partner@bookete.com"]) s.gmail.add(box, { from: "info@krone.at", to: "jo@bookete.com, partner@bookete.com", text: "An beide", messageId: "<eins@krone.at>" });
  await s.run();
  await s.run();
  assert.deepEqual(await texts(s.store, id), ["in An beide"]);
});

test("a mail is logged once, whoever logs it first; one found after a later contact is not to be answered", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at", phone: "+43 1" });
  const mail = { gmailId: "g1", threadId: "t1", mailbox: "jo@bookete.com", subject: "Tische", from: "info@krone.at", to: "jo@bookete.com" };
  const found = { direction: "in", date: "2026-10-15", at: "2026-10-15T08:00:00.000Z", text: "Hallo", mail };
  // In the sequence, so the missed call plans the next try.
  await s.uc.changeStatus(id, "kontaktiert");
  await s.uc.logCall(id, { outcome: "nicht-erreicht" });
  assert.ok(await s.uc.recordMail(id, found));
  assert.equal(await s.uc.recordMail(id, found), null);
  assert.equal((await s.store.activitiesOf(id)).length, 2);
  const l = await s.store.get("leads", id);
  assert.deepEqual([l.followUp, l.nextStep], ["2026-10-17", ""]);
});

test("never by domain, never an address of ours, never a draft", async () => {
  const s = await setup();
  const krone = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const colleague = await s.uc.addLead({ name: "Test", email: "partner@bookete.com" });
  const ownDomain = await s.uc.addLead({ name: "Events", email: "events@bookete.com" });
  await s.run();
  s.gmail.add("jo@bookete.com", { from: "office@krone.at", to: "jo@bookete.com", text: "Andere Adresse" });
  s.gmail.add("jo@bookete.com", { from: "partner@bookete.com", to: "jo@bookete.com", text: "Intern" });
  s.gmail.add("jo@bookete.com", { from: "events@bookete.com", to: "jo@bookete.com", text: "Intern" });
  s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: "info@krone.at", text: "Entwurf", labels: ["DRAFT"] });
  await s.run();
  for (const id of [krone, colleague, ownDomain]) assert.deepEqual(await texts(s.store, id), []);
  // A colleague writing to the lead from their own mailbox, with this one in Cc, is our mail going out.
  s.gmail.add("jo@bookete.com", { from: "partner@bookete.com", to: "info@krone.at", cc: "jo@bookete.com", text: "Von Partner" });
  await s.run();
  assert.deepEqual(await texts(s.store, krone), ["out Von Partner"]);
});

test("mail written in Gmail to a closed address is not logged as sent; a reply is logged, also on an opted-out lead", async () => {
  const s = await setup();
  const closed = await s.uc.addLead({ name: "Alte Krone", email: "info@krone.at" });
  await s.uc.optOut(closed);
  const again = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  const out = await s.uc.addLead({ name: "Zu", email: "zu@example.at" });
  await s.uc.optOut(out);
  await s.run();
  s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: "info@krone.at", text: "Neuer Versuch", labels: ["SENT"] });
  s.gmail.add("jo@bookete.com", { from: "jo@bookete.com", to: "zu@example.at", text: "Trotzdem", labels: ["SENT"] });
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Wer sind Sie?" });
  s.gmail.add("jo@bookete.com", { from: "zu@example.at", to: "jo@bookete.com", text: "Bitte nicht mehr" });
  await s.run();
  assert.deepEqual(await texts(s.store, again), ["in Wer sind Sie?"]);
  assert.ok((await texts(s.store, out)).includes("in Bitte nicht mehr"));
  assert.equal((await texts(s.store, out)).filter((t) => t.startsWith("out")).length, 0);
  const l = await s.store.get("leads", out);
  assert.deepEqual([l.status, l.followUp, l.nextStep], ["disqualifiziert", null, ""]);
  assert.deepEqual(await s.cursor(), { historyId: "1004" });
});

test("each run stays within D1's queries and the Worker's subrequests, and the next goes on where it stopped", async () => {
  const mailboxes = ["jo@bookete.com", "partner@bookete.com"];
  const s = await setup({ users: Object.fromEntries(mailboxes.map((m) => [m, READ])) });
  const leads = [];
  for (let i = 0; i < 9; i++) leads.push(await s.uc.addLead({ name: `Wirt ${i}`, email: `wirt${i}@example.at` }));
  for (const box of mailboxes) {
    for (let i = 0; i < 9; i++) {
      s.gmail.add(box, { from: `wirt${i}@example.at`, to: box, text: `Alt ${i}`, at: `2026-10-0${i + 1}T08:00:00.000Z` });
      s.gmail.add(box, { from: "news@shop.at", to: box, text: "Werbung" });
    }
  }
  const total = async () => (await Promise.all(leads.map((id) => s.store.activitiesOf(id)))).flat().length;
  const states = [];
  for (let run = 0; run < 12 && await total() < 18; run++) {
    await s.run();
    states.push(await s.cursor());
  }
  assert.equal(await total(), 18);
  // The backfill stopped with mail still queued, and went on from there.
  assert.ok(states.some((c) => c.backfill?.queue?.length));
  for (const box of mailboxes) for (let i = 0; i < 52; i++) s.gmail.add(box, { from: i % 2 || i > 11 ? "news@shop.at" : `wirt${i % 9}@example.at`, to: box, text: `Neu ${i}`, at: "2026-10-15T09:00:00.000Z" });
  for (let run = 0; run < 20 && await total() < 30; run++) {
    await s.run();
    states.push(await s.cursor());
  }
  assert.equal(await total(), 30);
  for (let run = 0; run < 4; run++) await s.run();
  assert.equal(await total(), 30);
  assert.deepEqual(await s.cursor(), { historyId: String(s.gmail.box("jo@bookete.com").historyId) });
});

test("a history record with more messages than one run reads is read on from where the run stopped", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  await s.run();
  s.gmail.add("jo@bookete.com", { from: "news@shop.at", to: "jo@bookete.com" });
  for (let i = 0; i < 60; i++) s.gmail.add("jo@bookete.com", { from: "news@shop.at", to: "jo@bookete.com", join: true });
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Am Ende", join: true });
  for (let run = 0; run < 3; run++) await s.run();
  assert.deepEqual(await texts(s.store, id), ["in Am Ende"]);
});

test("when Gmail no longer keeps the history start, the backfill runs again and logs nothing twice", async () => {
  const s = await setup();
  const id = await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  s.gmail.add("jo@bookete.com", { from: "info@krone.at", to: "jo@bookete.com", text: "Hallo" });
  await s.run();
  s.gmail.box("jo@bookete.com").oldest = 2000;
  await s.run();
  assert.equal(await s.cursor(), null);
  await s.run();
  assert.deepEqual(await texts(s.store, id), ["in Hallo"]);
  assert.ok((await s.cursor()).historyId);
});

test("only an allowlisted mailbox whose grant reads Gmail is read", async () => {
  const s = await setup({ users: { "jo@bookete.com": "openid email profile https://www.googleapis.com/auth/gmail.compose", "ex@bookete.com": READ } });
  await s.uc.addLead({ name: "Krone", email: "info@krone.at" });
  await s.run();
  assert.equal(s.gmail.calls, 0);
  assert.equal(await s.cursor(), null);
});

test("a mail's text comes without the history it quotes, at most 2000 characters, from HTML when it has no plain text", () => {
  const part = (mimeType, text, charset = "UTF-8") => ({ mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }], body: { data: Buffer.from(text, charset === "UTF-8" ? "utf8" : "latin1").toString("base64url") }, parts: [] });
  const of = (...parts) => ({ mimeType: "multipart/alternative", filename: "", headers: [], body: {}, parts });
  assert.equal(mailText(of(part("text/plain", "Ja, gerne.\r\n\r\nOn Wed, Oct 1, 2026 at 10:00 AM Jo <jo@bookete.com> wrote:\r\n> Hallo"))), "Ja, gerne.");
  assert.equal(mailText(of(part("text/plain", "Passt.\n\nVon: Jo <jo@bookete.com>\nGesendet: Mittwoch\nAn: info@krone.at"))), "Passt.");
  assert.equal(mailText(of(part("text/plain", "Grüß Gott,\nbis bald\n-----Ursprüngliche Nachricht-----\nalt", "ISO-8859-1"))), "Grüß Gott,\nbis bald");
  assert.equal(mailText(of(part("text/html", "<div>Gern&nbsp;geschehen &amp; danke<br>Maria</div><div class=\"gmail_quote\">alt</div>"))), "Gern geschehen & danke\nMaria");
  assert.equal(mailText(of(part("text/plain", "x".repeat(3000)))).length, 2000);
  assert.equal(mailText(of()), "");
});
