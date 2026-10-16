# Backlog

Open work for bookete-os, by priority. Groom it with `/groom-backlog` at each
CRM release. Dates are absolute.

- **P0:** active risk, blocks production, or legal exposure.
- **P1:** next up, real impact or meaningful debt.
- **P2:** when time allows: quality, hardening, performance.
- **P3:** later or nice to have.

_Last groomed: 2026-10-16_

## Now (in flight)

Nothing in flight. Next up: the P1 data-safety items, starting with lost updates.

## P0

_None._ The CRM holds real lead data since 2026-10-16, but only two
allowlisted users can reach it, and the open items below are about losing
or overwriting data by mistake, not about outside access.

## P1

CRM data safety (one migration, touches the write path: `/second-review` on the plan first):

- CRM: lost updates. The edit form sends every field and `updateLead` writes them all, so a concurrent edit by the other user or an agent is overwritten without warning (`crm/src/web/controller.js` `saveLead`, `crm/src/application/use-cases.js` `updateLead`). Give each record a version, refuse a save with a stale one, and send only the changed fields.
- CRM: writes to a deleted lead succeed silently. `patch` matches zero rows and nothing reports it (`crm/src/server/store.js`). Goes with the item above.
- CRM: change history. Only the last `updated_by` is kept. An append-only history per record answers who changed what, and makes a restore possible.
- CRM: deletes cannot be undone. `remove` empties the record and its activities (`data = '{}'`). Soft delete with a restore.
- CRM: backups. D1 Time Travel restores any minute of the last 7 days on the free plan, 30 on paid (`wrangler d1 time-travel`); write that down in `crm/README.md` and add a weekly automatic export.

Other:

- Move the repo to stage `live` (`profiles/ai-factory/patterns/deploy-safety.md` §0): the CRM has real users and data since 2026-10-16. That means a `staging` branch, a staging Worker with its own D1, and branch protection. Owner decision pending.
- CRM: tasks as their own records (due date, optional time, owner, done), replacing the overloaded `nextStep` and the single `followUp`. Needs the owner model decided: one owner per lead, or shared.
- CRM: meeting outcome. After a demo date passes, ask how it went and set status and next task from the answer (9 leads sat in "Demo" with past dates on 2026-10-16).
- CRM: detect replies. A cron reads the Gmail threads of sent mails and logs incoming replies, so leads move to "Antwort" on their own. Needs the `gmail.readonly` scope.
- Scraper → CRM: import scraped leads (CSV or MCP `create_lead`), skipping businesses already in the CRM. Needs duplicate detection first.
- Legal check before scaling email outreach: §107 TKG generally requires prior consent for marketing email, B2B included.

## P2

- CRM: security headers on every response (CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`).
- CRM: rate-limit `/oauth/register` and `/auth/login` (open endpoints; low risk with two users).
- CRM: "sign out everywhere" (sessions last 30 days and are never rotated).
- CRM: `search_leads` over MCP answers about 50 KB; page it and return a compact field set.
- CRM: show who changed a lead last (`updated_by` is stored, not shown).
- CRM: a pipeline board, one column per status, with counts.
- Migration safety (principle 5): no migration linter exists for D1/SQLite here (unenforced — needs tooling). Until then, every migration gets `/second-review`.

## P3

- Root `package.json` is still named `bookete-scraper`; README and layout describe one tool.
- CRM: favicon.
- CRM: `server/mcp.js` reuses `web/search.js`; move the search core to `domain/` so the server does not import the web layer.

## Recently shipped (traceability)

### 2026-10-16

- CRM: due leads as todos in their own tab, overdue and today (d6f962e; `crm/src/web/views.js` `todosView`).
- ai-factory profile applied to the CRM: authorization walk over every API route and RPC command (`crm/test/access.test.js`), CI least privilege, timeouts and a migration dry-run before deploy (`.github/workflows/ci.yml`), CRM version and changelog (`crm/CHANGELOG.md`), this backlog format and `/groom-backlog`.
- CRM live at crm.bookete.com: D1 in the EU, Google sign-in for two allowlisted users, Gmail, remote MCP; backup of 585 leads imported (42ada2a, c4708fc).
- Repo on the brain-os ai-factory standard, core 0.10.0 (4ac0231).
