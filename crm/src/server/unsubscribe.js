import { z } from "zod";
import { base64url, fromBase64url } from "./crypto.js";

/**
 * The personal unsubscribe link in every mail but service mail to a Kunde: the lead id and an HMAC over it, so a link opts out
 * only the business it was sent to. The key is derived from CONSENT_SECRET, so rotating that secret
 * ends every link already sent.
 */
const enc = new TextEncoder();
const PATH = "/abmelden/";

const key = async (secret) => crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode("bookete-crm unsubscribe") },
  await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]),
  { name: "HMAC", hash: "SHA-256", length: 256 },
  false,
  ["sign", "verify"],
);

/** An id has at most 100 characters (commands.js), so at most 300 bytes in UTF-8: 400 in base64url. Then the 32-byte HMAC. */
const Token = z.string().regex(/^[\w-]{1,400}\.[\w-]{43}$/);

export const isUnsubscribePath = (pathname) => pathname.startsWith(PATH);
/** Shaped like a link we make. Checked before the rate limit, so a junk path costs no limiter call. */
export const isUnsubscribeLink = (pathname) => isUnsubscribePath(pathname) && Token.safeParse(pathname.slice(PATH.length)).success;

export async function unsubscribeUrl(config, leadId) {
  const id = enc.encode(leadId);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key(config.CONSENT_SECRET), id));
  return `${config.PUBLIC_URL}${PATH}${base64url(id)}.${base64url(mac)}`;
}

/** The lead id the link at this path was made for, or null for a link we did not make. */
export async function unsubscribeLeadId(config, pathname) {
  if (!isUnsubscribeLink(pathname)) return null;
  const [idPart, macPart] = pathname.slice(PATH.length).split(".");
  let id, mac;
  try {
    [id, mac] = [fromBase64url(idPart), fromBase64url(macPart)];
  } catch {
    return null;
  }
  return await crypto.subtle.verify("HMAC", await key(config.CONSENT_SECRET), mac, id) ? new TextDecoder().decode(id) : null;
}

const UNSUBSCRIBE_ASK = "Sie m\xF6chten keine E-Mails mehr von uns?";
/** The line a mail with the link ends with. */
export const unsubscribeLine = (url) => `\n\n${UNSUBSCRIBE_ASK} Abmelden: ${url}`;
/** The same line in a mail's HTML part; `url` comes from unsubscribeUrl, so it holds no character HTML would read. */
export const unsubscribeHtml = (url) => `<p style="font-size:12px;color:#666">${UNSUBSCRIBE_ASK} <a href="${url}">Abmelden</a></p>`;
