import { randomToken, sha256, encrypt, base64url } from "./crypto.js";

const SESSION_COOKIE = "__Host-crm-session";
const LOGIN_COOKIE = "__Host-crm-login";
const SESSION_DAYS = 30;
// gmail.compose covers both sending and drafts.
const SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.compose";

const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const readCookie = (request, name) => request.headers.get("Cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1] ?? null;
const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { Location: location, ...headers } });
/** A path on this site only: anything that resolves to another origin (`//x`, `/\\x`) becomes "/". */
export function safeNext(next, base) {
  const url = new URL(next || "/", base);
  return url.origin === new URL(base).origin ? url.pathname + url.search : "/";
}

/**
 * The one access check. Web sessions and MCP tokens both resolve to an email and end here,
 * so removing someone from ALLOWED_EMAILS cuts every path at once.
 */
export async function allowedUser(env, config, email) {
  if (!email || !config.ALLOWED_EMAILS.includes(email)) return null;
  const row = await env.DB.prepare("SELECT email, name, refresh_token FROM users WHERE email = ?").bind(email).first();
  return row && { email: row.email, name: row.name, refreshToken: row.refresh_token };
}

/** The user behind the session cookie, or null. */
export async function sessionUser(request, env, config) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT email FROM sessions WHERE token_hash = ? AND expires_at > ?").bind(await sha256(token), Date.now()).first();
  return allowedUser(env, config, row?.email);
}

/** GET /auth/login → Google, with state and PKCE bound to this browser by a short-lived cookie. */
export async function startLogin(request, config) {
  const state = randomToken();
  const verifier = randomToken();
  const next = safeNext(new URL(request.url).searchParams.get("next"), config.PUBLIC_URL);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.PUBLIC_URL + "/auth/callback",
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return redirect(url.href, { "Set-Cookie": cookie(LOGIN_COOKIE, [state, verifier, encodeURIComponent(next)].join("."), 600) });
}

/** GET /auth/callback: code → tokens → profile → allowlist → session. */
export async function finishLogin(request, env, config) {
  const params = new URL(request.url).searchParams;
  // state and verifier are base64url (no dots); next may contain dots, so it is everything after the second.
  const [state, verifier, ...rest] = (readCookie(request, LOGIN_COOKIE) || "").split(".");
  const next = rest.join(".");
  if (!state || params.get("state") !== state) return new Response("Anmeldung abgelaufen. Bitte neu starten.", { status: 400 });
  if (!params.get("code")) return new Response("Anmeldung abgebrochen.", { status: 400 });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code: params.get("code"),
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: config.PUBLIC_URL + "/auth/callback",
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return new Response("Google-Anmeldung fehlgeschlagen.", { status: 502 });
  const tokens = await tokenRes.json();
  // The profile comes from Google's userinfo endpoint over TLS with the fresh access token, so no ID-token signature check is needed.
  const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!profileRes.ok) return new Response("Google-Profil nicht lesbar.", { status: 502 });
  const profile = await profileRes.json();
  const email = String(profile.email || "").toLowerCase();
  if (!profile.email_verified || !config.ALLOWED_EMAILS.includes(email)) return new Response(`${email || "Dieses Konto"} hat keinen Zugang zum CRM.`, { status: 403 });

  const sealed = tokens.refresh_token ? await encrypt(config.TOKEN_KEY, tokens.refresh_token) : null;
  const session = randomToken();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (email, name, refresh_token, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (email) DO UPDATE SET name = excluded.name, refresh_token = COALESCE(excluded.refresh_token, users.refresh_token), updated_at = excluded.updated_at`)
      .bind(email, profile.name || "", sealed, new Date().toISOString()),
    env.DB.prepare("INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)").bind(await sha256(session), email, Date.now() + SESSION_DAYS * 864e5),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
  ]);
  const headers = new Headers({ Location: safeNext(decodeURIComponent(next), config.PUBLIC_URL) });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, SESSION_DAYS * 86400));
  headers.append("Set-Cookie", cookie(LOGIN_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

/** POST /auth/logout */
export async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return redirect("/", { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
}
