<!-- Synced from brain-os (plugins/brain-ai-factory/rules/). Do not edit here: put local rules in .claude/rules/ outside brain-os/. -->

# Coding Principles

Binding for human and AI contributors. Numbers match the long form in
brain-os (profiles/ai-factory/evidence.md). Stack specifics (schema
library, backlog, CI, branch model) are named in
`.claude/rules/project.md`. More principles load with the files they apply
to: `.claude/rules/brain-os/boundaries.md`,
`.claude/rules/brain-os/data.md`, `.claude/rules/brain-os/tests.md`.

- **(1) Deep modules, shallow surface.** Few modules with strong interfaces.
  Split only at a real deployment or testability boundary, never for
  line count. *Why:* over-fragmented code is harder for people and
  models to follow. *Mechanism:* review asks "how many files would the
  next change to this concept touch?" (review-only)
- **(3) Every rule ships with a mechanism.** A rule with no hook, lint rule,
  CI check or test is a suggestion. *Why:* prose-only rules quietly stop
  being followed. *Mechanism:* a new rule names its mechanism, or goes
  to the backlog marked `(unenforced)`.
- **(4) Verify, don't self-trust.** Nobody reviews their own diff and calls
  it done. Changes to auth, access control, payments or migrations get a
  fresh-context second review before merge. *Why:* green gates are not a
  correctness proof. *Mechanism:* branch protection with review and green
  CI; `/second-review` for agent-authored changes.
- **(6) Gates are honestly labeled.** A step that cannot fail is never
  marked blocking. One that should not block yet is advisory, with a
  plan to promote it. *Why:* a fake gate is worse than none.
  *Mechanism:* each CI step declares blocking or advisory next to it.
- **(7) AI output is an amplifier, not a shortcut.** Fix typing, error
  handling and tests before scaling agent-written volume. Budget a
  whole-surface review that no single phase owns. *Why:* agent-written
  code carries more defects on a weak base. (review-only)
- **(8) Names are compressed documentation.** A clear name beats a comment
  explaining a vague one. *Why:* people and models both read names as
  meaning. *Mechanism:* code review.
- **Docs change with behaviour.** README, changelog and comments are
  updated in the same change as the code they describe. Comments say
  why, not what. *Mechanism:* review.

Evidence and long form: brain-os, profiles/ai-factory/evidence.md.
