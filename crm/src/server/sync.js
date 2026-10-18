import { allowedUser, canReadGmail } from "./auth.js";
import { createStore } from "./store.js";
import { createMailer } from "./gmail.js";
import { createUseCases } from "../application/use-cases.js";
import { addressKey } from "../domain/lead.js";
import { mailActivityId } from "../domain/activity.js";
import { ValidationError } from "../domain/errors.js";

/**
 * The Gmail sync, every five minutes (wrangler.jsonc `triggers`): logs on its lead each mail in a user's mailbox that
 * belongs to a thread already logged, or else is to or from a lead's stored address. Never by domain, never by an
 * address of the users or of their own domain, and never a mail with no one else on it, or one a machine sent on its
 * own (an out-of-office reply, a bounce). A mail the lead holds already is not logged again (sameMail). Each mailbox
 * reads from where its last run stopped (`users.gmail_cursor`):
 *
 * - First a backfill of BACKFILL_DAYS: a Gmail search over the leads' addresses, ADDRESSES_PER_SEARCH at a time in
 *   their order, `{ backfill: { historyId, after, from, q?, pageToken?, found?, queue? } }`. A search's results are
 *   collected over its pages (`found`), then logged oldest first (`queue`), so each mail moves its lead on as it would
 *   have when it came. `from` is the last address done; a lead added meanwhile with an address before it is not searched.
 * - Then every message Gmail adds after the history id the backfill started at: `{ historyId, skip? }`, `skip` being
 *   the messages of the next history record already handled.
 *
 * One Worker invocation runs at most 50 D1 queries and makes at most 50 subrequests (Free plan), for all mailboxes
 * together, so each takes an even share and stops where it runs out; the cursor keeps its place. Queries: 1 for the
 * cursors, 2 for what is logged, and per mailbox 1 for the user and 1 for its cursor; then each logged mail at most 8
 * (recordMail: the lead, its activities, the address check, when a person last set each part of the plan, a commit of 4), so MAILS_PER_RUN leaves room for retries.
 * Subrequests: per mailbox the token and the history id or search, then per mail its headers, and its text if it matches.
 */
const MAILS_PER_RUN = 4;
const FETCHES_PER_RUN = 46;
const BACKFILL_DAYS = 30;
const ADDRESSES_PER_SEARCH = 10;
const HISTORY_PAGE = 100;
// Not mail that came or went: a draft (create_gmail_draft makes them), spam, the trash, chat.
const SKIPPED_LABELS = ["DRAFT", "SPAM", "TRASH", "CHAT"];
// An address Gmail's search takes as it is; one with other characters is found only by the history.
const SEARCHABLE = /^[\w.+'-]+@[\w.-]+$/;
// The calendar day in Vienna, as systemClock cuts today.
const viennaDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" });
const domainOf = (address) => address.slice(address.lastIndexOf("@") + 1);
// Where bounces come from.
const BOUNCER = /^(mailer-daemon|postmaster)@/;

/** One run over every allowlisted mailbox whose grant reads Gmail. A mailbox that fails keeps its cursor and is tried again next run. */
export async function syncMail({ env, config, clock, ids, pause }) {
  const users = [];
  for (const email of config.ALLOWED_EMAILS) {
    const user = await allowedUser(env, config, email);
    if (user && canReadGmail(user)) users.push(user);
  }
  if (!users.length) return;
  const store = createStore(env.DB);
  const cursors = new Map((await env.DB.prepare("SELECT email, gmail_cursor FROM users").all()).results.map((r) => [r.email, r.gmail_cursor]));
  const ownDomains = new Set(config.ALLOWED_EMAILS.map(domainOf));
  const ours = (address) => config.ALLOWED_EMAILS.includes(address) || ownDomains.has(domainOf(address));
  const [leads, logged] = await Promise.all([store.list("leads"), store.mailIndex()]);
  // An address held by several leads goes to one without an opt-out, else to the one written last.
  const byAddress = new Map();
  for (const l of leads.filter((x) => x.email).sort((a, b) => !!b.optOutAt - !!a.optOutAt || String(a.updatedAt).localeCompare(String(b.updatedAt)) || a.id.localeCompare(b.id))) {
    const key = addressKey(l.email);
    if (!ours(key)) byAddress.set(key, l.id);
  }
  const share = { mails: Math.max(1, Math.floor(MAILS_PER_RUN / users.length)), fetches: Math.floor(FETCHES_PER_RUN / users.length) };
  for (const user of users) {
    try {
      const cursor = await syncMailbox({ user, cursor: JSON.parse(cursors.get(user.email) || "null"), share, config, clock, ours, byAddress, logged,
        uc: createUseCases({ store, clock, ids, pause, actor: `${user.email} (gmail)` }) });
      await env.DB.prepare("UPDATE users SET gmail_cursor = ? WHERE email = ?").bind(JSON.stringify(cursor), user.email).run();
    } catch (e) {
      console.error("gmail sync failed", user.email, e);
    }
  }
}

async function syncMailbox({ user, cursor, share, config, clock, ours, byAddress, logged, uc }) {
  const mailer = await createMailer(config, user);
  const mailbox = user.email;
  let mails = share.mails;
  let fetches = share.fetches - 1; // the access token

  /** Handles one message; false when the budget ends before it, so it is still to do. */
  async function handle(ref) {
    const id = await mailActivityId(mailbox, ref.id);
    if (logged.ids.has(id) || ref.labelIds?.some((l) => SKIPPED_LABELS.includes(l))) return true;
    // The headers and, should it match, the text: both are paid for before the first.
    if (fetches < 2 || mails < 1) return false;
    fetches--;
    const head = await mailer.message(ref.id);
    if (!head || head.labelIds.some((l) => SKIPPED_LABELS.includes(l))) return true;
    const from = head.from.map(addressKey);
    const theirs = [...from, ...head.to.map(addressKey), ...head.cc.map(addressKey)].filter((a) => !ours(a));
    if (!theirs.length || head.automated || from.some((a) => BOUNCER.test(a))) return true;
    const leadId = logged.threads.get(`${mailbox} ${head.threadId}`) ?? theirs.map((a) => byAddress.get(a)).find(Boolean);
    if (!leadId) return true;
    fetches--;
    const msg = await mailer.message(ref.id, { full: true });
    if (!msg) return true;
    mails--;
    const mail = { gmailId: msg.id, threadId: msg.threadId, mailbox, subject: msg.subject, from: msg.from.join(", "), to: msg.to.join(", "), messageId: msg.messageId };
    try {
      // From one of us, the mailbox's owner or a colleague: out. Anything else came in.
      const direction = from.length && ours(from[0]) ? "out" : "in";
      await uc.recordMail(leadId, { direction, date: viennaDay.format(new Date(msg.at)), at: msg.at, text: msg.text || msg.subject || "(ohne Betreff)", mail });
      logged.ids.add(id);
      logged.threads.set(`${mailbox} ${msg.threadId}`, leadId);
    } catch (e) {
      // Refused by a rule (an outgoing mail to a closed address or an opted-out lead, a lead gone since): not logged, and not tried again.
      if (!(e instanceof ValidationError)) throw e;
    }
    return true;
  }
  /** How many of these messages, from the first, are handled. */
  async function take(refs) {
    let done = 0;
    while (done < refs.length && await handle(refs[done])) done++;
    return done;
  }

  if (!cursor) {
    fetches--;
    const after = Math.floor(Date.parse(clock.now()) / 1000) - BACKFILL_DAYS * 86400;
    cursor = { backfill: { historyId: await mailer.historyId(), after, from: "" } };
  }
  return cursor.backfill ? backfill(cursor.backfill) : incremental(cursor);

  async function backfill(state) {
    const addresses = [...byAddress.keys()].filter((a) => SEARCHABLE.test(a)).sort();
    let s = state;
    for (;;) {
      if (s.queue?.length) {
        const queue = s.queue.slice(await take(s.queue.map(([id, threadId]) => ({ id, threadId }))));
        if (queue.length) return { backfill: { ...s, queue } };
        s = { ...s, queue: undefined };
      }
      if (!s.q) {
        const chunk = addresses.filter((a) => a > s.from).slice(0, ADDRESSES_PER_SEARCH);
        if (!chunk.length) return { historyId: s.historyId };
        s = { ...s, q: `after:${s.after} {${chunk.map((a) => `from:${a} to:${a} cc:${a}`).join(" ")}}`, to: chunk.at(-1), found: [] };
      }
      if (fetches < 1) return { backfill: s };
      fetches--;
      const page = await mailer.search(s.q, s.pageToken);
      const found = [...s.found, ...page.messages.map((m) => [m.id, m.threadId])];
      if (page.nextPageToken) s = { ...s, pageToken: page.nextPageToken, found };
      else s = { historyId: s.historyId, after: s.after, from: s.to, queue: found.reverse() };
    }
  }

  async function incremental({ historyId, skip = 0 }) {
    if (fetches < 1) return { historyId, skip };
    fetches--;
    const page = await mailer.history(historyId, HISTORY_PAGE);
    // Gmail keeps about a week of history: after a longer pause, the backfill runs again (a mail logged stays logged once).
    if (!page) return null;
    let at = historyId;
    for (const [i, record] of page.history.entries()) {
      const refs = record.messagesAdded.map((m) => m.message).slice(i === 0 ? skip : 0);
      const done = await take(refs);
      if (done < refs.length) return { historyId: at, skip: (i === 0 ? skip : 0) + done };
      at = record.id;
    }
    return { historyId: page.nextPageToken ? at : page.historyId };
  }
}
