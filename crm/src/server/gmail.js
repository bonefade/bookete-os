import { z } from "zod";
import { decrypt, base64url, fromBase64url } from "./crypto.js";
import { ValidationError } from "../domain/errors.js";
import { unsubscribeUrl, unsubscribeLine, unsubscribeHtml } from "./unsubscribe.js";
import { canReadGmail } from "./auth.js";

const utf8 = (text) => new TextEncoder().encode(text);
const b64 = (text) => btoa(String.fromCharCode(...utf8(text)));
// RFC 2047 encoded word, so umlauts survive in names and subjects.
const word = (text) => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;

const escHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
const part = (type, body) => [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", b64(body).replace(/.{76}/g, "$&\r\n")];
// "_" is no base64 character, so no part's body can hold the boundary.
const BOUNDARY = "=_bookete-crm";
/**
 * An RFC 5322 message, base64url as the Gmail API wants it: `text`, then the unsubscribe line when `unsubscribe` is
 * given, with the one-click headers (RFC 8058); `inReplyTo`, the Message-ID of the mail it answers, the headers that keep
 * it in that thread (RFC 5322 §3.6.4). Plain text; with a `signature` ({ html, text }, from Gmail), also an HTML part
 * carrying it as Gmail shows it, and the text after a "-- " line (RFC 3676 §4.3).
 */
export function mimeMessage({ from, to, subject, text, unsubscribe, inReplyTo, signature }) {
  if (/[\r\n]/.test(to + subject + from.email + from.name + (unsubscribe ?? "") + (inReplyTo ?? ""))) throw new Error("Header injection");
  // A signature that is only an image (a logo) shows in the HTML part alone.
  const plain = text + (signature?.text ? `\n\n-- \n${signature.text}` : "") + (unsubscribe ? unsubscribeLine(unsubscribe) : "");
  const html = signature && `<div dir="ltr">${escHtml(text).replace(/\n/g, "<br>")}</div><br><div class="gmail_signature">${signature.html}</div>${unsubscribe ? unsubscribeHtml(unsubscribe) : ""}`;
  const lines = [
    `From: ${word(from.name)} <${from.email}>`,
    `To: ${to}`,
    `Subject: ${word(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    ...(unsubscribe ? [`List-Unsubscribe: <${unsubscribe}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
    "MIME-Version: 1.0",
    ...(html
      ? [`Content-Type: multipart/alternative; boundary="${BOUNDARY}"`, "", `--${BOUNDARY}`, ...part("text/plain", plain), `--${BOUNDARY}`, ...part("text/html", html), `--${BOUNDARY}--`]
      : part("text/plain", plain)),
  ];
  return base64url(utf8(lines.join("\r\n")));
}

// Gmail's answers, parsed here once. Loose: Google adds fields.
const Header = z.object({ name: z.string(), value: z.string() });
const Part = z.looseObject({
  mimeType: z.string().default(""),
  filename: z.string().default(""),
  headers: z.array(Header).default([]),
  body: z.looseObject({ data: z.string().optional() }).default({}),
  get parts() { return z.array(Part).default([]); },
});
const Ref = z.looseObject({ id: z.string(), threadId: z.string(), labelIds: z.array(z.string()).default([]) });
const Profile = z.looseObject({ historyId: z.string() });
const History = z.looseObject({
  historyId: z.string(),
  nextPageToken: z.string().optional(),
  history: z.array(z.looseObject({ id: z.string(), messagesAdded: z.array(z.looseObject({ message: Ref })).default([]) })).default([]),
});
const List = z.looseObject({ nextPageToken: z.string().optional(), messages: z.array(Ref).default([]) });
const Message = Ref.extend({ internalDate: z.coerce.number().int().positive(), payload: Part });
const SendAs = z.looseObject({ sendAs: z.array(z.looseObject({ sendAsEmail: z.string(), signature: z.string().default("") })).default([]) });

/** Bytes in the charset a part names; UTF-8 when it names none or one this runtime does not know. */
function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
// The Q encoding: "_" is a space, "=XX" a byte.
const qBytes = (text) => Uint8Array.from(text.replace(/_/g, " ").match(/=[0-9A-Fa-f]{2}|[\s\S]/g) || [], (t) => t.length === 3 ? parseInt(t.slice(1), 16) : t.charCodeAt(0) & 0xff);
/** Encoded words (RFC 2047) in a header, should Gmail hand one on undecoded; the space between two of them goes. */
const decodeWords = (value) => value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(?:\s+(?==\?))?/g, (_, charset, kind, data) =>
  decodeBytes(kind.toUpperCase() === "B" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : qBytes(data), charset));
const addresses = (value) => value.match(/[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g) || [];
const headerOf = (part, name) => decodeWords(part.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "").trim();

/** The first part of this type that is no attachment, depth first. */
const partOf = (part, type) => part.mimeType === type && !part.filename && part.body.data ? part : part.parts.reduce((found, p) => found || partOf(p, type), null);
const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function htmlText(html) {
  return html
    .replace(/<(div|blockquote)[^>]*class="[^"]*gmail_quote[\s\S]*$/i, "")
    .replace(/<blockquote[\s\S]*$/i, "")
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, "0x"))) : ENTITIES[e.toLowerCase()] ?? m);
}
// Where the quoted history of a reply starts: "Am … schrieb …:" or "On … wrote:" (Gmail wraps it over two lines),
// Outlook's "Von: … / Gesendet: …" block or its rule, a forwarded or original message, or the first line quoted with ">".
const QUOTE_STARTS = [
  // Gmail wraps a long attribution line, before or after "schrieb".
  /^(Am|On)\s[^\n]*(\n[^\n]*)?\s(schrieb|wrote)[^\n]*(\n[^\n]*)?:[ \t]*$/m,
  /^(Von|From):[^\n]*\n(Gesendet|Sent|Datum|Date):/m,
  /^-{2,}\s*(Urspr\xFCngliche Nachricht|Original Message|Weitergeleitete Nachricht|Forwarded message)/mi,
  /^_{10,}[ \t]*$/m,
  /^>/m,
];
const MAIL_TEXT_MAX = 2000;
const tidy = (text) => text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
/** The text of a mail without the quoted history it answers, at most MAIL_TEXT_MAX characters. */
export function mailText(payload) {
  const plain = partOf(payload, "text/plain");
  const part = plain || partOf(payload, "text/html");
  if (!part) return "";
  const charset = headerOf(part, "content-type").match(/charset="?([^";\s]+)/i)?.[1];
  const raw = decodeBytes(fromBase64url(part.body.data), charset).replace(/\r\n?/g, "\n");
  const text = plain ? raw : htmlText(raw);
  const cut = Math.min(...QUOTE_STARTS.map((re) => text.search(re)).filter((i) => i >= 0), text.length);
  return tidy(text.slice(0, cut)).slice(0, MAIL_TEXT_MAX);
}

/**
 * Gmail as the signed-in user, or null when they never granted it. Fails closed: any API error throws, except a
 * message or history start Gmail no longer has, which reads as null. One access token per mailer.
 */
export async function createMailer(config, user) {
  if (!user.refreshToken) return null;
  const refreshToken = await decrypt(config.TOKEN_KEY, user.refreshToken);
  let token;
  const accessToken = () => token ??= (async () => {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!tokenRes.ok) throw new ValidationError("gmail", "Gmail-Zugang abgelaufen. Bitte neu anmelden.");
    return (await tokenRes.json()).access_token;
  })();
  async function call(path, { body, missing = false } = {}) {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    if (missing && res.status === 404) return null;
    if (!res.ok) throw new ValidationError("gmail", `Gmail-Fehler ${res.status}`);
    return res.json();
  }
  // Every mail goes to one lead and ends with that lead's unsubscribe link, in the text and in the headers;
  // only a mail marked `serviceMail` goes without, so a caller that forgets the flag still sends the link.
  // `signed`: with the user's Gmail signature, when the grant can read it.
  const raw = async ({ leadId, to, subject, text, serviceMail = false, inReplyTo, signed = false }) => {
    const from = { email: user.email, name: user.name };
    const sig = signed ? await signature() : null;
    const unsubscribe = serviceMail ? undefined : await unsubscribeUrl(config, leadId);
    return mimeMessage({ from, to, subject, text, unsubscribe, inReplyTo, signature: sig?.html ? sig : undefined });
  };
  /**
   * The signature Gmail adds to this user's mail: their send-as address's, as HTML ("" for none) and as text ("" too for
   * one that is only an image). Null when
   * the grant cannot read it (no gmail.readonly yet). Fails closed: an API error throws, so no mail goes out without the
   * signature it was to carry.
   */
  async function signature() {
    if (!canReadGmail(user)) return null;
    const { sendAs } = SendAs.parse(await call("settings/sendAs"));
    // The mail goes out from the user's own address (raw), so its signature; an alias's is another's.
    const html = (sendAs.find((s) => s.sendAsEmail.toLowerCase() === user.email.toLowerCase())?.signature ?? "").trim();
    return { html, text: tidy(htmlText(html)) };
  }
  /**
   * One message: its labels, when Gmail got it, the addresses in From, To and Cc, its subject and Message-ID, and whether
   * a machine sent it on its own (`automated`, RFC 3834's Auto-Submitted: an out-of-office reply); with `full`, also its
   * text (mailText). Null when it is gone.
   */
  async function message(id, { full = false } = {}) {
    const format = full ? { format: "full" } : { format: "metadata", metadataHeaders: "From" };
    const params = new URLSearchParams(format);
    if (!full) for (const name of ["To", "Cc", "Subject", "Message-ID", "Auto-Submitted"]) params.append("metadataHeaders", name);
    const found = await call(`messages/${encodeURIComponent(id)}?${params}`, { missing: true });
    if (!found) return null;
    const m = Message.parse(found);
    return {
      id: m.id, threadId: m.threadId, labelIds: m.labelIds, at: new Date(m.internalDate).toISOString(),
      from: addresses(headerOf(m.payload, "from")), to: addresses(headerOf(m.payload, "to")), cc: addresses(headerOf(m.payload, "cc")),
      subject: headerOf(m.payload, "subject"), messageId: headerOf(m.payload, "message-id"),
      automated: /^auto-/i.test(headerOf(m.payload, "auto-submitted")), ...(full && { text: mailText(m.payload) }),
    };
  }
  const query = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)).toString();
  return {
    /** Whose mailbox this is. */
    mailbox: user.email,
    /**
     * Sends `msg`; with `thread` ({ threadId, messageId } of a mail in this mailbox) as an answer in that thread. Returns
     * the new mail's ids and its Message-ID, read back for a later answer. Reading it back fails open: the mail is out,
     * and without it only an answer to this mail starts a new thread.
     */
    send: async ({ thread, ...msg }) => {
      const body = { raw: await raw({ ...msg, inReplyTo: thread?.messageId || undefined }), ...(thread && { threadId: thread.threadId }) };
      const { id, threadId } = await call("messages/send", { body });
      const head = await message(id).catch(() => null);
      return { id, threadId, messageId: head?.messageId || "" };
    },
    draft: async (msg) => {
      const { id } = await call("drafts", { body: { message: { raw: await raw(msg) } } });
      return { draftId: id };
    },
    /** The mailbox's newest history id: reading changes from it misses nothing that comes after. */
    historyId: async () => Profile.parse(await call("profile")).historyId,
    /** Up to `max` history records of added messages after `start`, oldest first; null when Gmail no longer keeps that start. */
    history: async (start, max) => {
      const page = await call("history?" + query({ startHistoryId: start, historyTypes: "messageAdded", maxResults: max }), { missing: true });
      return page && History.parse(page);
    },
    /** One page of the messages a Gmail search finds, newest first. */
    search: async (q, pageToken) => List.parse(await call("messages?" + query({ q, maxResults: 500, pageToken }))),
    message,
    signature,
  };
}
