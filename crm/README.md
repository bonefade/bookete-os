# bookete CRM

The shared CRM for bookete's outreach, at https://crm.bookete.com.
Two people sign in with their `@bookete.com` Google accounts. Agents (Claude, Claude Code) work in it through MCP.

- **Web app:** leads, contact history, follow-ups, templates. Changes from the other person show up within seconds.
- **Gmail:** "Per Gmail senden" in the compose sheet sends from your own mailbox and logs the message, as written. It carries your Gmail signature, read from Gmail when it goes out (your own address's, from the Gmail settings, so `gmail.readonly`): the mail then has an HTML part with the signature as Gmail shows it, logo and links included, and a text part with it after a "-- " line. The compose sheet shows the signature as text (the page loads no outside images), with "Mit Signatur" to leave it out of one mail; an agent's draft always has it. Without the `gmail.readonly` grant, or with no signature in Gmail, mail goes out as plain text, and the compose sheet says so; a signature that is only an image (a logo) goes in the HTML part alone. A failed read of the signature sends nothing. Every mail sent with "Per Gmail senden" or drafted by an agent, except to a Kunde, ends with a personal unsubscribe link (also in the `List-Unsubscribe` header); using it records an opt-out under "Empfänger (Abmeldelink)", also on a lead in the Papierkorb. Once Gmail is connected, a mail that gets the link goes out only this way: the lead page then offers neither "Kopieren & E-Mail öffnen" nor a mail link on the E-Mail button for it, since both would send it without the link. A Kunde keeps both. No mail goes, sent or drafted, to an address that any business with an opt-out holds, also one in the Papierkorb (compared without case and surrounding spaces): the same business added again under a new id is not mailed again. A Kunde is exempt, so its service mail still goes out; only its own opt-out stops mail to it. The lead page then has no link that opens a mail to the address ("Kopieren & E-Mail öffnen", the E-Mail button), on the business with the opt-out too, and the compose sheet names that business (on that business itself it says "Keine E-Mail: Opt-out seit …"), unless it is in the Papierkorb: then the page does not know it, without Gmail still offers both mail links, and "Per Gmail senden" is refused with a message naming it. Nor can an outgoing E-Mail to the address be logged by hand ("Als gesendet eintragen", an agent's `log_activity`): for E-Mail the compose sheet then offers only "Abbrechen", and "Text kopieren" unless mail goes only by Gmail (Gmail connected, not a Kunde), and the server refuses it with the same message. Calls, other channels and incoming replies can still be logged. The block comes from the stored leads: changing or clearing the e-mail address of the business with the opt-out, or Endgültig löschen on it, opens the address again.
- **Mail from Gmail:** every five minutes the CRM reads both mailboxes (a cron, `src/server/sync.js`) and logs on its lead each mail in a thread the CRM sent, or else to or from a lead's stored e-mail address (compared without case and surrounding spaces), also mail written in Gmail itself. Never by domain alone, and never an address of ours (the `ALLOWED_EMAILS` and their domains). Not mail with no one else on it (only us), and not mail a machine sent on its own (an out-of-office reply, marked `Auto-Submitted`, or a bounce). Each entry shows whose mailbox it is in; a mail in both is logged once (by its Message-ID). A mail from one of us is outgoing, any other incoming. The entry holds the text without the quoted history, at most 2000 characters. A mail sent with "Per Gmail senden" is logged once, and so is one already entered without Gmail that day and that way (every mail sent before 1.17.0, an answer entered by hand once it came): the entry takes that mail and the time it came (so it moves to there in the feed), and stands for no other. Only the newest contact plans what comes next: a mail found that came before a later contact leaves the follow-up and next step that contact set. And what a person set after a mail came stays when the mail is found: a follow-up or next step set since, or a status set since with the whole plan, so a business disqualified since stays so, with its reason. Only an answer of ours still ends "Antworten" and dates the next follow-up, as any answer does (a later follow-up stays). A mail that came after plans as any contact does, and reopens a disqualified business. An outgoing mail to an address that may not be mailed (an opt-out, see Gmail above) is never logged as sent; an incoming one is always logged, also on a lead with an opt-out. A message from them sets the follow-up to today with the next step "Antworten", unless a contact came after it; the next outgoing contact clears that next step. The first run of a mailbox reads the last 30 days, each run after that what Gmail added since. The sync reads a mailbox only after its owner signed in once with the read permission (`gmail.readonly`); until then the app asks to connect Gmail again.
- **Kundenakte:** on each Qualifiziert or Kunde business, what we deliver (bookete, website, integration), its systems (domain and who owns it, DNS, hosting, e-mail, website, POS, each with the contact who runs it) and the people to reach, agencies included. Never passwords, only where the logins are kept.
  A contact's e-mail address follows the same block (see Gmail above): it shows without a mail link when a business with an opt-out holds it. On a Kunde only the Kunde's own opt-out does this, and only for its own address. Once Gmail is connected, a contact at the business's own address has no mail link either, except on a Kunde: "Per Gmail senden" mails that address with the link. A contact at another address, such as an agency, keeps its mail link.
- **MCP:** `https://crm.bookete.com/mcp`. Agents can search, create and update leads, fill in the Kundenakte, log contacts and calls, record how an appointment went and create Gmail drafts. They cannot send or delete. Mail is logged from Gmail by the CRM, not by them.
- **Rules on the server:** opt-outs, status changes and the follow-up cadence are enforced on every write, whoever writes.
- **No lost edits:** a save changes only the fields you changed. A write based on data someone else changed in the meantime is redone on the fresh data, or refused with a message.

Architecture and commands: `../.claude/rules/project.md`.

## How a lead moves

- **Neu:** never contacted.
- **Kontaktiert:** contacted at least once, still open. The first call, mail or message in either direction, an opt-out message included, sets the date of first contact (`contactedAt`); it can't lie after today, is never cleared, and a lead with it can't go back to Neu. For a contact made outside the CRM, an agent enters it (MCP `update_lead`); that moves a Neu lead here.
- **Qualifiziert:** an appointment is agreed.
- **Kunde.**
- **Disqualifiziert:** closed, always with one of these reasons: Zufrieden mit aktueller Lösung, Kein Bedarf, Zu klein, Nicht unsere Zielgruppe, Geschlossen / existiert nicht, Nicht erreicht, Keine Kontaktaufnahme gewünscht. Which system a business uses is a fact (`currentTool`), not a reason.

A disqualified lead has no follow-up. Any new contact reopens it as Kontaktiert. "Keine Kontaktaufnahme gewünscht" is an opt-out, and the same one whichever way it comes: the Opt-out button, the reason, wherever it is set (also on a business as it is added; the lead page's picker asks first, as the button does), a call, an agent or the unsubscribe link. Each gives the same lead: Disqualifiziert with that reason, no next step, and an entry in the Verlauf saying how the opt-out came. Then no outgoing contact until the opt-out is lifted. A Kunde who opts out stays Kunde with its win date and next step; only the follow-up date goes. After five unanswered contacts the CRM offers to close a lead as "Nicht erreicht".

Every call ends with one outcome, tapped on the lead page: Nicht erreicht (call again in two days, unless a date not set by the follow-up sequence is ahead, such as an appointment or a date with a next step; the fifth attempt without getting through closes the lead as "Nicht erreicht"), Rückruf (date required), Termin vereinbart (Qualifiziert, date required) or Kein Interesse (Disqualifiziert, reason required). A call in which we spoke to them counts as an answer. A call never moves a Kunde out of Kunde, and a missed one keeps their next step. An appointment agreed by mail, message or in person is entered with "Termin eintragen" (the status menu, or a mail thread): the same move as a Termin on a call, and no call is logged, so it is not counted as a call or as reached; nor among the appointments of the week, which come from calls. Not after an opt-out. On the appointment's day the lead asks how it went: Kunde, Kein Abschluss with a reason, or a new appointment. Heute is one queue: new answers, overdue, due today and leads in work with no next step, then the call list (due calls first, then new leads by fit, with the best calling time); "Abarbeiten" works through it with "Später" and "Weiter". The Anruf card has a folded Gesprächsleitfaden: the oldest template of that kind, else a default. Heute shows this week's calls, those reached, appointments, new customers (`wonAt`, the day a lead became Kunde, set by the server) and the most common reasons for Kein Interesse. A call logged by mistake can be taken back: it is erased, with no trace in Änderungen or the Papierkorb, and the lead's status, reason, follow-up, next step and first contact return to what they were before it. Only while it is the lead's newest entry and nothing changed the lead since, and never a call that recorded an opt-out.

## Setup

One-time, in this order.

### 1. Google Cloud (Workspace admin)

1. In https://console.cloud.google.com create a project, e.g. `bookete-crm`, in the bookete.com organization.
2. **APIs & Services → Library:** enable the **Gmail API**.
3. **Google Auth Platform → Branding/Audience:** user type **Internal**. Only bookete.com accounts can then sign in, and Google does not need to review the app.
4. **Data access:** add the scopes `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.compose` and `https://www.googleapis.com/auth/gmail.readonly`. A scope added later takes effect for each person at their next sign-in.
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
2. In the new CRM: **Mehr → Sicherung einspielen**. Only records the CRM has never held are added, so importing twice does no harm, and an import never undoes an opt-out or a deletion. An activity of a lead in the Papierkorb goes there with it; one of an erased lead is not added.

### 6. Connect agents

- **claude.ai / Cowork:** Settings → Connectors → Add custom connector → `https://crm.bookete.com/mcp`.
- **Claude Code:** `claude mcp add --transport http bookete-crm https://crm.bookete.com/mcp`

The first connection opens a sign-in and a consent page. The agent then acts as you, and each change records it as `you@bookete.com (mcp)`.

## Backups and recovery

Three layers, from the smallest mistake to the biggest:

1. **A single change or a deleted lead:** **Änderungen** at the bottom of a lead shows who changed what, old and new value. A deleted lead goes to **Mehr → Papierkorb** (50 at a time, newest first; **Ältere anzeigen** goes further back) and comes back with its contact history.
   **Endgültig löschen** there erases the lead, all its contacts and its changes, for a business that asks to be deleted. Its opt-out goes with it, so its e-mail address takes mail again (see Gmail above). Time Travel (below) still holds it until its window has passed.
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
