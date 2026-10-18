# Backlog

Open work for bookete-os, by priority. Groom it with `/groom-backlog` at each
CRM release. Dates are absolute.

- **P0:** active risk, blocks production, or legal exposure.
- **P1:** next up, real impact or meaningful debt.
- **P2:** when time allows: quality, hardening, performance.
- **P3:** later or nice to have.

_Last groomed: 2026-10-18_

## Now (in flight)

Nothing in flight.

## P0

_None._ The CRM holds real lead data since 2026-10-16, but only two
allowlisted users can reach it, and the open items below are about losing
or overwriting data by mistake, not about outside access.

## P1

- CRM: open and click tracking like HubSpot (owner, 2026-10-17): owner's decision, not built. A tracking pixel or rewritten links read the recipient's device without consent (§165 (3) TKG 2021, Art. 5 (3) ePrivacy, GDPR). "Detect replies" below tells us who answered without that.
- Scraper → CRM: import scraped leads (CSV or MCP `create_lead`), skipping businesses already in the CRM. Needs duplicate detection first.
- Legal check before scaling email outreach: §107 TKG generally requires prior consent for marketing email, B2B included.
- CRM: weekly automatic export of the database to R2 (needs a bucket), so a copy exists outside D1 and its 7-day Time Travel window.

## P2

- Move the repo to stage `live` (`profiles/ai-factory/patterns/deploy-safety.md` §0): a `staging` branch, a staging Worker with its own D1, and branch protection. Owner decided 2026-10-16 to skip it for now; revisit when a third person or a second write path joins.
- CRM: a check of the store against real D1 in CI. Since 1.17.0 an advisory CI job applies the migrations to local D1 and runs a smoke query; the store's tests still run on node:sqlite only. the write guard, the history triggers and the purge were checked once by hand against local D1 (workerd) on 2026-10-16. Migration 0003 was run on local D1 by the 1.4.1 reviewer on 2026-10-17: rows equal to node:sqlite's, and the whole file rolled back when the self-check failed; its today fallback for undatable rows was checked there the same day.
- CRM: a pipeline board, one column per status, with counts.
- Rule gap: a migration that removes what the running Worker still writes (a contract step) reaches production only after the Worker that no longer writes it is live. The deploy applies migrations before the new Worker, and nothing stops both steps from reaching `main` in one push; 1.4.0 and 1.4.1 were pushed apart by hand (unenforced).
- Migration safety (principle 5): no migration linter exists for D1/SQLite here (unenforced — needs tooling). Until then, every migration gets `/second-review`.
- Rule gap: an agent-facing write that replaces a stored list takes a base or merges by id. `update_account` has a test for it (`crm/test/account.test.js`); a new tool gets none by itself (unenforced; found in the 1.6.0 review).
- CRM: the Kundenakte's free-text fields (`access`, notes, a system's `what`) may still hold a password; nothing detects one, only the form and the MCP description say not to (unenforced; found in the 1.6.0 review).
- Rule gap: behaviour only a browser shows (history, scroll, focus, a layout at small heights such as a phone on its side) has no committed check; 1.5.0, 1.15.0 and 1.16.0 were checked with local Playwright scripts (unenforced; found in the 1.5.0 and 1.16.0 reviews).
- Rule gap: a test named for a regression is checked against that regression by mutation before merge: break the code that way, see the test go red, revert. 1.5.0's navigation test first stayed green under both mutations it was named for (unenforced; found in the 1.5.0 review).
- Rule gap: a rule derived from history (activities) must either be read with that history by a read-time upgrade or recomputed from it on write; 1.4.0's first-contact date missed this once (found in the 1.4.0 review). Its test went with the read-time upgrade in 1.9.2; the next read-time upgrade needs one again (unenforced).
- Rule gap: a comment in an applied migration may be edited when the code or tests it names change (wrangler tracks migrations by file name, so nothing re-runs); 0003's header was edited so in 1.9.2. No rule says so (unenforced; found in the 1.9.2 review).
- Rule gap: a migration that rewrites stored records chooses its rows by the stored format version (`schemaVersion`), not by a value the old and new formats share (unenforced; found in the 1.4 plan review).

- CRM: without Gmail, a lead whose address is closed only by a holder in the Papierkorb still gets mail links: the browser holds no trashed leads. The mail goes out, and logging it is refused. Documented in `crm/README.md` (found in the 1.11.0 review).
- CRM: a lead created with the reason "Keine Kontaktaufnahme gewünscht" counts as having replied. Matters once scraped leads are imported.
- CRM: one meaning, two labels: "Betrieb" and "Name", "Nachfassen" and "Nachfassen am", "Fit" and "ICP-Fit", "Kontaktiert seit" and "Erstkontakt" (`FIELD_LABEL`, `crm/src/domain/constants.js`).
- Rulebook (owner's call, from the 1.17.0 review): `.claude/rules/project.md` "Access" does not name the Gmail cron (`crm/src/server/sync.js`), which writes as each user without a session, and "History rows come from triggers ... no write path can skip them" does not say that `undoCall` and `purgeLead` delete history rows; `CLAUDE.md`'s access-boundary list for `/second-review` has no `sync.js`.
- Rule gap: a sync or import that writes into records held before it shipped gets a test against such records, and never undoes what a person set after the event it records (unenforced; found in the 1.17.0 reviews, where a mail found late would have moved planned follow-ups and reopened closed businesses).
- Rule gap: one Gmail message is on at most one activity (unenforced: only `recordMail` holds it, by `sameMail`, with no constraint in D1; found in the 1.17.0 review).
- Rule gap: a change to a JSON shape the deployed web bundle reads keeps a page from before it working, or the CHANGELOG says it does not (unenforced; found in the 1.16.4 review).
- CRM: an answer to a mail that came into the other user's mailbox starts a new thread in the sender's Gmail, as each mailbox has its own threads; the feed shows it as a thread of its own.
- CRM: MCP `search_leads` pages by offset, so a lead added between two pages can push another one past the page break.
- CRM: `searchLeads` (`crm/src/domain/search.js`) runs on every keystroke over all leads; its cost at a few thousand leads is unmeasured.
- CRM: a backup import batch uses 49 of the 50 queries D1 allows per Worker invocation on the Free plan; how D1 counts statements in one `batch` is unverified, and `crm/test/d1.js` does not model the cap (unenforced).
- Rule gap: an injected dependency gets no silent default; `retryPause` defaults to no wait, and only a Worker test shows both call sites pass the real one (unenforced; found in the 1.12.0 review).
- Rule gap: a test never asserts the wall-clock date. Three tests in `crm/test/access.test.js` expected 2026-10-17 and failed from 2026-10-18 (unenforced).
- Rule gap: every mail link goes through one helper that knows the address block (`channelLink`, `offersMailto`), and a UI test clicks what was drawn rather than calling the handler (unenforced; found in the 1.11 and 1.13.0 reviews).
- Rule gap: UI state belongs to its screen and is cleared on leaving it (`enterRoute`); 1.13.0 missed it once (unenforced).
- Rule gap: a guard that ignores a history step leaves the history in a state the next step handles, and its test takes that next step (unenforced; found in the 1.16.1 review).

## P3

- Root `package.json` is still named `bookete-scraper`; README and layout describe one tool. The root README still recommends Node 22, while CI tests the scraper on Node 26 since CRM 1.9.1 (`README.md`, for the scraper review).

## Recently shipped (traceability)

### 2026-10-18

All deployed by CI in one push to `main` (`.github/workflows/ci.yml`, `vars.CRM_DEPLOY`), then checked against the live `app.js`.

- CRM 1.18.0: the user's Gmail signature on every mail sent and every agent draft (HTML part plus text, `crm/src/server/gmail.js` `signature`), with a text preview and "Mit Signatur" in the composer (owner's picks: HTML mail, sends and drafts, show with a switch).
- CRM 1.17.0: the lead page redesign the owner approved on the design canvas (one feed, one composer, status from outcomes, one next-step line) and Heute as one queue; Gmail replies and threads from both mailboxes every 5 minutes (`gmail.readonly`, migration 0004, `crm/src/server/sync.js`); answers in their thread; undo of a call (`undoCall`); MCP `meeting_outcome`; a closed address no longer counts as "mit E-Mail". Replaces "tasks as their own records" (owner's pick Q3) and "detect replies". Papierkorb retention decided: kept until erased.
- CRM 1.16.5: the closed-address hint shows a German date, and on a lead whose own opt-out arrives while the sheet is open it no longer names the lead as holding "dieselbe Adresse"; a test pins that sheet for a Kunde with Gmail connected (`addressOptOutText`, `crm/src/domain/lead.js`).
- CRM 1.16.4: the Papierkorb reads one more than a page and offers older ones only when they exist (`trash`, `crm/src/server/store.js`).
- CRM 1.16.3: the search over the screen ends above the bottom tabs, so a result picked by key stays in view; at 320px the top bar drops "CRM" so the whole placeholder shows (`.sbox`, `--tabbar`, `crm/public/index.html`).
- CRM 1.16.2: a business's page opened by a link or a reload belongs to Betriebe, not Heute (`applyRoute`, `crm/src/web/controller.js`; found in the 1.16.0 review).
- CRM 1.16.1: + Neu and the ICP form keep what was typed through a sync, a sort or a filter (the drafts live in the UI state, `QUICK_ADD_FIELDS`, `crm/src/web/controller.js`); Forward onto the search's entry over a form steps off it again, so the search stays shut and the history matches the screen, and / and Ctrl+K keep their own meaning where no search can open (found in the 1.16.0 review).
- CRM 1.16.0: the tabs show on every screen, on the left from tablet width, and are shut while a form holds input (owner: "move the tab bar to the left side and keep it visible for all screens and pages"; on a phone they stay at the bottom, owner's choice).
- CRM 1.15.0: the search opens over the screen, which stays as it is under it; no `#/suche` address any more (owner: "the click on the search bar should not change the site but just show a overlay for the search").
- CRM 1.14.0: the Papierkorb pages back 50 at a time (`GET /api/trash?before=`).
- CRM 1.13.2: delete, restore and erase move a lead's activities in two fixed statements; `crm/test/d1.js` models D1's 50 queries per invocation, and an import request takes at most one chunk.
- CRM 1.13.1: a backup import puts a trashed lead's activity in the Papierkorb and adds none to an erased lead, guarded by the lead as read (owner: "Add it to the trash").
- CRM 1.13.0: the search field sits in the top bar on every screen, the Suche tab is gone (owner, 2026-10-17).
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
