---
name: groom-backlog
description: Reconcile docs/backlog.md against reality (git history + code + CI). Mark shipped items done, re-triage priorities, refresh the "Now" section, and keep the file lean. Use at each CRM release (version bump), or when the backlog feels stale.
---

# Groom the backlog

Copied by hand from brain-os `profiles/ai-factory/templates/groom-backlog.skill.template.md` (2026-10-16).

`docs/backlog.md` is the single source of truth for work; this repo does not use GitHub Issues. It rots between releases: done items linger, priorities drift. This skill reconciles it with what actually happened.

## Steps

1. **Gather reality.** Run `git log --oneline` since the newest date under "Recently shipped", and skim the diffstat. Where an item names a file or symbol, check the current code.
2. **Mark shipped items done.** For each open item whose work is now in the code or history, remove it from its band and fold it into a dated entry under `## Recently shipped (traceability)`, newest first, citing the commit and key files.
3. **Catch silent drift.** Flag items that contradict reality (work that already exists, a file that moved). Fix or delete them.
4. **Re-triage.** Re-evaluate the P0–P3 bands against their definitions at the top of the file. Promote what became urgent; demote or delete what is obsolete.
5. **Refresh `## Now (in flight)`.** The 1–3 things actually being worked on, or one line "Nothing in flight. Next up: …".
6. **Keep it lean.** When "Recently shipped" grows past about two releases, delete the oldest entries; git keeps them. Update `_Last groomed:`.
7. **Ship it.** A docs-only change: feature branch → `main`, one squash commit. CI skips `docs/**`.

## Conventions

- Items: the area, a short title, file or symbol references.
- Dates are absolute (`2026-10-16`), never "today".
- Don't invent work: record only what the code and history show.
