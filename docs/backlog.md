# Backlog

Open work for bookete-os, by priority. Done items leave this file; git keeps them.

## Now (in flight)

- CRM go-live: Google OAuth client, Cloudflare D1/KV, secrets, DNS (`crm/README.md` § Setup).

## P0

_None._

## P1

- CRM: detect replies. A cron reads the Gmail threads of sent mails and logs incoming replies, so leads move to "Antwort" on their own. Needs the `gmail.readonly` scope.
- Scraper → CRM: import scraped leads (CSV or MCP `create_lead`), skipping businesses already in the CRM.
- Legal check before scaling email outreach: §107 TKG generally requires prior consent for marketing email, B2B included.

## P2

- CRM: rate-limit `/oauth/register` and `/auth/login` (open endpoints; low risk with two users).
- CRM: show who changed a lead last (`updated_by` is stored, not shown).

## P3

- Root `package.json` is still named `bookete-scraper`; README and layout describe one tool.
- CRM: favicon.
- CRM: `server/mcp.js` reuses `web/search.js`; move the search core to `domain/` so the server does not import the web layer.
