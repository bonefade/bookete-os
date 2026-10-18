import { STAGES, STAGE_LABEL, LOST_REASONS, SPOKEN_REASONS, BUSINESS_TYPES, RESERVATION_TOOLS, CHANNELS, TEMPLATE_PURPOSES, PURPOSE_LABEL, SEQUENCE_POLICY, CALL_OUTCOMES, OUTCOME_LABEL, TRASH_SHOWN, FIELD_LABEL } from '../domain/constants.js';
import { actsOf, currentLead, icpOf, isReady, mailOpen, scoped, regionCounts, toolCounts, contactCounts, callList, freshLeads, awaitsAnswer, todayQueue, queueList, roundList } from './selectors.js';
import { addDays, dayLabel, daysBetween, toDateString } from '../domain/dates.js';
import { channelLink } from './platform.js';
import { countTouches, hasReply, isReply, sequenceExhausted, nextActionHint, meetingDue, lastChannel, planAfterActivity, planAfterCall, callActivity } from '../domain/activity.js';
import { esc, fmtDate, fmtDateWithYear, relDate, options, describeChange, statusMove, actorName, fmtTime } from './format.js';
import { fold, searchTokens, searchLeads } from '../domain/search.js';
import { hitLabel, markRanges, markHtml, snippetHtml } from './search.js';
import { isPipeline, takesFollowUp, isDue, lacksNextStep, getsUnsubscribeLink, addressKey, optOutByAddress, mailClosedBy, addressOptOutText } from '../domain/lead.js';
import { lostBreakdown, templateUsage, weekNumbers } from '../domain/stats.js';
import { callScript } from '../domain/template.js';
import { REGIONS, regionOf } from '../domain/region.js';
import { SERVICE_KINDS, SERVICE_STATES, OWNERS, SYSTEMS, accountOf, showsAccount, handledBy } from '../domain/account.js';

export const ICONS = {
  heute: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  betriebe: '<svg viewBox="0 0 24 24"><path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/></svg>',
  vorlagen: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
  mehr: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>'
};
export const TABS = [["heute", "Heute"], ["betriebe", "Betriebe"], ["vorlagen", "Vorlagen"], ["mehr", "Mehr"]];
/** The tabs, shut while `locked`: a form holds input a tab would drop. Heute counts what its queue holds. */
export function tabBar(state, today, locked) {
  const open = isReady(state) ? queueList(state, today).length : 0;
  return `<div class="in">${TABS.map(([k, v]) => `<button class="tab" data-tab="${k}" ${state.ui.tab === k ? 'aria-current="page"' : ""}${locked ? " disabled" : ""}>${ICONS[k]}<span>${v}</span>${k === "heute" && open ? `<span class="badge">${open}</span>` : ""}</button>`).join("")}</div>`;
}
export function leadRow(state, l, today) {
  const acts = actsOf(state, l.id);
  const hint = takesFollowUp(l) ? nextActionHint(l, acts) : l.lostReason || "";
  const due = isDue(l, today);
  const short = (d) => (new Date(d + "T12:00:00")).toLocaleDateString("de-AT", { weekday: "short", day: "numeric", month: "numeric" });
  const when = l.optOutAt ? "Opt-out" : l.followUp && takesFollowUp(l) ? due ? l.followUp === today ? "heute" : "f\xE4llig " + short(l.followUp).replace(/^\S+ /, "") : short(l.followUp) : "";
  return `<li><button class="lrow${due ? " due" : ""}${l.optOutAt ? " out" : ""}" data-open="${esc(l.id)}">
  <span class="c-name">${esc(l.name)}</span>
  <span class="c-fit" aria-label="Fit ${l.fit || 2}">${"★".repeat(l.fit || 2)}</span>
  <span class="c-loc">${esc(l.city || "")}</span>
  <span class="c-st st-${esc(l.status)}">${esc(STAGE_LABEL[l.status] || l.status)}</span>
  <span class="c-next">${esc(hint)}</span>
  <span class="c-sub">${esc([STAGE_LABEL[l.status], l.city, hint].filter(Boolean).join(" \xB7 "))}</span>
  <span class="c-mail" title="${l.email ? esc(l.email) : "keine E-Mail"}">${l.email ? "✉" : "–"}</span>
  <span class="c-when${due || l.optOutAt ? " warn" : ""}">${esc(when)}</span>
</button></li>`;
}
export const listHead = () => `<li class="lhead" aria-hidden="true"><span>Betrieb</span><span></span><span>${FIELD_LABEL.city}</span><span>${FIELD_LABEL.status}</span><span>${FIELD_LABEL.nextStep}</span><span>✉</span><span>Nachfassen</span></li>`;
export const rowsOf = (state, arr, today) => `<ul class="ltable">${listHead()}${arr.map((l) => leadRow(state, l, today)).join("")}</ul>`;
/** One filter as a select; `choices` are [value, label, count]. The controller writes the value to ui[key]. */
const filterSelect = (key, label, choices, value) => `<select data-filter="${key}" aria-label="${label}">${options(choices.map(([k, l, n]) => [k, `${l} (${n})`]), value)}</select>`;
/** The filters every list shares, in one row; `more` adds a view's own filters to it. */
export function filterBar(state, more = "") {
  const { ui } = state;
  const all = (ignore) => scoped(state, state.data.leads, ignore).length;
  return `<div class="fbar">
  ${filterSelect("region", FIELD_LABEL.region, [["alle", "Alle Regionen", all("region")], ...regionCounts(state).map(([r, n]) => [r, r, n])], ui.region)}
  ${filterSelect("tool", "System", [["alle", "Alle Systeme", all("tool")], ...toolCounts(state).map(([t, n]) => [t, t, n])], ui.tool)}
  ${filterSelect("contact", "Kontakt", [["alle", "Alle Kontakte", all("contact")], ...contactCounts(state)], ui.contact)}${more}
</div>`;
}
export const loadingOr = (state, html) => isReady(state) ? html : `<div class="empty">${esc(state.status.failed || "Lade Daten …")}</div>`;
/** The first line of a message, quoted, for a row that has room for one. */
const quoted = (text) => `„${(text || "").split("\n").find((x) => x.trim()) || ""}“`;
/** One row of the queue: who, by which way, why now, and what a tap does. A row opens the lead in a round from here. */
function queueRow(state, l, today) {
  const acts = actsOf(state, l.id);
  const last = acts.at(-1);
  const [chip, why, go] = awaitsAnswer(state, l) ? [last.channel, quoted(last.text), "Antworten"]
    : meetingDue(l, today) ? ["Termin", `Wie war der Termin? \xB7 ${fmtDate(l.followUp)}`, "Ergebnis"]
    : lacksNextStep(l) ? ["Kein n\xE4chster Schritt", `${STAGE_LABEL[l.status]}${last ? `, zuletzt ${relDate(last.date, today)}` : ""}, nichts geplant`, "Planen"]
    : [lastChannel(acts) || STAGE_LABEL[l.status], [nextActionHint(l, acts) || "Nachfassen", l.followUp < today ? "f\xE4llig " + relDate(l.followUp, today) : ""].filter(Boolean).join(" \xB7 "), "\xD6ffnen"];
  return `<li><button class="qrow" data-queue="${esc(l.id)}"><span class="q-name">${esc(l.name)}</span><span class="q-ch${go === "Planen" ? " none" : ""}">${esc(chip)}</span><span class="q-why">${esc(why)}</span><span class="q-go">${go} ›</span></button></li>`;
}
/** The best hours to reach a restaurant by phone, between lunch and dinner service. */
const CALL_HOURS = "Am besten 14:30–17:00 Uhr, Montag und Dienstag schw\xE4cher.";
/** Heute as one queue, worked from the top; on a wide screen the week, the next days and the new businesses beside it. */
export function todayView(state, today) {
  const q = todayQueue(state, today);
  const open = q.replies.length + q.overdue.length + q.today.length;
  const date = (new Date(today + "T12:00:00")).toLocaleDateString("de-AT", { weekday: "long", day: "numeric", month: "long" });
  const sec = (title, sub, arr) => arr.length ? `<div class="sec"><h3>${title} <small>${sub}</small></h3><ul class="ltable">${arr.map((l) => queueRow(state, l, today)).join("")}</ul></div>` : "";
  const calls = callList(state, today).length;
  const callSec = `<div class="sec"><h3>Anrufliste <small>${calls}</small></h3>${calls ? `<p class="note" style="margin:0 0 8px">${CALL_HOURS}</p><button class="primary full" data-act="callStart">Anrufen starten ›</button>` : `<div class="empty">Niemand mit Telefonnummer zum Anrufen.</div>`}</div>`;
  const leads = scoped(state);
  const w = weekNumbers(leads, leads.flatMap((l) => actsOf(state, l.id)), today);
  const week = `<div class="sec"><h3>Diese Woche <small>seit ${esc(fmtDate(w.from))}</small></h3>
  <div class="stats">${[[w.calls, "Anrufe"], [w.reached, "erreicht"], [w.meetings, "Termine"], [w.customers, "neue Kunden"]].map(([n, label]) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`).join("")}</div>
  ${w.reasons.length ? `<p class="note">H\xE4ufigste Gr\xFCnde f\xFCr Kein Interesse: ${w.reasons.map(([r, n]) => `${esc(r)} (${n})`).join(", ")}</p>` : ""}</div>`;
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)).map((d) => {
    const on = leads.filter((l) => takesFollowUp(l) && l.followUp === d);
    const meetings = on.filter((l) => /^Termin\b/.test(l.nextStep || "")).length;
    return on.length ? `<li>${esc(fmtDate(d))} \xB7 ${on.length} f\xE4llig${meetings ? `, ${meetings} Termin${meetings > 1 ? "e" : ""}` : ""}</li>` : "";
  }).join("");
  const fresh = freshLeads(state);
  const side = `${week}
  <div class="sec"><h3>N\xE4chste 7 Tage</h3>${days ? `<ul class="days card">${days}</ul>` : `<div class="empty">Nichts geplant.</div>`}</div>
  <div class="sec"><h3>Bereit zum Anschreiben <small>${fresh.length}</small></h3>${fresh.length ? `<p class="note" style="margin:0 0 8px">${fresh.length} ${fresh.length === 1 ? "neuer Betrieb" : "neue Betriebe"} ohne Kontakt, die besten zuerst.</p><button class="full" data-act="freshStart">Erstkontakte starten ›</button>` : `<div class="empty">Keine neuen Betriebe in dieser Auswahl.</div>`}</div>`;
  return `<div class="wrap wide">
  <div class="head"><div><h1>Heute</h1><p>${esc(date)}${state.ui.region !== "alle" ? " \xB7 " + esc(state.ui.region) : ""}${open ? ` \xB7 ${open} offen` : ""}</p></div>${open ? `<button class="primary" data-act="queueStart">Abarbeiten ›</button>` : ""}</div>
  ${filterBar(state)}
  ${loadingOr(state, `<div class="today"><div class="t-main">
  ${open ? `<p class="note" style="margin:0 0 4px">Der Reihe nach von oben. Was Sie erledigen, verschwindet von der Liste.</p>` : `<div class="empty">Alles erledigt.</div>`}
  ${sec("Neue Antworten", `${q.replies.length} \xB7 halten die Nachfass-Folge an`, q.replies)}
  ${sec("\xDCberf\xE4llig", q.overdue.length, q.overdue)}
  ${sec("Heute f\xE4llig", q.today.length, q.today)}
  ${callSec}
  </div><aside class="t-side">${side}</aside></div>`)}
</div>`;
}
/** The Betriebe status filter: [value, label, test]. Offen is the pipeline. */
export const STATUS_FILTERS = [["offen", "Offen", isPipeline], ...STAGES.map(([k, label]) => [k, label, (l) => l.status === k]), ["alle", "Alle", () => true]];
const CONTACTED = [["alle", "Kontaktiert: alle"], ["ja", "Kontaktiert: ja"], ["nein", "Kontaktiert: nein"]];
export const SORTS = {
  prio: (a, b) => b.fit - a.fit || ((a.followUp || "9") < (b.followUp || "9") ? -1 : 1) || a.name.localeCompare(b.name, "de"),
  nachfassen: (a, b) => ((a.followUp || "9") < (b.followUp || "9") ? -1 : (a.followUp || "9") > (b.followUp || "9") ? 1 : 0) || b.fit - a.fit,
  name: (a, b) => a.name.localeCompare(b.name, "de"),
  status: (a, b) => STAGES.findIndex(([k]) => k === b.status) - STAGES.findIndex(([k]) => k === a.status) || b.fit - a.fit
};
export function leadsView(state, today) {
  const { status, reason, contacted, q, quick, sort } = state.ui;
  const base = scoped(state);
  // Reason and contacted are offered, and filter, only with Disqualifiziert; there the status says neither.
  const disq = status === "disqualifiziert";
  const byReason = (l, r = reason) => r === "alle" || l.lostReason === r;
  const byContacted = (l, c = contacted) => c === "alle" || !!l.contactedAt === (c === "ja");
  const closed = base.filter((l) => l.status === "disqualifiziert");
  const own = filterSelect("status", FIELD_LABEL.status, STATUS_FILTERS.map(([k, label, pass]) => [k, label, base.filter(pass).length]), status) + (disq
    ? filterSelect("reason", FIELD_LABEL.lostReason, [["alle", "Alle Gr\xFCnde"], ...LOST_REASONS.map((r) => [r, r])].map(([k, label]) => [k, label, closed.filter((l) => byContacted(l) && byReason(l, k)).length]), reason)
      + filterSelect("contacted", "Kontaktiert", CONTACTED.map(([k, label]) => [k, label, closed.filter((l) => byReason(l) && byContacted(l, k)).length]), contacted)
    : "");
  let list = base.filter(STATUS_FILTERS.find(([k]) => k === status)[2]);
  if (disq) list = list.filter((l) => byReason(l) && byContacted(l));
  let hidden = 0;
  if (q) {
    const hits = new Set(searchLeads(state, q).map((r) => r.lead.id));
    list = list.filter((l) => hits.has(l.id));
    hidden = hits.size - list.length;
  }
  list.sort(SORTS[sort] || SORTS.prio);
  const quickForm = quick ? `<div class="card" style="margin-bottom:12px">
    <label>${FIELD_LABEL.name} *<input id="qaName" autocomplete="off" value="${esc(quick.name)}"></label>
    <div class="two"><label>${FIELD_LABEL.city}<input id="qaCity" value="${esc(quick.city)}"></label><label>${FIELD_LABEL.instagram}<input id="qaIg" placeholder="@handle" autocapitalize="off" value="${esc(quick.instagram)}"></label></div>
    <label>${FIELD_LABEL.hook}<input id="qaHook" placeholder="z. B. Neuer\xF6ffnung" value="${esc(quick.hook)}"></label>
    <div class="two"><button data-act="quickCancel">Abbrechen</button><button class="primary" data-act="quickSave">Hinzuf\xFCgen</button></div>
    <p class="note">Den Rest kann Claude recherchieren und erg\xE4nzen.</p></div>` : "";
  return `<div class="wrap wide">
  <div class="head"><h1>Betriebe</h1><button class="primary" data-act="quick"${state.caps.db ? "" : " disabled"}>+ Neu</button></div>
  ${quickForm}
  ${filterBar(state, own)}
  <div class="toolbar">
    <input type="search" id="q" placeholder="Liste filtern \u2026" value="${esc(q)}" aria-label="Liste filtern">
    <select id="sort" aria-label="Sortierung">${options([["prio", "\u2195 Fit"], ["nachfassen", "\u2195 Nachfassen"], ["status", "\u2195 Status"], ["name", "\u2195 Name"]], sort)}</select>
  </div>
  <p class="note count">${list.length} Betriebe${list.length ? ` \xB7 ${list.filter((l) => mailOpen(state, l)).length} mit E-Mail` : ""}${hidden ? ` \xB7 <button class="more" data-act="toSearch"${quick ? " disabled" : ""}>${hidden} weitere Treffer au\xDFerhalb der Filter</button>` : ""}</p>
  ${loadingOr(state, list.length ? rowsOf(state, list, today) : `<div class="empty">${state.data.leads.length ? "Nichts in dieser Ansicht." : "Noch keine Betriebe."}</div>`)}
</div>`;
}
export function searchRow(state, r, i, tokens, today) {
  const l = r.lead;
  const hl = (txt) => tokens.length ? markHtml(txt, markRanges(fold(txt), tokens)) : esc(txt);
  const acts = actsOf(state, l.id);
  const hint = takesFollowUp(l) ? nextActionHint(l, acts) : l.lostReason || "";
  const due = isDue(l, today);
  const when = l.optOutAt ? "Opt-out" : l.followUp && takesFollowUp(l) ? (due ? "f\xE4llig " : "nachfassen ") + relDate(l.followUp, today) : "";
  const meta = [l.city ? hl(l.city) : "", esc(regionOf(l)), esc(hint), when ? `<span class="${due || l.optOutAt ? "warn" : ""}">${esc(when)}</span>` : ""].filter(Boolean).join(" \xB7 ");
  return `<li><button class="srow${i === state.ui.sIdx && tokens.length ? " act" : ""}${due ? " due" : ""}${l.optOutAt ? " out" : ""}" data-open="${esc(l.id)}">
  <span class="s-top"><span class="s-name">${hl(l.name)}</span><span class="c-fit" aria-label="Fit ${l.fit || 2}">${"★".repeat(l.fit || 2)}</span><span class="s-st st-${esc(l.status)}">${esc(STAGE_LABEL[l.status] || l.status)}</span></span>
  <span class="s-meta">${meta}</span>
  ${r.hit ? `<span class="s-hit"><b>${esc(hitLabel(r.hit))}</b>${snippetHtml(r.hit, tokens)}</span>` : ""}
</button></li>`;
}
export const SEARCH_LIMIT = 60;
export function searchResultsHtml(state, today) {
  if (!isReady(state)) return `<div class="empty">${esc(state.status.failed || "Lade Daten …")}</div>`;
  const q = state.ui.gq.trim();
  if (!q) {
    const stamp = (l) => l.updatedAt || l.createdAt || "";
    const recent = [...state.data.leads].sort((a, b) => stamp(b).localeCompare(stamp(a))).slice(0, 8);
    return recent.length ? `<p class="note count">Zuletzt bearbeitet</p><ul class="ltable">${recent.map((l, i) => searchRow(state, { lead: l }, i, [], today)).join("")}</ul>` : `<div class="empty">Noch keine Betriebe.</div>`;
  }
  const tokens = searchTokens(q);
  const res = searchLeads(state, q);
  if (!res.length) return `<div class="empty">Nichts gefunden f\xFCr „${esc(q)}“.</div>`;
  const shown = res.slice(0, SEARCH_LIMIT);
  return `<p class="note count">${res.length} Treffer${res.length > SEARCH_LIMIT ? ` \xB7 die ersten ${SEARCH_LIMIT} – Suche verfeinern` : ""}</p>
  <ul class="ltable">${shown.map((r, i) => searchRow(state, r, i, tokens, today)).join("")}</ul>`;
}
/** The search over the current screen (#sbox in index.html): the results for the field in the top bar (#gq). */
export function searchView(state, today) {
  return `<button class="sback" data-act="searchClose" aria-label="Suche schlie\xDFen" tabindex="-1"></button>
<div class="spanel"><div class="wrap wide">
  <div class="shead"><p class="note">Alle Betriebe, unabh\xE4ngig von Region, System, Kontakt und Status. Findet auch Notizen und den gesamten Verlauf. Umlaute egal, mehrere W\xF6rter grenzen ein.<span class="skeys"> \xB7 <kbd>↑</kbd><kbd>↓</kbd> w\xE4hlen, <kbd>Enter</kbd> \xF6ffnet \xB7 von \xFCberall: <kbd>/</kbd> oder <kbd>Strg K</kbd></span></p><button class="link" data-act="searchClose">Schlie\xDFen</button></div>
  <div id="sres">${searchResultsHtml(state, today)}</div>
</div></div>`;
}
export function templatesView(state) {
  const idx = (p) => TEMPLATE_PURPOSES.findIndex(([k]) => k === p);
  const tpls = [...state.data.templates].sort((a, b) => idx(a.purpose) - idx(b.purpose));
  const usage = templateUsage(state.data.activities);
  return `<div class="wrap">
  <div class="head"><div><h1>Vorlagen</h1><p>Platzhalter: {Betrieb} {Ort} {Aufh\xE4nger} {Person}</p></div><button class="primary" data-act="tplNew"${state.caps.db ? "" : " disabled"}>+ Neu</button></div>
  ${loadingOr(state, tpls.length ? `<ul class="rows">${tpls.map((t) => `<li><button class="row" data-tpl="${esc(t.id)}"><span class="top"><span class="nm">${esc(t.name)}</span><span class="st">${esc(PURPOSE_LABEL[t.purpose] || "")}</span></span><span class="meta clamp" style="-webkit-line-clamp:2">${esc(t.body)}</span><span class="meta">${usage[t.id] || 0}\xD7 verwendet</span></button></li>`).join("")}</ul>` : `<div class="empty">Noch keine Vorlagen.</div>`)}
</div>`;
}
export function templateEditView(state) {
  const id = state.ui.templateId;
  if (id && !isReady(state)) return loadingOr(state, "");
  const t = state.data.templates.find((x) => x.id === id) || { name: "", purpose: "followup1", body: "" };
  return `<div class="bar"><button class="link" data-act="back">Abbrechen</button><h2>${id ? "Vorlage" : "Neue Vorlage"}</h2><button class="link" data-act="tplSave">Sichern</button></div>
<form class="wrap" id="tform">
  <label>Name<input name="name" value="${esc(t.name)}"></label>
  <label>Wof\xFCr<select name="purpose">${options(TEMPLATE_PURPOSES, t.purpose)}</select></label>
  <label>Text<textarea name="body" rows="12">${esc(t.body)}</textarea></label>
  <p class="hint">Platzhalter werden beim Schreiben ersetzt: {Betrieb}, {Ort}, {Aufh\xE4nger}, {Person}. Follow-ups sollten etwas Neues bringen, nicht die erste Nachricht wiederholen.</p>
  <button class="primary full" data-act="tplSave">Speichern</button>
  ${id ? `<button class="danger full" data-act="tplDelete" style="margin-top:24px">Vorlage l\xF6schen</button>` : ""}
</form>`;
}
export function moreView(state) {
  const icp = icpOf(state);
  const li = (a) => (a || []).map((x) => `<li>${esc(x)}</li>`).join("");
  const lost = lostBreakdown(state.data.leads);
  const { cadence, maxTouches } = SEQUENCE_POLICY;
  const icpBody = state.ui.icpEdit ? `<label>Passt (eine Zeile pro Kriterium)<textarea id="icpFit" rows="7">${esc(state.ui.icpEdit.fit)}</textarea></label><label>Passt nicht<textarea id="icpNo" rows="4">${esc(state.ui.icpEdit.noFit)}</textarea></label><div class="two"><button data-act="icpCancel">Abbrechen</button><button class="primary" data-act="icpSave">Speichern</button></div>` : (icp ? `<h4>Passt</h4><ul>${li(icp.fit)}</ul><h4>Passt nicht</h4><ul>${li(icp.noFit)}</ul>${icp.note ? `<p class="note">${esc(icp.note)}</p>` : ""}` : `<p class="note">Noch kein ICP hinterlegt.</p>`) + (state.caps.db ? `<button data-act="icpEdit" style="margin-top:12px">ICP bearbeiten</button>` : "");
  return `<div class="wrap">
  <div class="head"><h1>Mehr</h1></div>
  <div class="sec"><h3>Ideal Customer Profile</h3><div class="card icp">${icpBody}</div></div>
  <div class="sec"><h3>Warum disqualifiziert</h3><div class="card">${lost.length ? `<dl class="facts" style="padding:0">${lost.map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>` : `<p class="note" style="margin:0">Noch keine disqualifizierten Betriebe.</p>`}</div></div>
  <div class="sec"><h3>Nachfass-Rhythmus</h3><div class="card"><p style="margin:0">Nach dem Erstkontakt: Follow-up nach ${cadence[0]} Tagen, dann nach weiteren ${cadence[1]} Tagen. Nach ${maxTouches} Kontakten ohne Antwort schl\xE4gt die App vor, abzuschlie\xDFen.</p></div></div>
  <div class="sec"><h3>Backup</h3><div class="card"><p style="margin:0 0 10px">Alle Betriebe, Kontakte, Vorlagen und das ICP als versionierte JSON-Datei sichern.</p><button class="primary full" data-act="export"${state.caps.db ? "" : " disabled"}>Backup herunterladen</button><button class="full" style="margin-top:8px" data-act="importPick"${state.caps.db ? "" : " disabled"}>Sicherung einspielen</button><input type="file" id="importFile" accept="application/json,.json" hidden></div></div>
  <div class="sec"><h3>Papierkorb</h3><div class="card">${trashHtml(state.ui.trash, state.ui.trashBefore)}</div></div>
  <div class="sec"><h3>Konto</h3><div class="card"><p style="margin:0 0 10px">${esc(state.me?.email || "")} \xB7 Gmail ${!state.caps.gmail ? `nicht verbunden \u2013 <a href="/auth/login">neu anmelden</a>` : state.caps.gmailRead ? "verbunden" : `verbunden \u2013 <a href="/auth/login">Gmail neu verbinden, damit Antworten erscheinen</a>`}</p><form method="post" action="/auth/logout" style="margin:0"><button class="full">Abmelden</button></form><form method="post" action="/auth/logout-all" style="margin:8px 0 0"><button class="full" data-act="logoutAll">\xDCberall abmelden</button></form><p class="note" style="margin:6px 0 0">Meldet dich auf allen Ger\xE4ten ab und trennt alle verbundenen Agenten.</p>${state.me?.version ? `<p class="note" style="margin:10px 0 0">Version ${esc(state.me.version)}</p>` : ""}</div></div>
</div>`;
}
/** Deleted leads, loaded on demand a page at a time; each can come back or be erased for good. */
function trashHtml(trash, before) {
  if (!trash) return `<button class="full" data-act="showTrash">Papierkorb \xF6ffnen</button>`;
  const newest = before ? `<button class="full" style="margin-top:8px" data-act="showTrash">Zu den neuesten</button>` : "";
  // The server reads one more than a page: it says whether older ones follow.
  const entries = trash.slice(0, TRASH_SHOWN);
  if (!entries.length) return `<p class="note" style="margin:0">${before ? "Keine \xE4lteren gel\xF6schten Betriebe." : "Der Papierkorb ist leer."}</p>` + newest;
  const older = trash.length > TRASH_SHOWN ? `<button class="full" style="margin-top:8px" data-act="trashOlder" data-before="${esc(entries.at(-1).seq)}">\xC4ltere anzeigen</button>` : "";
  return entries.map(({ lead, actor, at }) => `<div class="entry"><div class="h"><span>${esc(fmtTime(at))} \xB7 ${esc(actorName(actor))}</span></div><p style="margin:2px 0 8px;font-weight:600">${esc([lead.name, lead.city].filter(Boolean).join(" \xB7 "))}</p><div class="two"><button data-restore="${esc(lead.id)}">Wiederherstellen</button><button class="danger" data-purge="${esc(lead.id)}">Endg\xFCltig l\xF6schen</button></div></div>`).join("") + older + newest;
}
/** Who changed what on this lead, from the history the page loaded. */
function changesHtml(rows) {
  const shown = rows.map((e) => [e, describeChange(e)]).filter(([, lines]) => lines.length);
  return shown.length ? shown.map(([e, lines]) => `<div class="entry"><div class="h"><span>${esc(fmtTime(e.at))} \xB7 ${esc(actorName(e.actor))}</span></div><div class="t">${lines.map(esc).join("<br>")}</div></div>`).join("") : `<p class="note">Noch keine \xC4nderungen aufgezeichnet.</p>`;
}
export const QUICK_FIELDS = [
  { key: "person" },
  { key: "email", type: "email" },
  { key: "phone", type: "tel" },
  { key: "currentTool", options: () => RESERVATION_TOOLS },
  { key: "hook" },
  { key: "fit", options: () => [[3, "★★★ sehr gut"], [2, "★★ passt"], [1, "★ fraglich"]], show: (l) => "★".repeat(l.fit || 2) },
  { key: "website", type: "url" },
  { key: "instagram" },
  { key: "city" },
  { key: "region", options: () => [["", "automatisch"], ...REGIONS], show: (l) => regionOf(l) + (l.region ? "" : " (automatisch)") },
  { key: "type", options: () => BUSINESS_TYPES }
];
export function quickField(l, f, editing) {
  const raw = l[f.key] ?? "";
  if (editing === f.key) {
    const input = f.options ? `<select id="qe" data-field="${f.key}">${options(f.options(), raw)}</select>` : `<input id="qe" data-field="${f.key}" type="${f.type || "text"}" value="${esc(raw)}" autocomplete="off">`;
    return `<div class="fact editing"><dt>${FIELD_LABEL[f.key]}</dt><dd>${input}<div class="qe-actions"><button data-act="qeCancel">Abbrechen</button><button class="primary" data-act="qeSave">Speichern</button></div></dd></div>`;
  }
  const shown = f.show ? f.show(l) : raw;
  return `<div class="fact qe-click" data-edit="${f.key}" role="button" tabindex="0"><dt>${FIELD_LABEL[f.key]}</dt><dd>${shown ? esc(shown) : `<span class="qe-empty">+ hinzuf\xFCgen</span>`}</dd></div>`;
}
/** A lead the page offers a call for, with the call sheet: one in the pipeline, open to contact, not at its appointment. */
const takesCall = (l, today) => isPipeline(l) && !l.optOutAt && !meetingDue(l, today);
/** The call as the server takes it: a day and a time only with Rückruf and Termin, a reason only with Kein Interesse. */
export function callInput({ outcome, date, time, reason, note }) {
  const dated = outcome === "rueckruf" || outcome === "termin";
  return { outcome, date: dated && date || undefined, time: dated && time || undefined, reason: outcome === "kein-interesse" && reason || undefined, note: note || undefined };
}
/** What a lead patch leaves as the next step: [followUp, nextStep], from the patch where it sets them. */
const nextAfter = (l, patch) => ["followUp" in patch ? patch.followUp : l.followUp, "nextStep" in patch ? patch.nextStep : l.nextStep];
/** What saving the call sheet will do, before it is saved: "Beim Speichern: Status wird Qualifiziert · Nächster Schritt …". */
function callPreview(l, acts, call, today) {
  if (!call.outcome) return "";
  let patch;
  try {
    const input = callInput(call);
    patch = planAfterCall(l, acts, callActivity(input, today), input);
  } catch (e) {
    return e.message;
  }
  const status = patch.status || l.status;
  const [followUp, nextStep] = nextAfter(l, patch);
  const move = status === l.status ? `Status bleibt ${STAGE_LABEL[status]}` : `Status wird ${STAGE_LABEL[status]}${status === "disqualifiziert" ? ` (${patch.lostReason})` : ""}`;
  const next = status === "disqualifiziert" ? "kein n\xE4chster Schritt" : followUp ? `${FIELD_LABEL.nextStep} ${fmtDate(followUp)}${nextStep ? " \xB7 " + nextStep : ""}` : "";
  return `Beim Speichern: ${[move, next].filter(Boolean).join(" \xB7 ")}`;
}
/**
 * What logging the composer's message plans (`patch`, from planAfterActivity): "Danach: Nachfassen Mi., 21. Okt.
 * (+3 Tage, Kontakt 1 von 5)"; with a date `chosen` by hand, that date.
 */
function afterLine(l, acts, activity, patch, today, chosen = null) {
  const [followUp, nextStep] = nextAfter(l, patch);
  if (!followUp || !takesFollowUp({ ...l, ...patch })) return "";
  if (chosen) return `Danach: ${nextStep || "Nachfassen"} ${fmtDate(chosen)}`;
  if (activity.direction === "in") return `Danach: ${nextStep || "Nachfassen"}, ${relDate(followUp, today)}`;
  const all = [...acts, activity];
  const touch = (patch.status || l.status) === "kontaktiert" && !hasReply(all) ? `, Kontakt ${countTouches(all)} von ${SEQUENCE_POLICY.maxTouches}` : "";
  return `Danach: ${nextStep || "Nachfassen"} ${fmtDate(followUp)}${patch.followUp ? ` (+${daysBetween(activity.date, followUp)} Tage${touch})` : ""}`;
}
/** The call that may be taken back: the newest activity, when it is a call, and not on an opted-out lead. The server checks the rest. */
const undoable = (l, acts) => !l.optOutAt && acts.at(-1)?.outcome ? acts.at(-1) : null;
const MODE_LABEL = [["out", "Ich schreibe"], ["in", "Antwort eintragen"], ["note", "Notiz"]];
const CHANNEL_TABS = ["E-Mail", "Instagram", "WhatsApp"];
/** The one composer: write (sent by Gmail, or copied into the app), log what came in, or a note for the team. */
function composerHtml(state, l, acts, today, offersMailto) {
  const c = state.ui.compose;
  const closedBy = mailClosedBy(state.data.leads, l);
  const mail = c.channel === "E-Mail";
  const head = `<div class="c-head"><button class="link" data-act="composeCancel">${l.optOutAt ? "Schlie\xDFen" : "Abbrechen"}</button><b>An ${esc(l.name)}</b></div>
    <div class="chips modes">${MODE_LABEL.map(([k, label]) => `<button class="chip" data-mode="${k}" aria-pressed="${c.direction === k}"${k === "out" && l.optOutAt ? " disabled" : ""}>${label}</button>`).join("")}${takesCall(l, today) ? `<button class="chip" data-act="callOpen">Anruf</button>` : ""}</div>`;
  const closedBox = l.optOutAt ? `<div class="optout box"><p>Keine Kontaktaufnahme gew\xFCnscht</p><p class="note">Seit ${esc(dayLabel(l.optOutAt))}. Nachrichten und Anrufe sind gesperrt, auch f\xFCr diese Adresse bei anderen Betrieben. Eine Antwort, die trotzdem kommt, l\xE4sst sich eintragen, aber nicht von hier beantworten.</p></div>` : "";
  if (c.direction === "note") {
    return `<div class="card compose">${head}${closedBox}<textarea id="cText" placeholder="Notiz f\xFCr Sie beide, geht nicht an den Betrieb …">${esc(c.text)}</textarea>
    <button class="primary full" style="margin-top:8px" data-act="saveNote">Notiz speichern</button></div>`;
  }
  const others = CHANNELS.filter((ch) => !CHANNEL_TABS.includes(ch));
  const tabs = `<div class="chips chans">${CHANNEL_TABS.map((ch) => `<button class="chip" data-ch="${esc(ch)}" aria-pressed="${c.channel === ch}">${esc(ch)}</button>`).join("")}<select id="cCh" class="chip" aria-label="Anderer Kanal"><option value="">Andere ▾</option>${options(others, c.channel)}</select></div>`;
  // Written now: the reply rule plans an answer only for the newest entry.
  const activity = { direction: c.direction, channel: c.channel, date: c.date, createdAt: new Date().toISOString() };
  const patch = planAfterActivity(l, acts, activity, today);
  const after = afterLine(l, acts, activity, patch, today, c.followUp);
  const afterHtml = after ? `<p class="note after">${esc(after)} <button class="more" data-act="composeFu">\xC4ndern</button></p>${c.fuEdit ? `<input type="date" id="cFu" value="${esc(c.followUp || nextAfter(l, patch)[0] || "")}" min="${esc(today)}" aria-label="${FIELD_LABEL.followUp}">` : ""}` : "";
  if (c.direction === "in") {
    return `<div class="card compose">${head}${tabs}${closedBox}
    <label>Datum<input type="date" id="cDate" value="${esc(c.date)}" max="${esc(today)}"></label>
    <textarea id="cText" placeholder="Was haben sie geantwortet?">${esc(c.text)}</textarea>
    ${afterHtml}
    <button class="primary full" style="margin-top:8px" data-act="logActivity">Eintragen</button></div>`;
  }
  // The server refuses mail to a closed address and logging one as sent: the reason shows, and no send or log.
  if (mail && closedBy) {
    return `<div class="card compose">${head}${tabs}<div class="optout box"><p>${closedBy === l ? "Keine Kontaktaufnahme gew\xFCnscht" : "Adresse gesperrt"}</p><p class="note">${esc(closedBy === l ? `Seit ${dayLabel(l.optOutAt)}.` : addressOptOutText(closedBy))}</p></div></div>`;
  }
  const gmail = mail && !!l.email && state.caps.gmail;
  const link = mail && !offersMailto(l.email) ? "" : channelLink(l, c.channel, c.text);
  // With Gmail connected, mail that gets the Abmeldelink goes out only by Gmail; a mailto would send it without the link.
  const copy = mail && gmail && !offersMailto(l.email) ? "" : `<a class="btn" data-act="copyOpen" ${link ? `href="${esc(link)}" target="_blank" rel="noopener"` : 'href="#"'}>${link ? "Kopieren und \xF6ffnen" : "Text kopieren"}</a>`;
  const steps = (c.channel === "Instagram" || c.channel === "WhatsApp") && link ? `<div class="hint"><b>So geht's</b><br>1 \xB7 Text wird kopiert, ${esc(c.channel)} \xF6ffnet ${esc(c.channel === "Instagram" ? l.instagram : l.phone)}<br>2 \xB7 Einf\xFCgen und senden<br>3 \xB7 Zur\xFCck hier: „Gesendet“ tippen</div>` : "";
  return `<div class="card compose">${head}${tabs}
    ${c.thread ? `<p class="note">Antwort im Verlauf „${esc(c.thread.subject)}“ \xB7 aus Ihrem Gmail</p>` : ""}
    ${mail && l.email ? `<p class="note">An ${esc(l.email)}</p>` : ""}
    ${gmail ? `<label>Betreff<input id="cSubj" value="${esc(c.subject)}"></label>` : ""}
    <label>Vorlage<select id="cTpl"><option value="">Ohne Vorlage</option>${state.data.templates.filter((x) => x.purpose !== "leitfaden").map((x) => `<option value="${esc(x.id)}"${x.id === c.templateId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    ${gmail ? "" : `<label>Datum<input type="date" id="cDate" value="${esc(c.date)}" max="${esc(today)}"></label>`}
    <textarea id="cText" placeholder="Nachricht">${esc(c.text)}</textarea>
    ${c.missing?.length ? `<p class="hint">Noch leer: ${esc(c.missing.map((m) => "{" + m + "}").join(", "))}. Erg\xE4nze den Betrieb oder passe den Text an.</p>` : ""}
    ${gmail ? signatureHtml(state.ui.signature, c.signed !== false) : ""}
    ${gmail && getsUnsubscribeLink(l) ? `<p class="hint">Ein Abmeldelink wird angeh\xE4ngt, solange ${esc(l.name)} kein Kunde ist.</p>` : ""}
    ${steps}${afterHtml}
    ${gmail ? `<button class="primary full" style="margin-top:8px" data-act="sendEmail">Per Gmail senden</button>` : ""}
    ${copy ? `<div class="two" style="margin-top:8px">${copy}<button${gmail ? "" : ' class="primary"'} data-act="logActivity">Gesendet</button></div>` : ""}
  </div>`;
}
/** What the composer says about the Gmail signature (loadSignature), with the switch to leave it out and a preview as text. */
function signatureHtml(sig, on) {
  if (sig === undefined) return `<p class="note">Signatur wird geladen \u2026</p>`;
  if (sig === null) return `<p class="note">Ohne Signatur: <a href="/auth/login">Gmail neu verbinden</a>, dann h\xE4ngt das CRM Ihre Gmail-Signatur an.</p>`;
  if (!sig.failed && !sig.has) return `<p class="note">In Gmail ist keine Signatur hinterlegt.</p>`;
  const preview = sig.failed ? `<p class="note">Vorschau nicht geladen; die Signatur wird beim Senden angeh\xE4ngt.</p>`
    : sig.text ? `<p class="hint sig">${esc(sig.text)}</p>` : `<p class="note">Signatur ohne Text (ein Bild, etwa ein Logo).</p>`;
  return `<label class="check"><input type="checkbox" id="cSig"${on ? " checked" : ""}> Mit Signatur</label>${on ? preview : ""}`;
}
/** The status chip's menu: the usual next moves from this status, then setting it directly, then the opt-out. */
function statusMenuHtml(l, acts, ui, today) {
  const lost = l.status === "disqualifiziert";
  const item = (act, title, sub, disabled = false) => `<button class="mitem" data-act="${act}"${disabled ? " disabled" : ""}><span><b>${title}</b><small>${sub}</small></span><span aria-hidden="true">›</span></button>`;
  const direct = ui.statusMenu === "direct" ? `<div class="chips" style="margin:6px 0 4px">${STAGES.map(([k, v]) => `<button class="chip${k === "disqualifiziert" ? " lostc" : ""}" data-status="${k}" aria-pressed="${l.status === k}">${v}</button>`).join("")}</div>` : item("statusDirect", `${FIELD_LABEL.status} direkt setzen …`, "f\xFCr den seltenen Fall, fragt einmal nach");
  return `<div class="card menu"><p class="note" style="margin:0 0 4px">Normaler Weg ab ${esc(STAGE_LABEL[l.status])}</p>
    ${takesCall(l, today) ? item("callTermin", "Termin eintragen", `wird ${STAGE_LABEL.qualifiziert}`) : ""}
    ${lost ? item("lostPick", "Grund \xE4ndern", esc(l.lostReason)) : item("lostPick", "Absage eintragen", `wird ${STAGE_LABEL.disqualifiziert}, mit Grund`)}
    ${l.status === "kontaktiert" ? item("closeWithoutReply", "Ohne Antwort abschlie\xDFen", `ab Kontakt ${SEQUENCE_POLICY.maxTouches} von ${SEQUENCE_POLICY.maxTouches}`, !sequenceExhausted(l, acts)) : ""}
    ${direct}
    <button class="mitem danger" data-act="optOut"><span><b>Keine Kontaktaufnahme gew\xFCnscht</b></span></button>
  </div>`;
}
/** The one next-step line: when and what, yellow when a lead in work has none, with the date and text to change. */
function nextStepHtml(l, acts, ui, today) {
  if (!takesFollowUp(l)) return "";
  const due = isDue(l, today);
  const what = l.nextStep || nextActionHint(l, acts);
  const line = lacksNextStep(l) ? `<b>Kein n\xE4chster Schritt</b>` : l.followUp ? `${FIELD_LABEL.nextStep}: ${due && l.followUp < today ? "f\xE4llig " : ""}${esc(relDate(l.followUp, today))}${what ? " \xB7 " + esc(what) : ""}` : `${FIELD_LABEL.nextStep}: ${esc(what || "nichts geplant")}`;
  const edit = ui.nextEdit ? `<div class="nedit"><label>${FIELD_LABEL.nextStep}<input id="nextStep" value="${esc(l.nextStep || "")}" placeholder="${esc(nextActionHint({ ...l, nextStep: "" }, acts) || "z. B. Di vor 15 Uhr anrufen")}"></label>
    <label style="margin:0">${FIELD_LABEL.followUp}</label>
    <div class="furow" style="margin-top:4px"><input type="date" id="fu" value="${esc(l.followUp || "")}" aria-label="${FIELD_LABEL.followUp}"><button data-fu="1">Morgen</button><button data-fu="3">+3 T</button><button data-fu="7">+1 Wo</button><button data-fu="clear">Keins</button></div>
    <button class="more" data-act="nextEdit">Fertig</button></div>` : "";
  return `<div class="next${lacksNextStep(l) ? " lacks" : due ? " due" : ""}"><span>${line}</span>${ui.nextEdit ? "" : `<button class="more" data-act="nextEdit">\xC4ndern</button>`}</div>
    ${l.status === "kontaktiert" && hasReply(acts) ? `<p class="note" style="margin:4px 0 0">Die Antwort hat die Nachfass-Folge angehalten.</p>` : ""}${edit}`;
}
/** The sequence on a wide screen: how many contacts of five, and where it stands. */
function sequenceHtml(l, acts) {
  if (l.status !== "kontaktiert") return "";
  const t = countTouches(acts), max = SEQUENCE_POLICY.maxTouches;
  const reply = acts.find(isReply);
  const text = reply ? `Angehalten: Antwort am ${fmtDate(reply.date)}` : t >= max ? "Alle Kontakte ohne Antwort. Abschlie\xDFen?" : l.followUp ? `N\xE4chster Kontakt ${fmtDate(l.followUp)}` : "";
  return `<div class="sec desk"><h3>Nachfass-Folge</h3><div class="card"><div class="seg" aria-hidden="true">${Array.from({ length: max }, (_, i) => `<span${i < t ? ' class="on"' : ""}></span>`).join("")}</div><p class="note">${Math.min(t, max)} von ${max} Kontakten. ${esc(text)}</p></div></div>`;
}
/**
 * The lead's feed, newest first: the notes pinned on top, mail grouped by its Gmail thread, single messages and
 * calls, and the status moves from the history as grey lines. The chips filter it by kind.
 */
function feedHtml(state, l, acts, today, clamp) {
  const ui = state.ui;
  const mine = (a) => !a.mail?.mailbox || a.mail.mailbox === state.me?.email;
  const kind = (a) => a.outcome || a.channel === "Telefon" ? "call" : a.channel === "E-Mail" ? "mail" : "msg";
  const count = { mail: acts.filter((a) => kind(a) === "mail").length, call: acts.filter((a) => kind(a) === "call").length, note: l.notes ? 1 : 0 };
  const f = ui.feed;
  const chips = `<div class="chips feedc">${[["alle", "Alle"], ["mail", "E-Mail"], ["call", "Anrufe"], ["note", "Notizen"]].map(([k, label]) => `<button class="chip" data-feed="${k}" aria-pressed="${f === k}">${label}${k === "alle" ? "" : ` <small>${count[k]}</small>`}</button>`).join("")}</div>`;
  const notes = `<div class="sec"><h3>${FIELD_LABEL.notes}</h3>${ui.editField === "notes" ? `<div class="card"><textarea id="qe" data-field="notes" rows="10">${esc(l.notes || "")}</textarea><div class="qe-actions"><button data-act="qeCancel">Abbrechen</button><button class="primary" data-act="qeSave">Speichern</button></div></div>` : `<div class="card qe-click" data-edit="notes" role="button" tabindex="0">${l.notes ? clamp("notes", l.notes) : `<span class="qe-empty">+ Notiz hinzuf\xFCgen</span>`}</div>`}</div>`;
  if (f === "note") return chips + notes;
  const tplName = Object.fromEntries(state.data.templates.map((x) => [x.id, x.name]));
  const box = (a) => mine(a) ? "" : ` \xB7 Postfach von ${esc(actorName(a.mail.mailbox))}`;
  const newest = acts.at(-1);
  const undo = undoable(l, acts);
  const head = (a) => kind(a) === "call" ? `Anruf${a.outcome ? " \xB7 " + esc(OUTCOME_LABEL[a.outcome]) : ""}` : `${a.direction === "out" ? "↗ Gesendet" : "↙ Empfangen"} \xB7 ${esc(a.mail?.from && a.direction === "in" ? a.mail.from : a.channel)}`;
  const entry = (a) => `<div class="entry ${a.direction}${kind(a) === "call" ? " call" : ""}"><div class="h"><span>${head(a)} \xB7 ${fmtDate(a.date)}${a.templateId && tplName[a.templateId] ? " \xB7 " + esc(tplName[a.templateId]) : ""}${box(a)}</span><span class="h-acts">${undo === a ? `<button data-undo="${esc(a.id)}">R\xFCckg\xE4ngig</button>` : ""}<button data-copy="${esc(a.id)}">Kopieren</button></span></div>${clamp("a:" + a.id, a.text)}</div>`;
  const shown = acts.filter((a) => f === "alle" || kind(a) === f);
  const threads = new Map();
  for (const a of shown) if (a.mail?.threadId) threads.set(a.mail.threadId, [...threads.get(a.mail.threadId) || [], a]);
  const thread = (msgs) => {
    const last = msgs.at(-1);
    const subject = (last.mail.subject || msgs[0].mail.subject || "(ohne Betreff)");
    const older = msgs.slice(0, -1).reverse().map((a) => {
      const open = ui.expanded.has("a:" + a.id);
      return `<div class="entry ${a.direction}"><div class="h"><span>${head(a)} \xB7 ${fmtDate(a.date)}${box(a)}</span></div>${open ? `<div class="t">${esc(a.text)}</div>` : `<div class="t one">${esc(a.text)}</div>`}<button class="more" data-expand="a:${esc(a.id)}">${open ? "Weniger" : "Mehr anzeigen"}</button></div>`;
    }).join("");
    return `<div class="card thread"><div class="th-head"><b>${esc(subject)}</b>${newest === last && last.direction === "in" ? `<span class="pill new">Neue Antwort</span>` : ""}</div>
      <p class="note" style="margin:0 0 8px">${msgs.length} Nachricht${msgs.length > 1 ? "en" : ""} \xB7 Gmail \xB7 ${mine(last) ? "Ihr Postfach" : `Postfach von ${esc(actorName(last.mail.mailbox))}`}</p>
      ${entry(last)}${older}
      <div class="two">${l.optOutAt ? "" : `<button data-act="reply" data-thread="${esc(last.mail.threadId)}">Antworten</button>`}${takesCall(l, today) ? `<button data-act="callTermin">Termin eintragen</button>` : ""}</div></div>`;
  };
  // Feed items sort by day, then by when they were written; a history entry's day is the viewer's local day.
  const items = [];
  for (const msgs of threads.values()) items.push([msgs.at(-1).date, msgs.at(-1).createdAt || "", thread(msgs)]);
  for (const a of shown) if (!a.mail?.threadId) items.push([a.date, a.createdAt || "", entry(a)]);
  const history = ui.changes?.leadId === l.id ? ui.changes.rows : null;
  if (history && f === "alle") for (const e of history) {
    const move = statusMove(e);
    if (move) items.push([toDateString(new Date(e.at)), e.at, `<p class="sline">${esc(fmtDate(toDateString(new Date(e.at))))} \xB7 ${esc(move)}</p>`]);
  }
  items.sort((a, b) => a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : a[1] < b[1] ? 1 : -1);
  const fields = history ? history.filter((e) => describeChange(e).length).length : 0;
  const changes = history && f === "alle" ? `<button class="more" data-act="changesToggle">\xC4nderungen an Feldern ${ui.changesOpen ? "ausblenden" : `zeigen (${fields})`}</button>${ui.changesOpen ? changesHtml(history) : ""}` : "";
  return `${chips}${f === "alle" ? notes : ""}<div class="sec">${items.length ? items.map((x) => x[2]).join("") : `<p class="note">Noch keine Eintr\xE4ge.</p>`}${changes}</div>`;
}
/** The bar of a round through a list (Heute, the call list, the new businesses): where in it, later, next. */
function roundBar(state, l, today) {
  const r = state.ui.round;
  if (!r) return "";
  const rest = roundList(state, today, r.list).filter((x) => x.id !== l.id && !r.seen.includes(x.id));
  const q = r.list === "queue" ? todayQueue(state, today) : null;
  const part = q ? [["replies", "Neue Antworten"], ["overdue", "\xDCberf\xE4llig"], ["today", "Heute f\xE4llig"]].find(([k]) => q[k].some((x) => x.id === l.id)) : null;
  const label = r.list === "calls" ? "Anrufliste" : r.list === "fresh" ? "Erstkontakte" : `Heute${part ? " \xB7 " + part[1] : ""}`;
  const later = state.ui.later ? `<div class="chips later"><button class="chip" data-later="1">Morgen</button><button class="chip" data-later="7">N\xE4chste Woche</button><input type="date" id="laterDate" min="${esc(addDays(today, 1))}" aria-label="Sp\xE4ter am"></div>` : "";
  return `<div class="l-round"><div class="qbar"><span class="q-pos"><b>${label}</b> \xB7 ${r.seen.length + 1} von ${r.seen.length + 1 + rest.length}</span>${takesFollowUp(l) ? `<button class="link" data-act="later" aria-expanded="${!!state.ui.later}">Sp\xE4ter ▾</button>` : ""}<button class="primary" data-act="roundNext">Weiter ›</button></div>${later}</div>`;
}
export function detailView(state, today) {
  if (!isReady(state)) return loadingOr(state, "");
  const l = currentLead(state);
  const acts = actsOf(state, l.id);
  const ui = state.ui;
  const t = countTouches(acts);
  const lost = l.status === "disqualifiziert";
  const clamp = (key, txt) => {
    const long = (txt || "").length > 220 || (txt || "").split("\n").length > 4;
    const o = ui.expanded.has(key);
    return `<div class="t${long && !o ? " clamp" : ""}">${esc(txt)}</div>${long ? `<button class="more" data-expand="${esc(key)}">${o ? "Weniger" : "Mehr anzeigen"}</button>` : ""}`;
  };
  const calls = takesCall(l, today);
  // An address with an opt-out gets no mail link: this lead's own, or another's on a lead that gets the Abmeldelink
  // (a Kunde's service mail still goes out). From the leads this browser holds; the server refuses the mail too,
  // also for a lead in the Papierkorb.
  const closedTo = mailClosedBy(state.data.leads, l);
  // With Gmail connected, mail that gets the Abmeldelink goes out only by Gmail: a mailto would send it without the
  // link. A Kunde's service mail has no Abmeldelink and keeps its mailto.
  const onlyByGmail = state.caps.gmail && !!l.email && getsUnsubscribeLink(l);
  const touchTxt = l.status === "kontaktiert" && !hasReply(acts) ? `Kontakt ${t} von ${SEQUENCE_POLICY.maxTouches}` : t ? `${t} Kontakt${t > 1 ? "e" : ""}` : "";
  // Whether the page offers a mail link to an address, the composer's or a Kundenakte contact's: this lead's own
  // address as above, closed or only by Gmail; another (an agency's), which Gmail does not send to from here, is
  // closed when a business with an opt-out holds it, except on a Kunde.
  const offersMailto = (email) => !(addressKey(email) === addressKey(l.email) ? closedTo || onlyByGmail : getsUnsubscribeLink(l) && optOutByAddress(state.data.leads, { email }));
  const sub = [l.type, l.city, touchTxt, l.contactedAt ? "seit " + fmtDate(l.contactedAt) : "Nie kontaktiert"].filter(Boolean).map(esc).join(" \xB7 ");
  const chip = `${esc(STAGE_LABEL[l.status])}${lost ? " \xB7 " + esc(l.lostReason) : ""}`;
  const tel = channelLink(l, "Telefon");
  const act = (href, label, attrs = "") => href ? `<a class="btn" href="${esc(href)}"${href.startsWith("tel:") ? "" : ' target="_blank" rel="noopener"'}${attrs}>${label}</a>` : `<a class="btn" aria-disabled="true">${label}</a>`;
  const write = (channel, label, can) => `<button data-compose="${esc(channel)}"${can ? "" : " disabled"}>${label}</button>`;
  // On a phone the row sticks above the tabs; while the composer is open it has its own buttons.
  const actions = ui.compose ? "" : `<div class="acts">${act(l.optOutAt ? "" : tel, "Anrufen", calls ? ' data-act="callOpen"' : "")}${write("E-Mail", "E-Mail", !!l.email)}${write("WhatsApp", "WhatsApp", !l.optOutAt && !!channelLink(l, "WhatsApp"))}${write("Instagram", "Instagram", !l.optOutAt && !!l.instagram)}<button data-compose="in">Eintragen</button></div>`;
  const filled = QUICK_FIELDS.filter((f) => l[f.key] && f.key !== "fit" && f.key !== "type").map((f) => FIELD_LABEL[f.key]).slice(0, 4).join(", ");
  const infoOpen = ui.infoOpen || (ui.editField && ui.editField !== "notes");
  const sheet = calls && (ui.call || ui.round?.list === "calls") ? callHtml(l, acts, ui, today, state.data.templates) : meetingDue(l, today) ? meetingHtml(ui, today) : "";
  return `<div class="bar"><button class="link" data-act="back">‹ Zur\xFCck</button><h2>${esc(l.name)}</h2><button class="link" data-act="edit">Bearbeiten</button></div>
<div class="wrap lead">
  ${roundBar(state, l, today)}
  <div class="card hero">
    <div class="line">${l.optOutAt ? `<span class="pill lost">${chip}</span>` : `<button class="pill${lost ? " lost" : ""}" data-act="statusMenu" aria-expanded="${!!ui.statusMenu}">${chip} ▾</button>`}${l.website ? `<a class="note" href="${esc(l.website)}" target="_blank" rel="noopener">Website ↗</a>` : ""}</div>
    <p class="note" style="margin:8px 0 0">${sub}</p>
    ${ui.statusMenu ? statusMenuHtml(l, acts, ui, today) : ""}
    ${nextStepHtml(l, acts, ui, today)}
  </div>
  ${actions}
  <div class="l-top">
  ${l.optOutAt ? `<div class="card sec optout"><p style="margin:0;font-weight:600">M\xF6chte keine Nachrichten mehr</p><p class="note" style="margin:2px 0 8px">Opt-out seit ${esc(fmtDate(l.optOutAt))}. Keine Mails, DMs oder Anrufe. Nur aufheben, wenn der Betrieb sich selbst wieder meldet.</p><button class="more" data-act="clearOptOut">Opt-out aufheben</button></div>` : ""}
  ${ui.lostPick ? `<div class="card sec"><p style="margin:0 0 8px;font-weight:600">Warum disqualifiziert?</p><div class="chips">${LOST_REASONS.map((r) => `<button class="chip lostc" data-lost="${esc(r)}" aria-pressed="${l.lostReason === r}">${esc(r)}</button>`).join("")}</div><button class="more" data-act="lostCancel">Abbrechen</button></div>` : ""}
  ${sheet}
  ${ui.compose ? `<div class="sec">${composerHtml(state, l, acts, today, offersMailto)}</div>` : ""}
  </div>
  <aside class="l-side">
  <div class="sec infos${infoOpen ? " open" : ""}"><button class="ifold" data-act="infoToggle" aria-expanded="${!!infoOpen}">Infos${filled ? " \xB7 " + esc(filled) : ""} ${infoOpen ? "▴" : "▾"}</button><h3>Infos <small>zum Bearbeiten antippen</small></h3><dl class="card facts qe">${QUICK_FIELDS.map((f) => quickField(l, f, ui.editField)).join("")}</dl></div>
  ${sequenceHtml(l, acts)}
  ${showsAccount(l) ? accountHtml(l, offersMailto) : ""}
  </aside>
  <div class="l-feed">${feedHtml(state, l, acts, today, clamp)}</div>
</div>`;
}
// The fields an outcome asks for: a day and a time (Rückruf, Termin) or the reason, from the sheet's state.
const agreedFields = (today, v) => `<div class="two"><label>Datum<input type="date" id="agDate" min="${esc(today)}" value="${esc(v.date || "")}"></label><label>Uhrzeit <small>optional</small><input type="time" id="agTime" value="${esc(v.time || "")}"></label></div>`;
const reasonField = (label, v) => `<label>${label}<select id="agReason"><option value="">Grund w\xE4hlen …</option>${options(SPOKEN_REASONS, v.reason || "")}</select></label>`;
/** The call sheet: dial, pick how it ended, see what saving does, save. In the call list's round, saving moves on. */
function callHtml(l, acts, ui, today, templates) {
  const c = ui.call || {};
  const script = callScript(l, templates);
  const tel = channelLink(l, "Telefon");
  const fields = c.outcome === "kein-interesse" ? reasonField("Warum kein Interesse?", c) : c.outcome === "rueckruf" || c.outcome === "termin" ? agreedFields(today, c) : "";
  const preview = callPreview(l, acts, c, today);
  return `<div class="sec"><div class="card sheet">
    <h3>Anruf bei ${esc(l.name)}</h3>
    <button class="link" data-act="scriptToggle" aria-expanded="${ui.script}">Gespr\xE4chsleitfaden ${ui.script ? "▴" : "▾"}</button>
    ${ui.script ? `<div class="t" style="white-space:pre-wrap;margin:6px 0 4px">${esc(script.text)}</div>${script.template ? "" : `<button class="link" data-act="scriptTemplate">Als Vorlage anlegen, um ihn anzupassen</button>`}` : ""}
    ${tel ? `<a class="btn full" style="margin-top:10px" href="${esc(tel)}">${esc(l.phone)} anrufen</a>` : `<p class="note" style="margin:0">Keine Telefonnummer hinterlegt.</p>`}
    <div class="chips" style="margin:10px 0">${CALL_OUTCOMES.map(([k, label]) => `<button class="chip${k === "kein-interesse" ? " lostc" : ""}" data-call="${k}" aria-pressed="${c.outcome === k}">${label}</button>`).join("")}</div>
    ${fields}${c.outcome ? `<label>Notiz <small>optional</small><input id="agNote" value="${esc(c.note || "")}"></label>` : ""}
    ${preview ? `<p class="hint">${esc(preview)}</p>` : ""}
    <div class="two" style="margin-top:8px"><button data-act="callCancel">Abbrechen</button><button class="primary" data-act="callSave"${c.outcome ? "" : " disabled"}>${ui.round?.list === "calls" ? "Speichern und weiter ›" : "Speichern"}</button></div>
  </div></div>`;
}
/** On the appointment's day: how it went. */
function meetingHtml(ui, today) {
  const m = ui.meeting;
  const form = !m ? "" : `<div style="margin-top:10px">${m.result === "kein-abschluss" ? reasonField("Warum kein Abschluss?", m) : agreedFields(today, m)}<div class="two" style="margin-top:8px"><button data-act="meetingCancel">Abbrechen</button><button class="primary" data-act="meetingSave">Eintragen</button></div></div>`;
  const chip = (k, label, cls = "") => `<button class="chip${cls}" data-meeting="${k}" aria-pressed="${m?.result === k}">${label}</button>`;
  return `<div class="sec"><h3>Wie war der Termin?</h3><div class="card"><div class="chips">${chip("kunde", "Kunde")}${chip("kein-abschluss", "Kein Abschluss", " lostc")}${chip("neuer-termin", "Neuer Termin")}</div>${form}</div></div>`;
}
const STATE_LABEL = Object.fromEntries(SERVICE_STATES);
const OWNER_LABEL = Object.fromEntries(OWNERS);
const fact = (label, html) => html ? `<div class="fact"><dt>${esc(label)}</dt><dd>${html}</dd></div>` : "";
const dated = (label, d) => d ? `${label} ${esc(fmtDateWithYear(d))}` : "";
/** The Kundenakte on the lead page: what we deliver, their systems and who runs them, the people to reach. */
function accountHtml(l, offersMailto) {
  const a = accountOf(l);
  const who = Object.fromEntries(a.contacts.map((c) => [c.id, c.name]));
  const services = a.services.map((s) => `<div class="fact"><dt>${esc(STATE_LABEL[s.state])}</dt><dd><b>${esc(s.kind)}</b>${s.price ? " \xB7 " + esc(s.price) : ""}${[dated("seit", s.since), dated("live", s.goLive), dated("Vertrag bis", s.contractEnd)].filter(Boolean).map((x) => " \xB7 " + x).join("")}${s.note ? `<br>${esc(s.note)}` : ""}</dd></div>`).join("");
  const sys = a.systems;
  // The domain's line also says who owns it and where it is registered.
  const more = { domain: [sys.domainOwner !== "unbekannt" && `geh\xF6rt: ${OWNER_LABEL[sys.domainOwner]}`, sys.registrar] };
  const systems = [
    ...SYSTEMS.map(([k, label]) => {
      const rest = [...(more[k] || []), sys[k].by && `betreut von ${who[sys[k].by]}`].filter(Boolean);
      return fact(label, sys[k].what || rest.length ? esc([sys[k].what || "\u2013", ...rest].join(" \xB7 ")) : "");
    }),
    fact("Google-Profil", sys.googleProfile !== "unbekannt" ? "verwaltet: " + esc(OWNER_LABEL[sys.googleProfile]) : ""),
    fact("Zug\xE4nge liegen", esc(sys.access)),
  ].join("");
  const contacts = a.contacts.map((c) => {
    const tel = channelLink({ phone: c.phone }, "Telefon");
    const handles = [c.handles, ...handledBy(a, c.id)].filter(Boolean).join(", ");
    return `<div class="fact"><dt>${esc([c.company, c.role].filter(Boolean).join(" \xB7 ") || "Kontakt")}</dt><dd><b>${esc(c.name)}</b>${handles ? ` \xB7 ${esc(handles)}` : ""}${c.email ? `<br>${offersMailto(c.email) ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : esc(c.email)}` : ""}${tel ? `<br><a href="${esc(tel)}">${esc(c.phone)}</a>` : ""}${c.note ? `<br>${esc(c.note)}` : ""}</dd></div>`;
  }).join("");
  const part = (title, html, empty) => `<h4>${title}</h4>${html ? `<dl class="facts" style="padding:0">${html}</dl>` : `<p class="note">${empty}</p>`}`;
  return `<div class="sec"><h3>Kundenakte <button class="link" data-act="accountEdit">Bearbeiten</button></h3><div class="card account">
    ${part("Leistungen", services, "Noch keine Leistung eingetragen.")}${part("Systeme", systems, "Noch nichts zu Domain, Hosting oder Kasse.")}${part("Kontakte", contacts, "Noch keine Kontakte, etwa die Agentur.")}
  </div></div>`;
}
/** A labelled one-line field of a form. */
const textField = (name, value, label, type = "text", placeholder = "") => `<label>${label}<input name="${name}" type="${type}" value="${esc(value || "")}" placeholder="${esc(placeholder)}"></label>`;
/** The Kundenakte form: every entry plus one empty row each to add to. The Kundenakte as shown goes along as `before`. */
export function accountEditView(state) {
  if (!isReady(state)) return loadingOr(state, "");
  const l = currentLead(state);
  const a = accountOf(l);
  const blank = [["", "\u2013"]];
  const note = (name, v) => `<label>Notiz<textarea name="${name}" rows="3">${esc(v || "")}</textarea></label>`;
  const drop = (name, id) => id ? `<label class="drop"><input type="checkbox" name="${name}.drop" value="1"> Entfernen</label>` : "";
  const services = [...a.services, {}].map((s, i) => `<div class="card"><input type="hidden" name="services.${i}.id" value="${esc(s.id || "")}">
    <div class="two"><label>Leistung<select name="services.${i}.kind">${options(s.id ? SERVICE_KINDS : [...blank, ...SERVICE_KINDS], s.kind || "")}</select></label><label>Stand<select name="services.${i}.state">${options(s.id ? SERVICE_STATES : [...blank, ...SERVICE_STATES], s.state || "")}</select></label></div>
    <div class="two">${textField(`services.${i}.since`, s.since, "Seit", "date")}${textField(`services.${i}.goLive`, s.goLive, "Live seit", "date")}</div>
    <div class="two">${textField(`services.${i}.contractEnd`, s.contractEnd, "Vertrag bis", "date")}${textField(`services.${i}.price`, s.price, "Preis", "text", "z. B. 49 \u20AC/Monat")}</div>
    ${note(`services.${i}.note`, s.note)}${drop(`services.${i}`, s.id)}</div>`).join("");
  const people = [["", "\u2013"], ...a.contacts.map((c) => [c.id, c.name])];
  const sys = a.systems;
  const systems = `<div class="card">
    <div class="two"><label>Domain geh\xF6rt<select name="systems.domainOwner">${options(OWNERS, sys.domainOwner)}</select></label>${textField("systems.registrar", sys.registrar, "Registriert bei", "text", "z. B. World4You")}</div>
    ${SYSTEMS.map(([k, label]) => `<div class="two">${textField(`systems.${k}.what`, sys[k].what, label)}<label>betreut von<select name="systems.${k}.by">${options(people, sys[k].by || "")}</select></label></div>`).join("")}
    <label>Google-Profil verwaltet<select name="systems.googleProfile">${options(OWNERS, sys.googleProfile)}</select></label>
    ${textField("systems.access", sys.access, "Wo liegen die Zug\xE4nge? (keine Passw\xF6rter)", "text", "z. B. 1Password, Tresor Kunden")}
    <p class="hint">\u201Ebetreut von\u201C w\xE4hlt aus den gespeicherten Kontakten. Einen neuen Kontakt erst sichern.</p></div>`;
  const contacts = [...a.contacts, {}].map((c, i) => `<div class="card"><input type="hidden" name="contacts.${i}.id" value="${esc(c.id || "")}">
    <div class="two">${textField(`contacts.${i}.name`, c.name, "Name")}${textField(`contacts.${i}.company`, c.company, "Firma", "text", "z. B. Webagentur")}</div>
    <div class="two">${textField(`contacts.${i}.role`, c.role, "Rolle", "text", "Inhaberin, Agentur, IT")}${textField(`contacts.${i}.handles`, c.handles, "K\xFCmmert sich um", "text", "Domain, Website")}</div>
    <div class="two">${textField(`contacts.${i}.email`, c.email, "E-Mail", "email")}${textField(`contacts.${i}.phone`, c.phone, "Telefon", "tel")}</div>
    ${note(`contacts.${i}.note`, c.note)}${drop(`contacts.${i}`, c.id)}</div>`).join("");
  return `<div class="bar"><button class="link" data-act="back">Abbrechen</button><h2>Kundenakte</h2><button class="link" data-act="accountSave">Sichern</button></div>
<form class="wrap" id="aform"><input type="hidden" name="before" value="${esc(JSON.stringify(a))}">
  <p class="note">${esc(l.name)}</p>
  <div class="sec"><h3>Leistungen</h3>${services}</div>
  <div class="sec"><h3>Systeme</h3>${systems}</div>
  <div class="sec"><h3>Kontakte</h3>${contacts}</div>
</form>`;
}
export function leadEditView(state) {
  if (state.ui.leadId && !isReady(state)) return loadingOr(state, "");
  const l = state.ui.leadId ? currentLead(state) : null;
  const d = l || { status: "neu", fit: 2, currentTool: "unbekannt", type: "Restaurant" };
  const f = (n, ph = "", type = "text") => textField(n, d[n], FIELD_LABEL[n], type, ph);
  return `<div class="bar"><button class="link" data-act="back">Abbrechen</button><h2>${l ? "Bearbeiten" : "Neuer Betrieb"}</h2><button class="link" data-act="saveLead">Sichern</button></div>
<form class="wrap" id="form">
  ${textField("name", d.name, FIELD_LABEL.name + " *")}
  <div class="two">${f("city")}<label>${FIELD_LABEL.type}<select name="type">${options(BUSINESS_TYPES, d.type)}</select></label></div>
  <label>${FIELD_LABEL.region}<select name="region">${options([["", "automatisch aus Ort" + (d.city ? " (" + regionOf(d) + ")" : "")], ...REGIONS], d.region || "")}</select></label>
  <div class="two"><label>${FIELD_LABEL.status}<select name="status">${options(STAGES, d.status)}</select></label><label>${FIELD_LABEL.fit}<select name="fit">${options([[3, "\u2605\u2605\u2605 sehr gut"], [2, "\u2605\u2605 passt"], [1, "\u2605 fraglich"]], d.fit)}</select></label></div>
  <label id="lostReasonField"${d.status === "disqualifiziert" ? "" : " hidden"}>${FIELD_LABEL.lostReason} *<select name="lostReason">${options([["", "Grund w\xE4hlen \u2026"], ...LOST_REASONS], d.lostReason || "")}</select></label>
  ${f("instagram", "@handle")}
  ${f("phone", "+43 \u2026", "tel")}
  ${f("email", "name@betrieb.at", "email")}
  ${f("website", "https://", "url")}
  ${f("person")}
  <label>${FIELD_LABEL.currentTool}<select name="currentTool">${options(RESERVATION_TOOLS, d.currentTool)}</select></label>
  ${f("hook", "z. B. Neuer\xF6ffnung")}
  <label>${FIELD_LABEL.notes}<textarea name="notes" rows="8">${esc(d.notes || "")}</textarea></label>
  <button class="primary full" data-act="saveLead">Speichern</button>
  ${l ? `<button class="danger full" data-act="deleteLead" style="margin-top:28px">Betrieb l\xF6schen</button>` : ""}
</form>`;
}
