# Claude Code in this repo

The rulebook is `.claude/rules/`, which Claude Code loads by itself; `AGENTS.md` is the copy generated from it for the other tools. This file holds only what is specific to Claude Code and restates nothing from the rules.

## Start in the repository root

Start `claude` in the checkout itself. Project settings, plugins, the status line and this file resolve from the session root only; a session started one directory too high loads none of them.

## Settings (`.claude/settings.json`)

- `statusLine` runs `.claude/statusline.py`. It shows after a restart, once the workspace is trusted.
- `enabledPlugins` turns on `brain-core` and `brain-ai-factory` from the `brain-os` marketplace (`/sync-core`, `/conformance`, `/defect-review`, `/second-review`; `.brain-manifest.md`).
- Project skill: `/groom-backlog` (`.claude/skills/`), at each CRM release.
- No project hooks. The gates run in `.githooks/pre-commit`; each clone switches it on once with `git config core.hooksPath .githooks`.

## Review

A change to the access boundary (`crm/src/server/auth.js`, `mcp.js`, `commands.js`) or a migration gets `/second-review` before it merges.

## The CRM as an MCP server

`claude mcp add --transport http bookete-crm https://crm.bookete.com/mcp` connects this or any session to the live CRM. The first call opens a Google sign-in and a consent page; the agent then acts as you and can draft email, never send it.
