import { OAuthProvider, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { readConfig } from "./config.js";
import { allowedUser, sessionUser, startLogin, finishLogin, logout, logoutEverywhere } from "./auth.js";
import { createStore } from "./store.js";
import { createMailer } from "./gmail.js";
import { COMMANDS } from "./commands.js";
import { handleMcp } from "./mcp.js";
import { isUnsubscribePath, isUnsubscribeLink, unsubscribeLeadId } from "./unsubscribe.js";
import { createUseCases } from "../application/use-cases.js";
import { systemClock, uuidIds, retryPause } from "../adapters/system.js";
import { ValidationError, ConflictError } from "../domain/errors.js";
// The version each production deploy bumps; shown in the app, so anyone can see what is live.
import pkg from "../../package.json" with { type: "json" };

const SCOPE = "crm";
// Open endpoints anyone can call; each costs an OAuth round trip, a KV write or a token check.
const RATE_LIMITED = new Set(["GET /auth/login", "GET /auth/callback", "POST /oauth/register", "POST /oauth/token"]);
const rateLimited = (method, pathname) => RATE_LIMITED.has(`${method} ${pathname}`) || isUnsubscribeLink(pathname);
// The consent form posts here and is then redirected to the agent's own address, so no form-action.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body, headers = new Headers(), status = 200) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", PAGE_CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bookete CRM</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><body style="font:16px/1.5 system-ui;max-width:32rem;margin:3rem auto;padding:0 16px">${body}`, { headers, status });
};

async function context(env, config, user, via) {
  const store = createStore(env.DB);
  const mailer = await createMailer(config, user);
  return { store, clock: systemClock, uc: createUseCases({ store, clock: systemClock, ids: uuidIds, pause: retryPause, actor: `${user.email} (${via})`, mailer }) };
}

async function rpc(request, env, config, user, name) {
  const command = Object.hasOwn(COMMANDS, name) && COMMANDS[name];
  if (!command) return Response.json({ error: "Unbekannter Befehl" }, { status: 404 });
  // JSON only: a cross-site form cannot send it without a CORS preflight, which we never answer.
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return new Response(null, { status: 415 });
  const args = command[0].safeParse(await request.json().catch(() => null));
  if (!args.success) return Response.json({ error: "Ungültige Eingabe", issues: args.error.issues }, { status: 400 });
  try {
    const { uc } = await context(env, config, user, "web");
    return Response.json({ result: (await command[1](uc, args.data)) ?? null });
  } catch (e) {
    if (e instanceof ValidationError) return Response.json({ error: e.message, field: e.field }, { status: 400 });
    if (e instanceof ConflictError) return Response.json({ error: e.message, field: "conflict" }, { status: 409 });
    throw e;
  }
}

/** MCP consent: an agent may act as this user only after they say so here, once per client. */
async function authorize(request, env, config, user) {
  const oauth = env.OAUTH_PROVIDER;
  const remember = { secret: config.CONSENT_SECRET, subject: user.email };
  const complete = async (authRequest, headers) => {
    const { redirectTo } = await oauth.completeAuthorization({ request: authRequest, userId: user.email, metadata: {}, scope: [SCOPE], props: { email: user.email } });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  };
  try {
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE], remember });
      return complete(approved.request, approved.headers);
    }
    const authRequest = await oauth.parseAuthRequest(request);
    if (await oauth.isConsentRemembered(request, authRequest, remember)) return complete(authRequest, new Headers());
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return html(`<h1>${esc(details.clientName)} Zugriff erlauben?</h1>
<p>Die App darf als <b>${esc(user.email)}</b> Betriebe lesen und bearbeiten und Gmail-Entwürfe anlegen. Senden kann sie nicht.</p>
<p>${details.clientDomain ? `Herausgeber: <b>${esc(details.clientDomain)}</b>.` : "Die App hat sich selbst registriert; ihr Name ist nicht geprüft."}
Der Zugang geht an <b>${esc(details.redirectHost)}</b>.</p>
${details.redirectIsLoopback ? "<p><b>Der Zugang geht an ein Programm auf deinem Computer.</b> Nur erlauben, wenn du die Anmeldung gerade selbst gestartet hast.</p>" : ""}
<form method="post"><input type="hidden" name="handle" value="${esc(consent.handle)}">
<button name="decision" value="approve">Erlauben</button> <button name="decision" value="deny">Ablehnen</button></form>`, consent.headers);
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) return html(`<p>${esc(e instanceof AuthorizationError ? e.description : "Diese App konnte nicht geprüft werden.")}</p>`);
    throw e;
  }
}

/**
 * The unsubscribe link from a mail, no session. GET only asks, so a mail scanner that opens links opts no one out;
 * POST (the button, or the mail client's one-click) opts out. The page reads the same whatever the lead's state.
 */
async function unsubscribe(request, env, config, pathname) {
  const headers = () => new Headers({ "Cache-Control": "no-store" });
  const leadId = await unsubscribeLeadId(config, pathname);
  if (!leadId) return html("<h1>Link ung\xFCltig</h1><p>Dieser Abmeldelink ist nicht g\xFCltig. Bitte antworten Sie einfach auf unsere E-Mail.</p>", headers(), 400);
  if (request.method === "GET") return html(`<h1>Keine E-Mails mehr von bookete?</h1>
<p>Nach dem Abmelden schreiben wir Ihnen nicht mehr.</p>
<form method="post"><button>Abmelden</button></form>`, headers());
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  try {
    await createUseCases({ store: createStore(env.DB), clock: systemClock, ids: uuidIds, pause: retryPause, actor: "Empf\xE4nger (Abmeldelink)" }).unsubscribe(leadId);
  } catch (e) {
    console.error("unsubscribe failed", e);
    return html("<h1>Das hat nicht geklappt</h1><p>Bitte versuchen Sie es in ein paar Minuten noch einmal, oder antworten Sie einfach auf unsere E-Mail.</p>", headers(), 503);
  }
  return html("<h1>Sie sind abgemeldet</h1><p>Sie erhalten keine E-Mails mehr von uns.</p>", headers());
}

const LeadQuery = z.object({ id: z.string().min(1).max(100) });
const TrashQuery = z.object({ before: z.coerce.number().int().positive().optional() });

/** The rate-limit key: an IPv4 address, or the /64 of an IPv6 one, since one connection usually owns a whole /64. */
export function rateKey(ip) {
  const v4 = ip.match(/(\d{1,3}\.){3}\d{1,3}$/);
  if (v4) return v4[0];
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/**
 * Fails open: if the limiter itself errors, the request goes on. It only slows guessing and flooding; the gate is
 * the Google sign-in and the allowlist, or for the unsubscribe link its HMAC. A limiter outage must not lock both
 * users out, nor keep a recipient from unsubscribing.
 */
async function overLimit(request, env) {
  try {
    // The unsubscribe link has its own bucket: a mail provider's one-click POSTs never use up sign-in's, nor the reverse.
    const bucket = isUnsubscribePath(new URL(request.url).pathname) ? "abmelden " : "";
    const { success } = await env.AUTH_LIMIT.limit({ key: bucket + rateKey(request.headers.get("CF-Connecting-IP") || "") });
    return !success;
  } catch (e) {
    console.error("rate limiter failed", e);
    return false;
  }
}

async function app(request, env, config) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /auth/login") return startLogin(request, config);
  if (route === "GET /auth/callback") return finishLogin(request, env, config);
  if (route === "POST /auth/logout") return logout(request, env);
  if (isUnsubscribePath(url.pathname)) return unsubscribe(request, env, config, url.pathname);

  const user = await sessionUser(request, env, config);
  if (route === "POST /auth/logout-all") return user ? logoutEverywhere(request, env, config, user) : new Response(null, { status: 401 });
  if (url.pathname === "/authorize") return user ? authorize(request, env, config, user) : Response.redirect(`${config.PUBLIC_URL}/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
  if (!user) return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
  if (route === "GET /api/me") return Response.json({ email: user.email, name: user.name, gmail: !!user.refreshToken, version: pkg.version });
  if (route === "GET /api/sync") return Response.json(await createStore(env.DB).changes(Math.max(0, parseInt(url.searchParams.get("since"), 10) || 0)));
  if (route === "GET /api/history") {
    const query = LeadQuery.safeParse(Object.fromEntries(url.searchParams));
    return query.success ? Response.json(await createStore(env.DB).history(query.data.id)) : Response.json({ error: "Ung\xFCltige Eingabe" }, { status: 400 });
  }
  if (route === "GET /api/trash") {
    const query = TrashQuery.safeParse(Object.fromEntries(url.searchParams));
    return query.success ? Response.json(await createStore(env.DB).trash(query.data.before)) : Response.json({ error: "Ung\xFCltige Eingabe" }, { status: 400 });
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/rpc/")) return rpc(request, env, config, user, url.pathname.slice(9));
  return new Response("Not found", { status: 404 });
}

async function mcp(request, env, ctx, config) {
  const user = await allowedUser(env, config, ctx.props?.email);
  if (!user) return Response.json({ error: "Kein Zugang" }, { status: 403 });
  return handleMcp(request, await context(env, config, user, "mcp"));
}

let config, provider;
export default {
  async fetch(request, env, ctx) {
    config ??= readConfig(env);
    provider ??= new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: { fetch: (req, e, c) => mcp(req, e, c, config) },
      defaultHandler: { fetch: (req, e) => app(req, e, config) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      resourceMetadata: { resource: `${config.PUBLIC_URL}/mcp`, authorization_servers: [config.PUBLIC_URL] },
    });
    // Before the OAuth provider, so a flood never reaches its KV writes.
    if (rateLimited(request.method, new URL(request.url).pathname) && await overLimit(request, env)) {
      return new Response("Zu viele Anfragen. Bitte kurz warten.", { status: 429, headers: { "Retry-After": "60" } });
    }
    return provider.fetch(request, env, ctx);
  },
};
