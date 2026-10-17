# Backlog

Open work for bookete-os, by priority. Groom it with `/groom-backlog` at each
CRM release. Dates are absolute.

- **P0:** active risk, blocks production, or legal exposure.
- **P1:** next up, real impact or meaningful debt.
- **P2:** when time allows: quality, hardening, performance.
- **P3:** later or nice to have.

_Last groomed: 2026-10-17_

## Now (in flight)

CRM 1.9.3 to 1.14.0: the clear items of the 1.9.2 groom and the top-bar search, one release each (owner, 2026-10-17).

## P0

_None._ The CRM holds real lead data since 2026-10-16, but only two
allowlisted users can reach it, and the open items below are about losing
or overwriting data by mistake, not about outside access.

## P1

- CRM: a backup import adds an activity the CRM never held even when its lead is in the Papierkorb or erased; on an erased lead that brings text back after the erase, and an import landing during an erase leaves its activity live and without history, because `purgeLead` guards only the lead row. Decide whether an import may add to a trashed lead, and refuse it for an erased one (second review of 1.9.0, 2026-10-17).
- CRM: open and click tracking like HubSpot (owner, 2026-10-17): owner's decision, not built. A tracking pixel or rewritten links read the recipient's device without consent (§165 (3) TKG 2021, Art. 5 (3) ePrivacy, GDPR). "Detect replies" below tells us who answered without that.
- CRM: tasks as their own records (due date, optional time, done), replacing the overloaded `nextStep` and the single `followUp`. Owner decided 2026-10-16: one owner per lead, so a lead gets an `owner` and Todos shows "mine" first.
- CRM: detect replies. A cron reads the Gmail threads of sent mails and logs incoming replies, so a reply is logged and due on its own. Needs the `gmail.readonly` scope.
- Scraper → CRM: import scraped leads (CSV or MCP `create_lead`), skipping businesses already in the CRM. Needs duplicate detection first.
- Legal check before scaling email outreach: §107 TKG generally requires prior consent for marketing email, B2B included.
- CRM: weekly automatic export of the database to R2 (needs a bucket), so a copy exists outside D1 and its 7-day Time Travel window.

## P2

- Move the repo to stage `live` (`profiles/ai-factory/patterns/deploy-safety.md` §0): a `staging` branch, a staging Worker with its own D1, and branch protection. Owner decided 2026-10-16 to skip it for now; revisit when a third person or a second write path joins.
- CRM: trash retention. Deleted leads stay in the Papierkorb until someone erases them; decide whether they should be erased on their own after a set time.
- CRM: Papierkorb paging. It lists the newest 50 deleted leads; older ones show once those are restored or erased.
- CRM: deleting or restoring a lead writes one statement per activity; D1 allows 50 queries per Worker invocation on the Free plan, so a lead with about 45 activities could not be deleted (production on 2026-10-16: at most 3). Write a lead's activities in one statement, and model the cap in `crm/test/d1.js`. (unenforced)
- CRM: a check of the store against real D1 in CI. The unit tests run on node:sqlite; the write guard, the history triggers and the purge were checked once by hand against local D1 (workerd) on 2026-10-16. Migration 0003 was run on local D1 by the 1.4.1 reviewer on 2026-10-17: rows equal to node:sqlite's, and the whole file rolled back when the self-check failed; its today fallback for undatable rows was checked there the same day.
- CRM: a pipeline board, one column per status, with counts.
- Rule gap: a migration that removes what the running Worker still writes (a contract step) reaches production only after the Worker that no longer writes it is live. The deploy applies migrations before the new Worker, and nothing stops both steps from reaching `main` in one push; 1.4.0 and 1.4.1 were pushed apart by hand (unenforced).
- CRM: undo a wrongly tapped call outcome. Today the status and follow-up are set back by hand; the call stays in the Verlauf.
- CRM: a calling-time hint on the call list (best 14:30–17:00, not Monday or Tuesday).
- CRM: the appointment answer (Kunde, Kein Abschluss, Neuer Termin) is web only; agents use `change_status` and `set_follow_up`. Add an MCP tool if agents need it.
- Migration safety (principle 5): no migration linter exists for D1/SQLite here (unenforced — needs tooling). Until then, every migration gets `/second-review`.
- Rule gap: an agent-facing write that replaces a stored list takes a base or merges by id. `update_account` has a test for it (`crm/test/account.test.js`); a new tool gets none by itself (unenforced; found in the 1.6.0 review).
- CRM: the Kundenakte's free-text fields (`access`, notes, a system's `what`) may still hold a password; nothing detects one, only the form and the MCP description say not to (unenforced; found in the 1.6.0 review).
- Rule gap: behaviour only a browser shows (history, scroll, focus) has no committed check; 1.5.0 was checked with a local Playwright script (unenforced; found in the 1.5.0 review).
- Rule gap: a test named for a regression is checked against that regression by mutation before merge: break the code that way, see the test go red, revert. 1.5.0's navigation test first stayed green under both mutations it was named for (unenforced; found in the 1.5.0 review).
- Rule gap: a rule derived from history (activities) must either be read with that history by a read-time upgrade or recomputed from it on write; 1.4.0's first-contact date missed this once (found in the 1.4.0 review). Its test went with the read-time upgrade in 1.9.2; the next read-time upgrade needs one again (unenforced).
- Rule gap: a comment in an applied migration may be edited when the code or tests it names change (wrangler tracks migrations by file name, so nothing re-runs); 0003's header was edited so in 1.9.2. No rule says so (unenforced; found in the 1.9.2 review).
- Rule gap: a migration that rewrites stored records chooses its rows by the stored format version (`schemaVersion`), not by a value the old and new formats share (unenforced; found in the 1.4 plan review).

## P3

- Root `package.json` is still named `bookete-scraper`; README and layout describe one tool. The root README still recommends Node 22, while CI tests the scraper on Node 26 since CRM 1.9.1 (`README.md`, for the scraper review).

## Recently shipped (traceability)

### 2026-10-18

All deployed by CI in one push to `main` (`.github/workflows/ci.yml`, `vars.CRM_DEPLOY`), then checked against the live `app.js`.

- CRM 1.12.0: a short random wait between write retries (`retryPause`, `crm/src/adapters/system.js`).
- CRM 1.11.2: field labels in forms, search, the lead page and the Betriebe list come from `FIELD_LABEL` (`crm/src/domain/constants.js`).
- CRM 1.11.1: with Gmail connected, mail that gets the Abmeldelink goes out only by Gmail; no mailto in the compose sheet or the quick bar (owner: "Gmail only when connected").
- CRM 1.11.0: an opt-out closes its e-mail address to mail, on every lead that holds it (`optOutByAddress`, `crm/src/server/store.js`). Owner, 2026-10-17: service mail to a Kunde is exempt; an outgoing E-Mail to a closed address can't be logged by hand; changing that lead's address or erasing it opens the address again.

### 2026-10-17

All deployed by CI on a push to `main` (`.github/workflows/ci.yml`, `vars.CRM_DEPLOY`), each checked against the live `app.js` before the next.

- CRM 1.10.1: the opt-out reason, wherever it is set (a new lead too), records the opt-out as the Opt-out button does (`leadOps`, `crm/src/application/use-cases.js`).
- CRM 1.10.0: MCP `search_leads` answers in pages (`offset`, `limit` up to 50) of short summaries (`crm/src/server/mcp.js`).
- CRM 1.9.3: the search core moved to `crm/src/domain/search.js`; nothing outside `crm/src/web/` imports the web layer (`crm/test/boundaries.test.js`).
- CRM 1.9.2: leads are read as stored; the read-time `upgradeLead` is gone from `crm/src/server/store.js` and the use cases, kept for old backups in `chunkBackup` (44153f2). Precondition count on production: no lead outside the five statuses or below schemaVersion 3.
- CRM 1.9.1: CI and `engines` on Node 26 (e1ee4bd).
- CRM 1.9.0: an unsubscribe link (HMAC, `crm/src/server/unsubscribe.js`) in every mail but service mail to a Kunde, with one-click headers; rate limited in its own bucket (399204f).
- CRM 1.8.0: call script (a `leitfaden` template) and this week's numbers on Heute (69a52cb).
- CRM 1.7.0: call outcomes, a call list and the appointment answer; `log_call` over MCP (3c06d95).
- CRM 1.6.0: the Kundenakte on the lead (`crm/src/domain/account.js`), `update_account` over MCP (bb3800a).
- CRM 1.5.0: every screen has its own address (e00ebd6).
- CRM 1.4.1: migration `0003_statuses.sql` rewrote 585 stored leads to the five statuses (6c04798). Then the notes pass: 247 leads set by their notes through MCP (19 disqualified with a reason, 9 dated first contacts).
- CRM 1.4.0: five statuses, a reason for every disqualified lead, the first-contact date (89cb175).
