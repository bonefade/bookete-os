# bookete CRM

The shared CRM for bookete's outreach, at https://crm.bookete.com.
Two people sign in with their `@bookete.com` Google accounts. Agents (Claude, Claude Code) work in it through MCP.

- **Web app:** leads, contact history, follow-ups, templates. Changes from the other person show up within seconds.
- **Gmail:** "Per Gmail senden" in the compose sheet sends from your own mailbox and logs the message.
- **MCP:** `https://crm.bookete.com/mcp`. Agents can search, create and update leads, log contacts and create Gmail drafts. They cannot send or delete.
- **Rules on the server:** opt-outs, status changes and the follow-up cadence are enforced on every write, whoever writes.

Architecture and commands: `../.claude/rules/project.md`.

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
openssl rand -base64 32 | npx wrangler secret put CONSENT_SECRET  # signs remembered MCP consents
npx wrangler secret put ALLOWED_EMAILS     # e.g. you@bookete.com,partner@bookete.com
```

The Worker refuses every request while one of these is missing or malformed.
Changing `TOKEN_KEY` makes stored Gmail access unreadable: everyone signs in again.
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

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in the Google client for localhost
npx wrangler d1 migrations apply crm --local
npm run dev                      # http://localhost:8787
npm test
```
