# Changelog: bookete CRM

Each production deploy bumps `version` in `crm/package.json` and adds an entry here, newest first. Written for the people using the CRM.

## 1.9.2 (2026-10-17)

### Changed
- Leads are read as stored. Since 1.4.0 the server translated a lead still on the old statuses each time it read it; migration 0003 (1.4.1) has rewritten them all, so that step is gone. An old backup is still upgraded on import, with its activities.

## 1.9.1 (2026-10-17)

### Changed
- Built and tested on Node 26. Nothing changes in the app.

## 1.9.0 (2026-10-17)

### Added
- **Abmeldelink:** every mail from the CRM to a business that is not Kunde, sent with "Per Gmail senden" or drafted by an agent, ends with "Sie möchten keine E-Mails mehr von uns? Abmelden: …", a link only for that business. Sent mail also carries the one-click headers (RFC 8058), so a mail program such as Gmail may show its own "Abmelden" button.
- The link opens a page with one button. Pressing it (or the mail program's button) records the opt-out, the same as the Opt-out button: Disqualifiziert · Keine Kontaktaufnahme gewünscht, and a Verlauf entry "Opt-out über den Abmeldelink". Opening the link alone changes nothing, so a mail scanner cannot opt anyone out. A lead in the Papierkorb is opted out there too, so restoring it does not make it mailable again.
- Mail to a Kunde carries no Abmeldelink: it is service mail, and one click would otherwise block every mail and call to the customer. A link from a mail sent before they became Kunde still works.
- **An opt-out keeps a Kunde Kunde**, by the Opt-out button, the Abmeldelink or a call: the win date and the next step stay, only the follow-up date goes.

### Not added
- Open and click tracking. A tracking pixel or rewritten links read the recipient's device without consent (§165 (3) TKG 2021, Art. 5 (3) ePrivacy, GDPR); this is the owner's decision.

## 1.8.0 (2026-10-17)

### Added
- **Gesprächsleitfaden** on the Anruf card, folded: an opener, two questions (how they take reservations today, how many a week) and answers to the usual objections, with the business's name filled in. "Als Vorlage anlegen" saves it as a template of the new kind "Gesprächsleitfaden", to adapt under Vorlagen; the oldest such template is then shown instead. The compose form does not offer it as a message template, MCP `list_templates` names it a call script and `render_template` refuses to fill it.
- **Diese Woche** on Heute, Monday to today: calls, calls we got through, appointments made, new customers, and the most common reasons for Kein Interesse.
- A business now remembers the day it became Kunde. Customers from before 1.8.0 have no such day and are not counted; a Kunde set back to another status loses it.

## 1.7.0 (2026-10-17)

### Added
- **Anruf on each open business:** dial from its card (it takes the place of Anrufen in the row below), then one tap for how the call ended:
  - **Nicht erreicht:** call again in two days. The fifth attempt without ever getting through closes the business as Disqualifiziert · Nicht erreicht. A missed call keeps a date the follow-up sequence did not set: a callback, an appointment, or a date with a next step.
  - **Rückruf:** they asked to be called back; a date (from today) is needed, a time is optional.
  - **Termin vereinbart:** Qualifiziert, with the appointment's date and an optional time as the next step.
  - **Kein Interesse:** Disqualifiziert, with the reason why.
  The call goes into the Verlauf with its outcome and an optional note. A call in which we spoke to them counts as an answer, so the business leaves the follow-up sequence. A call never moves a customer out of Kunde, and a missed one keeps their next step; "Keine Kontaktaufnahme gewünscht" still records their opt-out.
- **Wie war der Termin?** On the appointment's day the business asks how it went: Kunde, Kein Abschluss (with the reason), or a new appointment.
- **Anrufliste in Todos:** open businesses with a phone number, due calls first, then new ones by fit. "Anrufen starten" opens the first; "Nächster" on each business opens the next, also once a call has closed it or set an appointment for today. Zurück ends the round.
- Agents log calls through MCP (`log_call`) with the same outcomes and rules.
- A second tap on a button while its save is on its way no longer saves twice.

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
