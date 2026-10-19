# Changelog: bookete CRM

Each production deploy bumps `version` in `crm/package.json` and adds an entry here, newest first. Written for the people using the CRM.

## 1.25.0 (2026-10-19)

- **Notes are entries:** each note is a card in the timeline, with who wrote it and when, among the calls and mails, newest first. Write one in the box on top of the timeline. "Bearbeiten" changes it, "Löschen" deletes it after asking. The "Notizen" chip shows only the notes. The notes text from before shows split: every paragraph that starts with a day ("19.10.2026: …") is a note of that day, and the others together one note "Bisherige Notizen". Nothing is cut or lost; the text itself stays as it was until you change one of its notes. Notes an agent writes are added as a new note too, never replacing the others.
- **"Eintragen" is a menu** that says what each entry records: "Antwort von ihnen" (by mail, phone or message), "Besuch vor Ort", "Anruf" (today or an earlier day) and "Termin" (agreed by mail, phone or in person). Each opens its own form. On a phone the menu opens right above the buttons, and the form comes into view with its title; on a laptop the page stays where it is. The composer no longer has the mode chips: it either writes to them or enters their answer, and says which.
- **A call on an earlier day:** the call sheet has a day, today unless you pick one. Agents can give it too. A missed call or a no entered for a day before a later contact leaves that contact's plan as it is; a Rückruf or Termin agreed in it is planned all the same.
- **A visit** shows in the timeline as "Besuch vor Ort", not as "Gesendet".
- **Any reservation system:** type it under "Reservierungssystem", with suggestions. The usual ones come first, then every system a lead already has. A new one, such as Respilot, is saved as typed and from then on is suggested and shows in the System filter. A name already known is saved as it is spelled there, whatever the case, also when an agent writes it. Agents can name any system too; before, a name not on the list became "unbekannt".

## 1.24.0 (2026-10-19)

- **Kontaktiert means you spoke with them:** a visit, a call that got through, or an answer from them. A mail, a DM or a call nobody picked up is an attempt: it shows in the feed, but the lead stays Neu and gets no date, so it doesn't fill Heute. The lead page says when it was last tried ("Nie gesprochen, angeschrieben am …"). The composer says so too before you send to a new lead.
- **New leads already tried** are no longer under "Bereit zum Anschreiben". The call list has them; after a call that didn't get through, a new lead comes back two days later, and after five days of calls without getting through it is closed as "Nicht erreicht". Mails don't count towards that.
- **A new lead has no date.** Its next step is text only, and a date set on it earlier goes away with its next change. For something with a date, add a todo.
- **Back to Neu:** a Kontaktiert lead, or one closed as "Nicht erreicht", that nobody has spoken with can be set back to Neu, which clears its first-contact date, follow-up and next step; the app asks first. Once someone has spoken with them, or a conversation outside the CRM was entered, it can't.
- **The "Nachfass-Folge" card** shows only while the sequence runs, on a lead set Kontaktiert by hand that nobody has spoken with yet.
- **"Kontaktiert" on a new lead** now asks where you spoke: Vor Ort, Am Telefon (the call sheet) or "Sie haben geantwortet" (enter their answer).
- **A closed lead** you write to stays closed; their answer reopens it.
- **After a visit** the composer offers the "Auf Antwort" template, as after a call that got through.
- **"Betriebe" is now "Leads"** in the tab and in Heute.

## 1.23.0 (2026-10-19)

- **Nothing you type is lost.** A note, a message, a call note, a todo or a quick edit in Notizen or Infos stays with its business until you save or cancel it: through a sync, switching apps, "Zurück", another business or tab, and a reload. Open the business again and it is there. It is kept on this device only; signing out clears it. If someone changed a field while your edit of it waited, the page says so before you save. Bearbeiten, Kundenakte and Vorlage, the full forms, are not kept yet.
- **"Kontaktiert" on a new lead asks how:** Vor Ort, Telefon, E-Mail, WhatsApp, Instagram or LinkedIn. A visit or a message is logged right there, with a note if you like, and the follow-up is planned as for any first contact. Telefon opens the call sheet and E-Mail the composer, which log it their own way. From any other status, "Kontaktiert" stays one tap.

## 1.22.0 (2026-10-19)

- **Todos on every business,** lead or customer: as many as you need, each with a text and, if you like, the day it is due. Tap one to change its text or its day, tick it when done, tap × to remove it; the done ones fold away under "n erledigt". A todo due shows the business in Heute (under Überfällig or Heute fällig, marked "Todo"), as its next step does, and counts in "Nächste 7 Tage". "Später" in a Heute round moves whatever puts the business on today's list, its todos due and its next step if due, so it leaves the list; in a round of calls or first contacts it moves the next step, as before. An answer to write, an appointment's outcome and a customer's Achtung still show before a todo. At most 50 open; the newest 100 done are kept. Todos belong to nobody; either of you does them. The one next step stays as it is, for the follow-ups, the onboarding and the check-ins.
- **The status is one tap:** the five statuses are chips in the header, always visible, without the menu and without asking first. Disqualifiziert asks why (on a business closed already, for a new reason). "Termin eintragen", "Ohne Antwort abschließen" and "Keine Kontaktaufnahme gewünscht" are under "Weitere". After an opt-out only Kunde and Disqualifiziert with the opt-out reason can be set, as before.
- **A customer's phase** (Onboarding, Live, Gekündigt) can be set in the header too, beside the status, as on the customer card.
- **"Account übergeben"** is a new onboarding step, right before "Live" and due 12 days after the deal: tick it once the customer has accepted the handover from the bookete app and confirmed the AGB. Customers in onboarding get it as an open step.

## 1.21.1 (2026-10-19)

- **Onboarding steps in any order:** every open step now has "Erledigt" and "Entfällt …", not only the first. A customer who booked the Abo but has not signed the website contract yet gets "Abo abgeschlossen" ticked while "Vertrag unterschrieben" stays open, and remains its next step. Any step but "Live" can be left out, with a word why.

## 1.21.0 (2026-10-19)

- **Check-ins:** a customer who goes live gets a check-in 14 days later, a second 90 days after going live, then one every 90 days. Each is the customer's next step on its day, so it shows in Heute. On the customer's page, "Check-in eintragen" asks how it went (Gut, Offene Fragen, Unzufrieden), with a note and, if you like, the day of the next one; "Unzufrieden" asks for that day. A mail or message of ours leaves the check-in planned, as the onboarding step is in onboarding. A live customer from before, or one stored as Live by 1.20.0, gets its first check-in 14 days after you first change something on it, as its next step. A customer live again after a cancellation starts that day: its first check-in 14 days on, an unhappy check-in from before past.
- **Achtung:** a customer whose onboarding step is 3 days late, whose check-in is a week late, or whose last check-in was "Unzufrieden" shows "Achtung" with the reason, on its page, first in the Kunden tab (also as a filter), and in Heute in its own section "Kunden: Achtung", right after new answers.
- **Heute, Meine or Alle:** Heute shows your own customers and all leads; "Alle" adds the customers the other looks after. A customer's row in Heute says Onboarding, Check-in or why it needs attention.

## 1.20.0 (2026-10-19)

- **Kunden, a tab of their own:** every customer with its phase (Onboarding with how far it is, Live, Gekündigt), its next step and who looks after it. Filter by phase and by "Betreut von"; the next step due comes first.
- **A customer's page shows its care** where a lead's shows the sales work: who looks after it ("Betreut von"), the phase, and the onboarding as a checklist of seven steps, from "Vertrag unterschrieben" to "Live", each due a set number of days after the deal. Tick a step with "Erledigt", or "Entfällt" with a word why; a step ticked by mistake opens again. "Live" ends the onboarding. "Gekündigt" asks for a reason. On a phone the onboarding comes first.
- **The next step follows the onboarding:** a lead that becomes Kunde gets "Vertrag unterschrieben" for that day as its next step, owned by whoever won it, and each step done moves it to the next one on its day, so a step due shows in Heute. A next step typed with the change to Kunde stays. While in onboarding, a mail from them still asks for "Antworten" today; once you have answered, the open step is the next step again, on its day, so an overdue step stays overdue. A Termin, a Rückruf or a next step you typed stays through any contact. Once Live, ticking a step leaves the next step as you planned it. "Live" itself cannot be left out.
- **Kunde by mistake:** set back before any step is ticked, the care goes, with the step it planned, so the business shows "Kein nächster Schritt" until you plan one; a real win later starts the onboarding that day.
- **Gekündigt** customers stay out of Heute: a mail or message to them plans no follow-up.
- **Customers from before** are Live where the Kundenakte has a service live, else in Onboarding with no step ticked, for you to tick once. Their steps get their days from the day you first change something on them, so nobody is months overdue at once. Nobody looks after them until you pick someone, and only someone of the team can be picked.
- **Änderungen** shows "Betreuung geändert" for a change to the owner, phase or steps.

## 1.19.0 (2026-10-19)

- **The lead page on a laptop, new:** the name heads the page with the buttons beside it (E-Mail first), the next step below. Then three columns: on the left "Für das Gespräch" (how they reserve now, the hook, the fit) and the Nachfass-Folge; in the middle the feed; on the right Kontakt and Infos, and the Kundenakte where there is one.
- **The Nachfass-Folge is a checklist:** each day we made contact, with what we did; the answer that stopped it, with "Antworten", "Termin eintragen" and the day it would have gone on without the answer; then the contacts still to come.
- **"Nachrichten" filter** in the feed, for Instagram and WhatsApp messages.
- On a phone the page stays as it was; "Für das Gespräch" is in the Infos fold.

## 1.18.2 (2026-10-19)

- **Termin eintragen** (the status menu, or a mail thread) opens its own small form now: date, time, Speichern. Before, it opened the call form and saved the appointment as a phone call, so a Termin agreed by mail counted as a call and as "erreicht" in Diese Woche. Calls logged that way before stay as they are. A Termin agreed on the phone still goes through "Anrufen". "Termine" in Diese Woche counts only Termine agreed on a call, so one entered this way is not in it.

## 1.18.1 (2026-10-19)

- **Betriebe:** the list filter takes a space again, so you can filter for a name of two words ("Gasthaus Krone"). Before, a space typed at the end vanished at once.

## 1.18.0 (2026-10-18)

- **Your Gmail signature** now goes with every mail sent with "Per Gmail senden", as Gmail shows it, logo and links included, and with every draft an agent makes. The composer shows it below the text; untick "Mit Signatur" to leave it out of one mail. If a template ends with your name or a greeting the signature repeats, take that line out of the template. It needs Gmail connected again once (Mehr → Gmail neu verbinden), as for answers in 1.17.0.

## 1.17.0 (2026-10-18)

### New
- **Your mail on the lead, both ways.** Every 5 minutes the CRM reads both Gmail mailboxes and puts each mail to or from a business on its page: replies, and mail you wrote in Gmail itself. It finds them by the thread the CRM sent, or by the business's stored address, never by domain. A mail in both mailboxes shows once; out-of-office replies, bounces and mail among ourselves stay out. Mail already on a business (every mail sent before this update, an answer you entered) is not added again, a mail found late leaves a follow-up, next step or status you set after it came, so it never reopens a business you closed since; only an answer of ours found late still ends "Antworten" and dates a follow-up that is due or missing. Each mail shows whose mailbox it came from. Once after this update, each of you signs in again so the CRM may read your mail.
- **A reply stops the follow-up sequence** and puts "Antworten" for today on the business. "Antworten" on a thread writes into that same Gmail thread.
- **The lead page, new:** one status button with a menu instead of five chips; one next-step line, marked "Kein nächster Schritt" when a business in work has none; one feed of mail threads, calls, messages and status changes with filters; on a phone a row Anrufen, E-Mail, WhatsApp, Instagram, Eintragen above the tabs.
- **One composer for every channel.** E-Mail goes by Gmail. Instagram and WhatsApp copy the text and open the app; then "Gesendet". It shows what comes next ("Danach: Nachfassen …"), and you can change it.
- **Heute is one queue:** new answers first, then overdue, due today, and the call list with the best time to call. "Abarbeiten" goes through it with "Später" and "Weiter". Todos is gone; its lists are in Heute.
- **Notiz** in the composer adds to Notizen as they are when you save, so a note written meanwhile stays.
- **A call tapped by mistake can be taken back** ("Rückgängig"), while it is the newest entry and nothing changed since.
- Agents can enter how a Termin went.

### Fixed
- A business whose address is closed by an opt-out no longer counts as "mit E-Mail": not in the count, the Kontakt filter or the order of new businesses, nor for agents.

## 1.16.5 (2026-10-18)

### Fixed
- **Why no mail goes out:** the note in the message sheet shows the opt-out date as 15.10.2026, not 2026-10-15. The server's refusal reads the same.
- When a business's own opt-out arrives while its message sheet is open, the note says "Keine E-Mail: Opt-out seit …". Before, it named the business itself as another one with "dieselbe Adresse".

## 1.16.4 (2026-10-18)

### Fixed
- **Papierkorb:** with exactly 50 deleted businesses (or exactly 50 more on an older page), "Ältere anzeigen" no longer shows and leads to an empty page.

## 1.16.3 (2026-10-18)

### Fixed
- **Search on a phone:** the results now end above the tabs at the bottom. Before, the last results and one picked with the arrow keys could sit hidden under the tabs.
- On the narrowest phones (320px), the top bar leaves out "CRM" so the search field shows its whole "Suchen …".

## 1.16.2 (2026-10-18)

### Fixed
- A business's page opened by a link or a reload now marks Betriebe as its tab, and that tab leads to the Betriebe list. Before, it marked Heute. A page opened from a tab still keeps that tab.

## 1.16.1 (2026-10-18)

### Fixed
- **+ Neu and the ICP form keep what you typed.** Before, a change from the other user arriving by sync, or a new sort or filter on Betriebe, drew the form again empty.
- While a form holds input, the browser's Forward no longer opens the search over it, and / and Ctrl+K do what they do elsewhere instead of nothing.

## 1.16.0 (2026-10-18)

### Changed
- **Tabs on every screen:** Heute, Todos, Betriebe, Vorlagen and Mehr now stay in reach on a business's page and in every form too. From tablet width they sit on the left side, under the top bar; on a phone, upright or on its side, they stay at the bottom. On a business's page, the tab it was opened from leads back to that tab's screen.
- While a form holds input (an edit form, a template, "+ Neu", the ICP form, a message or a call outcome being entered), the tabs are greyed out like the search field, so nothing typed is lost by a tab.

## 1.15.0 (2026-10-18)

### Changed
- **Search over the screen:** clicking into the search field no longer leaves the screen you are on. The results open over it; the screen stays as it was underneath, scrolled where you left it. The browser's or phone's Back closes the search, as do "Schließen", a click on the dimmed area, Escape (once the field is empty) or a tab in the bottom bar. Opening a result closes it too, and Back from that business returns to the screen you searched from. While the search is open, Tab moves only through it and the tabs. Old links to the search open Heute.

## 1.14.0 (2026-10-18)

### Added
- **Papierkorb:** "Ältere anzeigen" shows the next 50 deleted businesses, "Zu den neuesten" goes back. Before, only the newest 50 showed. Restoring or erasing one keeps you on the page.

## 1.13.2 (2026-10-18)

### Fixed
- A business with many contacts (about 45 or more) can now be deleted and restored. Before, the database's limit of 50 queries per request stopped it.

## 1.13.1 (2026-10-18)

### Fixed
- **Sicherung einspielen:** a contact entry from a backup whose business is in the Papierkorb now goes into the Papierkorb with it and comes back when the business is restored. One whose business was erased with Endgültig löschen is no longer added, so nothing of an erased business comes back. An import that lands while someone erases that business stops with "Bitte nochmal versuchen"; running it again is safe.

## 1.13.0 (2026-10-18)

### Changed
- **Search in the top bar:** the search field now sits next to the logo, on every screen, and stays in view while the page scrolls. Clicking into it first shows the recently changed businesses; typing searches all businesses as before. The Suche tab is gone; the bottom bar keeps five: Heute, Todos, Betriebe, Vorlagen, Mehr. Old links to the search, Back and Forward still work; `/` and Ctrl K still jump into the field. The field above the Betriebe list, which filters only that list, now says "Liste filtern …".
- While an edit form, the "+ Neu" form on Betriebe or the ICP form on Mehr is open, or a business's page has a message, a call or appointment outcome or a quick edit open, the search field is locked, so nothing typed there is lost. The ICP form now closes when Mehr is left, as the "+ Neu" form already did.

## 1.12.0 (2026-10-18)

### Changed
- When several people or agents change the same business at once, a write that collided now waits a short random moment (up to 0.1 s, then 0.2 s) before it reads and saves again. More changes go through the first time, and "Bitte nochmal versuchen" comes up less often. A change is still saved whole or not at all.

## 1.11.2 (2026-10-18)

### Changed
- Search names the fields as the rest of the app does: "Ansprechperson" instead of "Person", "Notizen" instead of "Notiz".

## 1.11.1 (2026-10-18)

### Changed
- **Only by Gmail once it is connected:** with Gmail connected, an e-mail that gets the Abmeldelink goes out only by "Per Gmail senden". "Nachricht schreiben" no longer offers "Kopieren & E-Mail öffnen", and the E-Mail button below it opens no mail program: both sent the mail without the Abmeldelink. Nor does a contact in the Kundenakte with the business's own address. A contact at another address, such as an agency, keeps its link: "Per Gmail senden" mails only the business. A Kunde's service mail has no Abmeldelink and keeps both. Without Gmail, both stay, and the other channels keep their link.

## 1.11.0 (2026-10-18)

### Added
- **An opt-out also closes the e-mail address:** no mail goes to an address that a business with an opt-out holds, also one in the Papierkorb, neither with "Per Gmail senden" nor as an agent's draft. Case and spaces do not count. So the same business added again (a new scrape, a duplicate) is not mailed again. A Kunde is exempt: its service mail still goes out; only its own opt-out stops it. "Nachricht schreiben" says, for E-Mail, which business closed the address, and neither "Kopieren & E-Mail öffnen", the E-Mail button nor a contact in the Kundenakte with that address opens a mail to it, also on the business with the opt-out. A business in the Papierkorb is not known to the lead page: it still offers the mail links, and "Per Gmail senden" is then refused with a message naming it. An outgoing E-Mail to the address can't be logged by hand either ("Als gesendet eintragen", an agent's log_activity): for E-Mail, "Nachricht schreiben" then offers only "Text kopieren" and "Abbrechen". Calls, other channels and incoming replies can still be logged. Changing or clearing the e-mail address of the business with the opt-out, or Endgültig löschen on it, opens the address again.

## 1.10.1 (2026-10-17)

### Changed
- **An opt-out is the same everywhere:** "Keine Kontaktaufnahme gewünscht" as the reason, whether picked as the Grund, in the edit form, for a new business, as a call's Kein Interesse, as an appointment's Kein Abschluss or by an agent, now works like the Opt-out button: Disqualifiziert, no next step, and a Verlauf entry "Opt-out: möchte keine Nachrichten mehr." (for a call it is in the call itself). The entry counts as the first contact.
- Picking "Keine Kontaktaufnahme gewünscht" as the Grund asks first, as the Opt-out button does.
- A second opt-out on a business that already has one changes nothing (before: a new date and a second Verlauf entry).

## 1.10.0 (2026-10-17)

### Changed
- **Agents search in pages:** MCP `search_leads` answers at most 50 businesses at a time (30 unless asked for more) and says where the next page starts (`offset`, `nextOffset`), so a long list no longer arrives as one 50 KB answer. With no search words it lists them by name.
- Each business in the answer is a short summary to choose by: name, Ort, status, fit, follow-up date, whether it is due, the next step, whether it has an e-mail address or phone number, and whether it opted out. Region, first contact date and the e-mail address itself are no longer in it; `get_lead` still gives everything, with the Verlauf.

## 1.9.3 (2026-10-17)

### Changed
- The search behind the Suche screen and the agents' `search_leads` now sits with the business rules, not in the web app. What is found, and in what order, does not change.

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
