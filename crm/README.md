# bookete CRM

The shared CRM for bookete's outreach, at https://crm.bookete.com.
Two people sign in with their `@bookete.com` Google accounts. Agents (Claude, Claude Code) work in it through MCP.

- **Web app:** leads, contact history, follow-ups, templates. Changes from the other person show up within seconds.
- **Gmail:** "Per Gmail senden" in the compose sheet sends from your own mailbox and logs the message. Every mail sent with "Per Gmail senden" or drafted by an agent, except to a Kunde, ends with a personal unsubscribe link (also in the `List-Unsubscribe` header); using it records an opt-out under "Empfänger (Abmeldelink)", also on a lead in the Papierkorb.
- **Kundenakte:** on each Qualifiziert or Kunde business, what we deliver (bookete, website, integration), its systems (domain and who owns it, DNS, hosting, e-mail, website, POS, each with the contact who runs it) and the people to reach, agencies included. Never passwords, only where the logins are kept.
- **MCP:** `https://crm.bookete.com/mcp`. Agents can search, create and update leads, fill in the Kundenakte, log contacts and calls and create Gmail drafts. They cannot send or delete.
- **Rules on the server:** opt-outs, status changes and the follow-up cadence are enforced on every write, whoever writes.
- **No lost edits:** a save changes only the fields you changed. A write based on data someone else changed in the meantime is redone on the fresh data, or refused with a message.

Architecture and commands: `../.claude/rules/project.md`.

## How a lead moves

- **Neu:** never contacted.
- **Kontaktiert:** contacted at least once, still open. The first call, mail or message in either direction, an opt-out message included, sets the date of first contact (`contactedAt`); it can't lie after today, is never cleared, and a lead with it can't go back to Neu. For a contact made outside the CRM, an agent enters it (MCP `update_lead`); that moves a Neu lead here.
- **Qualifiziert:** an appointment is agreed.
- **Kunde.**
- **Disqualifiziert:** closed, always with one of these reasons: Zufrieden mit aktueller Lösung, Kein Bedarf, Zu klein, Nicht unsere Zielgruppe, Geschlossen / existiert nicht, Nicht erreicht, Keine Kontaktaufnahme gewünscht. Which system a business uses is a fact (`currentTool`), not a reason.

A disqualified lead has no follow-up. Any new contact reopens it as Kontaktiert. "Keine Kontaktaufnahme gewünscht" is an opt-out, whether it comes from the Opt-out button or the reason picker: no outgoing contact until the opt-out is lifted. A Kunde who opts out stays Kunde with its win date and next step; only the follow-up date goes. After five unanswered contacts the CRM offers to close a lead as "Nicht erreicht".

Every call ends with one outcome, tapped on the lead page: Nicht erreicht (call again in two days, unless a date not set by the follow-up sequence is ahead, such as an appointment or a date with a next step; the fifth attempt without getting through closes the lead as "Nicht erreicht"), Rückruf (date required), Termin vereinbart (Qualifiziert, date required) or Kein Interesse (Disqualifiziert, reason required). A call in which we spoke to them counts as an answer. A call never moves a Kunde out of Kunde, and a missed one keeps their next step. On the appointment's day the lead asks how it went: Kunde, Kein Abschluss with a reason, or a new appointment. Todos has the call list (due calls first, then new leads by fit) with "Nächster" to work through it. The Anruf card has a folded Gesprächsleitfaden: the oldest template of that kind, else a default. Heute shows this week's calls, those reached, appointments, new customers (`wonAt`, the day a lead became Kunde, set by the server) and the most common reasons for Kein Interesse.

## Setup

One-time, in this order.

### 1. Google Cloud (Workspace admin)

1. In https://console.cloud.google.com create a project, e.g. `bookete-crm`, in the bookete.com organization.
2. **APIs & Services → Library:** enable the **Gmail API**.
3. **Google Auth Platform → Branding/Audience:** user type **Internal**. Only bookete.com accounts can then sign in, and Google does not need to review the app.
4. **Data access:** add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/gmail.compose`.
5. **Clients → Create client:** type *Web application*. Authorized redirect URIs:
   `https://crm.bookete.com/auth/callback` and, for local work, `http://localhost:8787/auth/callback`.
   Keep the client ID and secret for step 3.

### 2. Cloudflare

```sh
cd crm && npm install
npx wrangler login
npx wrangler d1 create crm                 # put the database_id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV  # put the id into wrangler.jsonc
```

### 3. Secrets

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY       # encrypts stored Gmail tokens
openssl rand -base64 32 | npx wrangler secret put CONSENT_SECRET  # signs remembered MCP consents and unsubscribe links
npx wrangler secret put ALLOWED_EMAILS     # e.g. you@bookete.com,partner@bookete.com
```

The Worker refuses every request while one of these is missing or malformed.
Changing `TOKEN_KEY` makes stored Gmail access unreadable: everyone signs in again.
Changing `CONSENT_SECRET` ends every unsubscribe link already sent; recipients then have to reply instead.
Removing an address from `ALLOWED_EMAILS` ends that person's web and MCP access at once.

### 4. Deploy

```sh
npm run deploy   # builds the UI, applies migrations, deploys; attaches crm.bookete.com
```

To deploy from CI instead: add the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and the repo variable `CRM_DEPLOY=true`. Every push to `main` then deploys after the tests pass.

### 5. Move the data from the Claude artifact

1. In the old artifact: **Mehr → Backup herunterladen**.
2. In the new CRM: **Mehr → Sicherung einspielen**. Only records the CRM has never held are added, so importing twice does no harm, and an import never undoes an opt-out or a deletion.

### 6. Connect agents

- **claude.ai / Cowork:** Settings → Connectors → Add custom connector → `https://crm.bookete.com/mcp`.
- **Claude Code:** `claude mcp add --transport http bookete-crm https://crm.bookete.com/mcp`

The first connection opens a sign-in and a consent page. The agent then acts as you, and each change records it as `you@bookete.com (mcp)`.

## Backups and recovery

Three layers, from the smallest mistake to the biggest:

1. **A single change or a deleted lead:** **Änderungen** at the bottom of a lead shows who changed what, old and new value. A deleted lead goes to **Mehr → Papierkorb** (the newest 50) and comes back with its contact history.
   **Endgültig löschen** there erases the lead, all its contacts and its changes, for a business that asks to be deleted. Time Travel (below) still holds it until its window has passed.
2. **The whole database, any minute of the recent past:** D1 Time Travel keeps a point-in-time history automatically (7 days on the Workers Free plan, 30 on Paid). A restore overwrites the database in place, so export a backup first and agree on it together:

   ```sh
   npx wrangler d1 time-travel info crm                              # current bookmark
   npx wrangler d1 time-travel info crm --timestamp=2026-10-16T09:00:00+02:00
   npx wrangler d1 time-travel restore crm --timestamp=2026-10-16T09:00:00+02:00
   ```

   The restore prints the bookmark from before it, so it can itself be undone with `--bookmark=<that bookmark>`.
3. **A copy outside Cloudflare:** **Mehr → Backup herunterladen** writes every record to a JSON file, which **Sicherung einspielen** reads back.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in the Google client for localhost
npx wrangler d1 migrations apply crm --local
npm run dev                      # http://localhost:8787; the auth rate limit (20 a minute per IP) applies here too
npm test
```
