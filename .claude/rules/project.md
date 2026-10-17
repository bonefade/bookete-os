# Project: bookete-os

Internal tools for bookete's sales work: finding restaurants in Austria and
working them as leads. Two parts, each with its own `package.json`:

- `src/`, `test/`: the lead scraper. Node ESM CLI, no dependencies.
  OpenStreetMap discovery plus competitor-widget detection, CSV out.
- `crm/`: the bookete CRM at crm.bookete.com, for two users and their agents.
  Cloudflare Worker + D1 + static assets. Google Workspace sign-in, Gmail
  sending, a remote MCP server for agents.

## Commands

- Scraper tests: `npm test`
- CRM tests: `npm --prefix crm test`
- CRM build (web bundle): `npm --prefix crm run build`
- CRM local run: `cd crm && npm run dev` (needs `crm/.dev.vars`, see `crm/README.md`)
- `AGENTS.md` is generated: `python3 .claude/agents_md.py .` after changing `.claude/rules/`

## CRM architecture

- `crm/src/domain/`: pure business rules (lead fields, statuses, follow-up
  cadence, opt-out). Shared by server and browser.
- `crm/src/application/use-cases.js`: the only write path. The web app,
  MCP and backup import all call it, so every rule holds whoever writes.
  Import adds only records the CRM never held, through the same normalization.
- Concurrent writes: a write computed from a read names that read as `base`;
  the store commits it only if the record is unchanged (`write_guard`,
  migration 0002), else the use case runs again on fresh data after a short
  random wait (`retrying`, `retryPause`).
  The store refuses a patch, remove or restore without a `base`; only a put
  (a new record, or the ICP) goes without.
  History rows come from triggers on `docs`, so no write path can skip them.
- `crm/src/server/`: Worker entry (`index.js`), D1 document store, Google
  sign-in and sessions (`auth.js`), Gmail, RPC commands, MCP.
- `crm/src/web/`: the browser UI, bundled by esbuild to `crm/public/app.js`.
- Access: `allowedUser()` in `crm/src/server/auth.js` is the one check.
  Web sessions and MCP tokens both end there; `ALLOWED_EMAILS` decides.
  The one route that touches lead data without a session is the
  unsubscribe link (`/abmelden/`, `crm/src/server/unsubscribe.js`, routed
  in `index.js`): its HMAC decides, and it can only opt out the lead it was
  made for.
- Agents may draft email, never send it. Sending is a person in the web app.

## Stack specifics the rules refer to

- Schema library (principle 2): Zod 4, at every request and env boundary
  (`crm/src/server/commands.js`, `mcp.js`, `config.js`).
- Migrations: `crm/migrations/`, applied by `wrangler d1 migrations apply`.
- D1 test double: `crm/test/d1.js` runs on node:sqlite and refuses more than
  100 bound parameters per query, as D1 does. A handle from its `invocation()`
  also refuses more than 50 queries, D1's cap per Worker invocation on Free
  (each statement of a batch counts). Only tests that take one per request
  check the cap: the browser tests through the Worker, among them a full
  import chunk of activities (49 queries), and the delete, restore and erase
  of a lead with many activities.
- Backlog: `docs/backlog.md`, groomed with `/groom-backlog` at each CRM release.
- Release: each production deploy bumps `version` in `crm/package.json` and adds a `crm/CHANGELOG.md` entry.
- Access walk: `crm/test/access.test.js` calls every API route and RPC command without a valid session. A new command goes into its exact list.
- CI: `.github/workflows/ci.yml`. Deploy runs only after tests pass on `main`.
- Branch model: stage `early`. Feature branch → `main`, one squash commit per feature.
