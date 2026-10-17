# Backlog

Open work for bookete-os, by priority. Groom it with `/groom-backlog` at each
CRM release. Dates are absolute.

- **P0:** active risk, blocks production, or legal exposure.
- **P1:** next up, real impact or meaningful debt.
- **P2:** when time allows: quality, hardening, performance.
- **P3:** later or nice to have.

_Last groomed: 2026-10-17_

## Now (in flight)

CRM 1.4: five statuses with required reasons (1.4.0), then migration 0003 rewriting the stored leads (1.4.1). Then, in this order (owner, 2026-10-17): lead pages with their own address, the Kundenakte, call outcomes and call list, call script and weekly numbers, email tracking with an unsubscribe link.

## P0

_None._ The CRM holds real lead data since 2026-10-16, but only two
allowlisted users can reach it, and the open items below are about losing
or overwriting data by mistake, not about outside access.

## P1

- CRM: drop the read-time `upgradeLead` in `crm/src/server/store.js` once migration 0003 has run in production (1.4.1). Keep it in `chunkBackup` for old backups. First count leads with a status outside the five, at any schemaVersion: the read-time upgrade is what covers a 1.3 write after 0003.
- CRM: lead pages with their own address, so the browser's back button, reload and links work (owner, 2026-10-17).
- CRM: Kundenakte for customers and those closing: what we deliver (bookete, homepage, integration), their systems (domain and who owns it, DNS, hosting, the agencies handling them) and the contacts to reach (owner, 2026-10-17).
- CRM: call outcomes and a call list with "Nächster" (release 2); call script and weekly numbers (release 3).
- CRM: email tracking like HubSpot, and an unsubscribe link for recipients (owner, 2026-10-17). Open tracking needs consent (TKG §165, GDPR); the unsubscribe link is a public endpoint and gets `/second-review`.

- CRM: tasks as their own records (due date, optional time, done), replacing the overloaded `nextStep` and the single `followUp`. Owner decided 2026-10-16: one owner per lead, so a lead gets an `owner` and Todos shows "mine" first.
- CRM: meeting outcome. After an appointment passes, ask how it went and set status and next task from the answer (9 leads sat in "Demo", now Qualifiziert, with past dates on 2026-10-16).
- CRM: detect replies. A cron reads the Gmail threads of sent mails and logs incoming replies, so a reply is logged and due on its own. Needs the `gmail.readonly` scope.
- Scraper → CRM: import scraped leads (CSV or MCP `create_lead`), skipping businesses already in the CRM. Needs duplicate detection first.
- Legal check before scaling email outreach: §107 TKG generally requires prior consent for marketing email, B2B included.
- CRM: weekly automatic export of the database to R2 (needs a bucket), so a copy exists outside D1 and its 7-day Time Travel window.

## P2

- CRM: picking the opt-out reason records the opt-out, but not as the Opt-out button does: no confirm, no "Opt-out" entry in the Verlauf, the next step kept. One use case for both (second review of 1.4.0).
- Move the repo to stage `live` (`profiles/ai-factory/patterns/deploy-safety.md` §0): a `staging` branch, a staging Worker with its own D1, and branch protection. Owner decided 2026-10-16 to skip it for now; revisit when a third person or a second write path joins.
- CRM: trash retention. Deleted leads stay in the Papierkorb until someone erases them; decide whether they should be erased on their own after a set time.
- CRM: `search_leads` over MCP answers about 50 KB; page it and return a compact field set.
- CRM: Papierkorb paging. It lists the newest 50 deleted leads; older ones show once those are restored or erased.
- CRM: deleting or restoring a lead writes one statement per activity; D1 allows 50 queries per Worker invocation on the Free plan, so a lead with about 45 activities could not be deleted (production on 2026-10-16: at most 3). Write a lead's activities in one statement, and model the cap in `crm/test/d1.js`. (unenforced)
- CRM: a short random wait between write retries. 30 parallel agent writes to one lead: 8 commit, 22 get "try again" (all-or-nothing, nothing lost).
- CRM: field labels are written out again in the edit form (`leadEditView`), quick add and search (`web/search.js`); take them from `FIELD_LABEL` in `web/format.js`.
- CRM: a check of the store against real D1 in CI. The unit tests run on node:sqlite; the write guard, the history triggers and the purge were checked once by hand against local D1 (workerd) on 2026-10-16. Migration 0003 was run on local D1 by the 1.4.1 reviewer on 2026-10-17: rows equal to node:sqlite's, and the whole file rolled back when the self-check failed; its today fallback for undatable rows was checked there the same day.
- CRM: a pipeline board, one column per status, with counts.
- CRM: deploy 1.4.1 (migration 0003) only once 1.4.0 is live (Mehr shows 1.4.0): while 1.3 still runs, it can write an old status onto a rewritten lead. Nothing stops both from reaching `main` in one push, and the deploy applies migrations before the new Worker is live (unenforced).
- Migration safety (principle 5): no migration linter exists for D1/SQLite here (unenforced — needs tooling). Until then, every migration gets `/second-review`.
- Rule gap: a rule derived from history (activities) must either be read with that history by the read-time upgrade or recomputed from it on write; 1.4.0's first-contact date missed this once (found in the 1.4.0 review). Mechanism: `crm/test/statuses.test.js` runs every lead write on old rows with activities and checks the stored first contact; a new history-derived rule adds its check there.
- Rule gap: a migration that rewrites stored records chooses its rows by the stored format version (`schemaVersion`), not by a value the old and new formats share (unenforced; found in the 1.4 plan review).

## P3

- Root `package.json` is still named `bookete-scraper`; README and layout describe one tool.
- CRM: `server/mcp.js` reuses `web/search.js`; move the search core to `domain/` so the server does not import the web layer.

## Recently shipped (traceability)

### 2026-10-16

- CRM 1.3.0: the deployed version shows under Mehr → Konto (from `crm/package.json`, through `/api/me`).
- CRM 1.2.0, data safety: a save writes only changed fields; every lead write is guarded against a concurrent change and retried, or refused with a message (409); change history from database triggers, shown as "Änderungen"; deletes go to a Papierkorb with restore and an erase for good; backups and recovery in `crm/README.md` (migration `0002_history.sql`).
- CRM 1.2.0, hardening: Content-Security-Policy and related headers (`crm/public/_headers`), inline handlers removed; rate limit on sign-in and the open OAuth endpoints; "Überall abmelden" revokes agent grants and ends all sessions.
- CRM: bookete logo (Connected Circles mark and wordmark) in the header, favicon and home-screen icon, taken from the bookete app's `public/brand/` (`crm/public/index.html`).
- CRM: due leads as todos in their own tab, overdue and today (d6f962e; `crm/src/web/views.js` `todosView`).
- ai-factory profile applied to the CRM: authorization walk over every API route and RPC command (`crm/test/access.test.js`), CI least privilege, timeouts and a migration dry-run before deploy (`.github/workflows/ci.yml`), CRM version and changelog (`crm/CHANGELOG.md`), this backlog format and `/groom-backlog`.
- CRM live at crm.bookete.com: D1 in the EU, Google sign-in for two allowlisted users, Gmail, remote MCP; backup of 585 leads imported (42ada2a, c4708fc).
- Repo on the brain-os ai-factory standard, core 0.10.0 (4ac0231).
