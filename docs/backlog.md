# Backlog

Open work for bookete-os, by priority. Groom it with `/groom-backlog` at each
CRM release. Dates are absolute.

- **P0:** active risk, blocks production, or legal exposure.
- **P1:** next up, real impact or meaningful debt.
- **P2:** when time allows: quality, hardening, performance.
- **P3:** later or nice to have.

_Last groomed: 2026-10-16_

## Now (in flight)

Nothing in flight. Next up: tasks as their own records (one owner per lead, decided 2026-10-16).

## P0

_None._ The CRM holds real lead data since 2026-10-16, but only two
allowlisted users can reach it, and the open items below are about losing
or overwriting data by mistake, not about outside access.

## P1

- CRM: tasks as their own records (due date, optional time, done), replacing the overloaded `nextStep` and the single `followUp`. Owner decided 2026-10-16: one owner per lead, so a lead gets an `owner` and Todos shows "mine" first.
- CRM: meeting outcome. After a demo date passes, ask how it went and set status and next task from the answer (9 leads sat in "Demo" with past dates on 2026-10-16).
- CRM: detect replies. A cron reads the Gmail threads of sent mails and logs incoming replies, so leads move to "Antwort" on their own. Needs the `gmail.readonly` scope.
- Scraper → CRM: import scraped leads (CSV or MCP `create_lead`), skipping businesses already in the CRM. Needs duplicate detection first.
- Legal check before scaling email outreach: §107 TKG generally requires prior consent for marketing email, B2B included.
- CRM: weekly automatic export of the database to R2 (needs a bucket), so a copy exists outside D1 and its 7-day Time Travel window.

## P2

- Move the repo to stage `live` (`profiles/ai-factory/patterns/deploy-safety.md` §0): a `staging` branch, a staging Worker with its own D1, and branch protection. Owner decided 2026-10-16 to skip it for now; revisit when a third person or a second write path joins.
- CRM: security headers on every response (CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`).
- CRM: rate-limit `/oauth/register` and `/auth/login` (open endpoints; low risk with two users).
- CRM: "sign out everywhere" (sessions last 30 days and are never rotated).
- CRM: trash retention. Deleted leads stay in the Papierkorb until someone erases them; decide whether they should be erased on their own after a set time.
- CRM: `search_leads` over MCP answers about 50 KB; page it and return a compact field set.
- CRM: Papierkorb paging. It lists the newest 50 deleted leads; older ones show once those are restored or erased.
- CRM: deleting or restoring a lead writes one statement per activity; D1 allows 50 queries per Worker invocation on the Free plan, so a lead with about 45 activities could not be deleted (production on 2026-10-16: at most 3). Write a lead's activities in one statement, and model the cap in `crm/test/d1.js`. (unenforced)
- CRM: a short random wait between write retries. 30 parallel agent writes to one lead: 8 commit, 22 get "try again" (all-or-nothing, nothing lost).
- CRM: field labels are written out again in the edit form (`leadEditView`), quick add and search (`web/search.js`); take them from `FIELD_LABEL` in `web/format.js`.
- CRM: a check of the store against real D1 in CI. The unit tests run on node:sqlite; the write guard, the history triggers and the purge were checked once by hand against local D1 (workerd) on 2026-10-16.
- CRM: a pipeline board, one column per status, with counts.
- Migration safety (principle 5): no migration linter exists for D1/SQLite here (unenforced — needs tooling). Until then, every migration gets `/second-review`.

## P3

- Root `package.json` is still named `bookete-scraper`; README and layout describe one tool.
- CRM: `server/mcp.js` reuses `web/search.js`; move the search core to `domain/` so the server does not import the web layer.

## Recently shipped (traceability)

### 2026-10-16

- CRM 1.2.0, data safety: a save writes only changed fields; every lead write is guarded against a concurrent change and retried, or refused with a message (409); change history from database triggers, shown as "Änderungen"; deletes go to a Papierkorb with restore and an erase for good; backups and recovery in `crm/README.md` (migration `0002_history.sql`).
- CRM: bookete logo (Connected Circles mark and wordmark) in the header, favicon and home-screen icon, taken from the bookete app's `public/brand/` (`crm/public/index.html`).
- CRM: due leads as todos in their own tab, overdue and today (d6f962e; `crm/src/web/views.js` `todosView`).
- ai-factory profile applied to the CRM: authorization walk over every API route and RPC command (`crm/test/access.test.js`), CI least privilege, timeouts and a migration dry-run before deploy (`.github/workflows/ci.yml`), CRM version and changelog (`crm/CHANGELOG.md`), this backlog format and `/groom-backlog`.
- CRM live at crm.bookete.com: D1 in the EU, Google sign-in for two allowlisted users, Gmail, remote MCP; backup of 585 leads imported (42ada2a, c4708fc).
- Repo on the brain-os ai-factory standard, core 0.10.0 (4ac0231).
