<!-- Synced from brain-os (plugins/brain-ai-factory/rules/). Do not edit here: put local rules in .claude/rules/ outside brain-os/. -->

# Hard rules for coding agents

No exceptions without the owner's explicit say.

- **Ask, don't guess.** If the task is unclear or the spec looks wrong,
  ask before building. Pushing back on a wrong spec is part of the job.
- **Smallest footprint.** Change only what the task needs. No drive-by
  refactors, no unrequested files, layers, dependencies or options.
- **Goal-focused.** Every changed line serves the stated problem.
  Anything else goes to the backlog, not into the diff.
- **Simplest proper solution.** Solve the real problem the simplest way
  that is professionally sound. No workarounds, hacks, suppressed errors,
  special cases to make a test pass, or "temporary" fixes. If the proper
  fix is out of reach, stop and say why instead of working around it.
- **Clean and solid.** Clear names. Match the surrounding style. Fix the
  root cause, not the symptom.
- **No stale code, no duplication.** Remove what your change makes stale:
  dead code, unused imports, functions, flags, files, outdated comments
  and docs. No commented-out code and no legacy copies "just in case":
  git keeps the history. Where your change touches duplicated logic,
  merge it into one source. Duplication elsewhere goes to the backlog.
- **Reuse first.** Before implementing anything, search the repo for an
  existing component, helper or pattern that does the job. Use or extend
  it. Build new only when nothing fits, and build it reusable.
- **Lean work.** Delete before you add. Touch as few files as the fix
  allows.
- **Prove it works.** Run the repo's lint, type-check and tests before
  saying "done". Report failures as they are, never as passing.
- **Safe by default.** No secrets in code, logs or commits. No destructive
  action without the owner's OK: force push, history rewrite on a shared
  branch, deleting data, migrations against production.
- **A history people can read.** One commit per logical change, not per
  step. Fold fix-ups ("fix typo", "wip", "address review") into the
  commit they fix before pushing; after pushing, add a normal commit.
  Messages say what and why: `<type>(<scope>): <summary>`. Each feature
  lands as one squash commit, through a pull request or a local
  `git merge --squash`. A promotion (`staging` → `main`) is a merge
  commit, never a squash. The repo's branch model:
  `.claude/rules/project.md`.
- **Plain speech.** Short sentences. Simple words. Say what changed and
  why, nothing more. Applies to chat, commits, PRs and comments.

*Enforcement:* the pre-commit hook runs the checks; squash merging is enabled
and used for feature pull requests (a GitHub setting). `/second-review`
flags any change the task did not need,
any workaround where a proper fix exists, stale code left behind, and any
code that duplicates an existing component. Compliance is
review-only.
