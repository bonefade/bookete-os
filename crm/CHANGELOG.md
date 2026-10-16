# Changelog: bookete CRM

Each production deploy bumps `version` in `crm/package.json` and adds an entry here, newest first. Written for the people using the CRM.

## 1.2.0 (2026-10-16)

### Added
- **Änderungen:** at the bottom of each business, who changed what and when, with the old and the new value. Logged contacts stay in the contact history and are not repeated there.
- **Papierkorb** under Mehr: a deleted business can be restored with its contacts, or erased for good with all its contacts and changes when it asks to be deleted. It lists the newest 50.

### Changed
- **Saving no longer overwrites the other person's edits.** The form sends only the fields you changed. If someone changed the business at the same moment, the CRM redoes your step on the fresh data, or tells you to try again.
- An action on a business deleted in the meantime now fails with "Betrieb nicht gefunden" instead of seeming to work.
- Deleting a business moves it to the Papierkorb instead of erasing it.
- Importing a backup says what it does: only entries the CRM never had are added.

## 1.1.0 (2026-10-16)

### Added
- **Todos tab:** due leads in their own tab, overdue first, then today. Each row shows what to do, for which business, and since when. The red badge moved there.
- **bookete logo** in the header, as browser icon and as home-screen icon.

### Changed
- **Heute** keeps the next 7 days and the businesses ready for first contact; due leads moved to Todos.

## 1.0.0 (2026-10-16)

### Added
- The CRM at crm.bookete.com: Google sign-in for the team, leads with statuses and follow-ups, templates, Gmail sending and drafts, and a remote MCP server for agents.
