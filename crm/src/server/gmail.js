import { decrypt, base64url } from "./crypto.js";
import { ValidationError } from "../domain/errors.js";
import { unsubscribeUrl, unsubscribeLine } from "./unsubscribe.js";

const utf8 = (text) => new TextEncoder().encode(text);
const b64 = (text) => btoa(String.fromCharCode(...utf8(text)));
// RFC 2047 encoded word, so umlauts survive in names and subjects.
const word = (text) => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;

/** A plain-text RFC 5322 message, base64url as the Gmail API wants it. `unsubscribe` adds the one-click headers (RFC 8058). */
export function mimeMessage({ from, to, subject, text, unsubscribe }) {
  if (/[\r\n]/.test(to + subject + from.email + from.name + (unsubscribe ?? ""))) throw new Error("Header injection");
  const lines = [
    `From: ${word(from.name)} <${from.email}>`,
    `To: ${to}`,
    `Subject: ${word(subject)}`,
    ...(unsubscribe ? [`List-Unsubscribe: <${unsubscribe}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text).replace(/.{76}/g, "$&\r\n"),
  ];
  return base64url(utf8(lines.join("\r\n")));
}

/** Gmail as the signed-in user, or null when they never granted it. Fails closed: any API error throws. */
export async function createMailer(config, user) {
  if (!user.refreshToken) return null;
  const refreshToken = await decrypt(config.TOKEN_KEY, user.refreshToken);
  async function call(path, body) {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!tokenRes.ok) throw new ValidationError("gmail", "Gmail-Zugang abgelaufen. Bitte neu anmelden.");
    const { access_token } = await tokenRes.json();
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ValidationError("gmail", `Gmail-Fehler ${res.status}`);
    return res.json();
  }
  // Every mail goes to one lead and ends with that lead's unsubscribe link, in the text and in the headers;
  // only a mail marked `serviceMail` goes without, so a caller that forgets the flag still sends the link.
  const raw = async ({ leadId, to, subject, text, serviceMail = false }) => {
    const from = { email: user.email, name: user.name };
    if (serviceMail) return mimeMessage({ from, to, subject, text });
    const unsubscribe = await unsubscribeUrl(config, leadId);
    return mimeMessage({ from, to, subject, text: text + unsubscribeLine(unsubscribe), unsubscribe });
  };
  return {
    send: async (msg) => {
      const { id, threadId } = await call("messages/send", { raw: await raw(msg) });
      return { id, threadId };
    },
    draft: async (msg) => {
      const { id } = await call("drafts", { message: { raw: await raw(msg) } });
      return { draftId: id };
    },
  };
}
