---
paths:
  - "**/api/**"
  - "**/actions/**"
  - "**/actions.*"
  - "**/server/**"
  - "**/auth/**"
  - "**/middleware.*"
  - "**/webhooks/**"
  - "**/cron/**"
  - "**/functions/**"
---
<!-- Synced from brain-os (plugins/brain-ai-factory/rules/). Only the paths: globs may be changed here; record that in .brain-manifest.md. -->

# Boundaries: input, access, external calls

- **(2) Validate at the boundary, trust inside it.** Parse untrusted input
  (requests, webhooks, external APIs, env/config) once, at the edge,
  into a typed shape. Inner layers trust the type. *Mechanism:* the
  schema library named in `.claude/rules/project.md` at every external boundary.
- **(9) One gate, one seam.** Two paths that decide the same access question
  call one function. Never copy a check. *Mechanism:* review; a grep in
  CI where the duplicate pattern is known.
- **(10) The layer that offers is not the gate that commits.** Every business
  rule is enforced in the write path. Filtering what the UI offers is
  UX, not enforcement. *Mechanism:* integration tests call the write
  path directly.
- **(11) Every dependency declares a failure posture.** For each external
  call in a security, abuse or correctness path, state fail-closed or
  fail-open at the call site. Missing production credentials stop the
  boot instead of silently degrading. *Mechanism:* config schema
  requires them in production.

## Defect checks

- **(class 5) Effect markers before the effect.** Set "done" or "sent" markers only
  after the effect is confirmed. I/O helpers return success; release a
  claim on failure.
- **(class 7) Gates ordered against their cost.** Cheapest local check first:
  schema parse, then rate limit, then external calls, then the datastore.
- **(class 4) Invariants only in app code.** An invariant reachable through a
  generated or RPC API must be enforced where that API enforces it.
