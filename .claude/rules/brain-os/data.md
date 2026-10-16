---
paths:
  - "**/migrations/**"
  - "**/*.sql"
  - "**/schema.*"
  - "**/schema/**"
  - "**/db/**"
  - "supabase/**"
  - "prisma/**"
  - "drizzle/**"
---
<!-- Synced from brain-os (plugins/brain-ai-factory/rules/). Only the paths: globs may be changed here; record that in .brain-manifest.md. -->

# Data: schema, migrations, queries

- **(5) Expand before you contract.** A change that removes or narrows what
  deployed code still reads ships in stages: add the new shape,
  dual-write or dual-read, backfill, switch reads, then remove the old
  shape. Never in one step. *Mechanism:* a migration linter as a
  blocking CI gate; an expand/contract checklist on PRs that change a
  shared shape.

## Defect checks

- **(class 1) Arithmetic in a type that wraps.** `time` is modulo 24h:
  `'23:00' + 90min = '00:30'`. Do duration math in an unbounded domain
  (minutes, epoch) and constrain `end > start` in the database. The same
  bug appears in app code that computes end-of-day on the start date.
- **(class 3) Privilege granted by default.** Write grants are column lists on
  tables with billing, identity or trigger-managed columns.
- **(class 4) Invariants only in app code.** Enforce in the database what a
  generated or RPC API can reach.
- **(class 6) Multi-write without a transaction.** One transaction, or a documented
  cleanup and an honest message to the operator.
- **(class 8) Nondeterministic single-row selection.** `limit 1` that resolves
  identity or tenancy always has an explicit order.
