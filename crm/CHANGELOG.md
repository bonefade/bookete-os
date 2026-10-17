# Changelog: bookete CRM

Each production deploy bumps `version` in `crm/package.json` and adds an entry here, newest first. Written for the people using the CRM.

## 1.6.0 (2026-10-17)

### Added
- **Kundenakte:** on a Qualifiziert or Kunde business (and on any business that already has one). `#/betrieb/<id>/kunde` opens the Kundenakte form. It holds:
  - **Leistungen:** what we deliver (bookete, Website, bookete-Integration, Google-Profil, Weiteres), with state, dates and price.
  - **Systeme:** the domain (who owns it, where it is registered), DNS, hosting, e-mail, website and POS, each with the contact who runs it, plus who manages the Google profile and where the logins are kept. No passwords.
  - **Kontakte:** the people to reach, agencies included, with what they look after; tap to call or write.
- Agents can fill it in through MCP (`update_account`). Changes show in the business's Änderungen and go into the backup.
- A form or agent saving over a Kundenakte someone changed since it was read is refused, so nothing is overwritten by mistake. An agent that leaves out a contact who still runs a system must say who runs it now, so "betreut von" is never emptied by mistake.

### Changed
- A save finishes once this browser has it: the next screen, and a form opened again at once, show what was just saved.

## 1.5.0 (2026-10-17)

### Added
- **Every screen has its own address:** a business (`#/betrieb/…`), its edit form, a template and each tab. The browser's Back button goes back one screen, a reload stays where you are, and a link opens that business. After signing in again you land on the screen you were on.
- An address of a business or template that no longer exists goes to the tab. Zurück, Abbrechen, saving and deleting go one screen up, also on a double click; from a template that is Vorlagen, also when it was opened from a link. Back then does not show the same screen twice.

### Security
- The sign-in redirect refuses a path that resolves to another site (`/.//…`) on its own, not only through the second check after Google.

## 1.4.1 (2026-10-17)

### Changed
- Every stored business is rewritten once to the five statuses (migration 0003), with an entry in its Änderungen. Most look as they did in 1.4.0. But until a business was first changed, 1.4.0 dated its first contact without its logged contacts; now the earliest logged contact, in or out, is the first contact:
  - A business shown as Neu that has a logged contact becomes Kontaktiert.
  - "Kontaktiert seit" shows the day of the earliest logged contact instead of the day the business was created.
  - A disqualified business with a logged contact shows "Kontaktiert seit" that day instead of "Nie kontaktiert".
  - A business from an old import whose dates the CRM can't read, with no logged contact, gets the day of the migration as its first contact (or opt-out date), as its first change in 1.4.0 would.

### Deploying
- Only once 1.4.0 is live (Mehr shows 1.4.0): while 1.3 still runs, it can write an old status onto a rewritten business. Soon after 1.4.0: until 0003 has run, lists show some contacted businesses as Neu.
- Before: a Time Travel bookmark (`wrangler d1 time-travel info crm`), and the count of old rows by status (`SELECT json_extract(data, '$.status'), COUNT(*) FROM docs WHERE collection = 'leads' AND COALESCE(json_extract(data, '$.schemaVersion'), 0) < 3 GROUP BY 1`).
- After: the same count is empty. If 0003 fails with `stale_write`, a business breaks a 1.4.0 rule; find it with the self-check at the end of 0003. It rolled back whole on local D1; on production, check the count, restore the bookmark if rows changed, then fix and deploy again.

## 1.4.0 (2026-10-17)

### Changed
- **Five statuses:** Neu, Kontaktiert, Qualifiziert, Kunde, Disqualifiziert. Recherchiert is now Neu, Antwort is Kontaktiert, Gespräch/Demo is Qualifiziert, Onboarding is Kunde.
- **Disqualifiziert needs a reason**, picked from seven: Zufrieden mit aktueller Lösung, Kein Bedarf, Zu klein, Nicht unsere Zielgruppe, Geschlossen / existiert nicht, Nicht erreicht, Keine Kontaktaufnahme gewünscht. "Sonstiges", "Hat schon ein Tool", "Keine Antwort" and "Später nochmal" are gone. A "Kein Interesse" without one of the new reasons shows as Neu or Kontaktiert again, so it can be worked or closed with a real reason.
- **Contacted is visible:** each business shows "Kontaktiert seit …" or "Nie kontaktiert", and the list filters by it. Any contact either way dates it, an opt-out message too.
- **One filter row:** Region, System and Kontakt (mit Telefon / mit E-Mail) as compact selects; Betriebe filters by status, reason and contacted.
- Picking "Keine Kontaktaufnahme gewünscht" as a reason records an opt-out at once: no more outgoing contact. Unlike the Opt-out button it asks nothing, logs no "Opt-out" contact and keeps the next step.
- The sequence offers "Nicht erreicht" after five unanswered contacts, not three.
- A disqualified business has no follow-up; a new contact reopens it as Kontaktiert. Its follow-up is then set as on any Kontaktiert business: after an outgoing contact by the sequence (3, then 7 days; 4 once they have replied), after a reply the day of the reply.
- A first contact made outside the CRM is entered through an agent (MCP `update_lead`, `contactedAt`, not after today); it moves a Neu business to Kontaktiert.
- A contact can no longer be logged with a date after today: it has not happened yet. Plan it as the follow-up instead.

- Until 1.4.1 has run, the first change to an old business also stores its new status and reason, and Änderungen shows them under the person who made that change.

### Deploying
- No rollback to 1.3 once 1.4.0 has written: 1.3 does not know the five statuses. A lead 1.3 writes after that reads with the five again in 1.4.

## 1.3.0 (2026-10-16)

### Added
- **Version** under Mehr → Konto: the version running on crm.bookete.com, so you can check what is live.

## 1.2.0 (2026-10-16)

### Added
- **Änderungen:** at the bottom of each business, who changed what and when, with the old and the new value. Logged contacts stay in the contact history and are not repeated there.
- **Papierkorb** under Mehr: a deleted business can be restored with its contacts, or erased for good with all its contacts and changes when it asks to be deleted. It lists the newest 50.
- **Überall abmelden** under Mehr: signs you out on every device and disconnects every agent. In this browser, an agent then has to be allowed again.

### Changed
- **Saving no longer overwrites the other person's edits.** The form sends only the fields you changed. If someone changed the business at the same moment, the CRM redoes your step on the fresh data, or tells you to try again.
- An action on a business deleted in the meantime now fails with "Betrieb nicht gefunden" instead of seeming to work.
- Deleting a business moves it to the Papierkorb instead of erasing it.
- Importing a backup says what it does: only entries the CRM never had are added.

### Security
- Content-Security-Policy and related headers on every page; sign-in and agent registration are rate limited.

## 1.1.0 (2026-10-16)

### Added
- **Todos tab:** due leads in their own tab, overdue first, then today. Each row shows what to do, for which business, and since when. The red badge moved there.
- **bookete logo** in the header, as browser icon and as home-screen icon.

### Changed
- **Heute** keeps the next 7 days and the businesses ready for first contact; due leads moved to Todos.

## 1.0.0 (2026-10-16)

### Added
- The CRM at crm.bookete.com: Google sign-in for the team, leads with statuses and follow-ups, templates, Gmail sending and drafts, and a remote MCP server for agents.
