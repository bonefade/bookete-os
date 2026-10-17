import { STAGES, STAGE_LABEL, LOST_REASONS, BUSINESS_TYPES, RESERVATION_TOOLS, CHANNELS, TEMPLATE_PURPOSES, PURPOSE_LABEL, SEQUENCE_POLICY, TRASH_SHOWN } from '../domain/constants.js';
import { actsOf, currentLead, icpOf, isReady, scoped, regionCounts, toolCounts, contactCounts } from './selectors.js';
import { addDays } from '../domain/dates.js';
import { channelLink, instagramProfile } from './platform.js';
import { countTouches, hasReply, sequenceExhausted, nextActionHint } from '../domain/activity.js';
import { esc, fmtDate, relDate, options, describeChange, actorName, fmtTime, FIELD_LABEL } from './format.js';
import { fold, searchTokens, searchLeads, markRanges, markHtml, snippetHtml } from './search.js';
import { isPipeline, takesFollowUp, isDue } from '../domain/lead.js';
import { outreachStats, lostBreakdown, templateUsage } from '../domain/stats.js';
import { REGIONS, regionOf } from '../domain/region.js';

export const ICONS = {
  suche: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  todos: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  heute: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  betriebe: '<svg viewBox="0 0 24 24"><path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/></svg>',
  vorlagen: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
  mehr: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>'
};
export const TABS = [["heute", "Heute"], ["todos", "Todos"], ["betriebe", "Betriebe"], ["suche", "Suche"], ["vorlagen", "Vorlagen"], ["mehr", "Mehr"]];
export function tabBar(state, today) {
  const due = state.data.leads.filter((l) => isDue(l, today)).length;
  return `<div class="in">${TABS.map(([k, v]) => `<button class="tab" data-tab="${k}" ${state.ui.tab === k ? 'aria-current="page"' : ""}>${ICONS[k]}<span>${v}</span>${k === "todos" && due ? `<span class="badge">${due}</span>` : ""}</button>`).join("")}</div>`;
}
export function leadRow(state, l, today) {
  const acts = actsOf(state, l.id);
  const hint = takesFollowUp(l) ? nextActionHint(l, acts) : l.lostReason || "";
  const due = isDue(l, today);
  const short = (d) => (new Date(d + "T12:00:00")).toLocaleDateString("de-AT", { weekday: "short", day: "numeric", month: "numeric" });
  const when = l.optOutAt ? "Opt-out" : l.followUp && takesFollowUp(l) ? due ? l.followUp === today ? "heute" : "f\xE4llig " + short(l.followUp).replace(/^\S+ /, "") : short(l.followUp) : "";
  return `<li><button class="lrow${due ? " due" : ""}${l.optOutAt ? " out" : ""}" data-open="${esc(l.id)}">
  <span class="c-name">${esc(l.name)}</span>
  <span class="c-fit" aria-label="Fit ${l.fit || 2}">${"\u2605".repeat(l.fit || 2)}</span>
  <span class="c-loc">${esc(l.city || "")}</span>
  <span class="c-st st-${esc(l.status)}">${esc(STAGE_LABEL[l.status] || l.status)}</span>
  <span class="c-next">${esc(hint)}</span>
  <span class="c-sub">${esc([STAGE_LABEL[l.status], l.city, hint].filter(Boolean).join(" \xB7 "))}</span>
  <span class="c-mail" title="${l.email ? esc(l.email) : "keine E-Mail"}">${l.email ? "\u2709" : "\u2013"}</span>
  <span class="c-when${due || l.optOutAt ? " warn" : ""}">${esc(when)}</span>
</button></li>`;
}
export const listHead = `<li class="lhead" aria-hidden="true"><span>Betrieb</span><span></span><span>Ort</span><span>Status</span><span>N\xE4chster Schritt</span><span>\u2709</span><span>Nachfassen</span></li>`;
export const rowsOf = (state, arr, today) => `<ul class="ltable">${listHead}${arr.map((l) => leadRow(state, l, today)).join("")}</ul>`;
/** One filter as a select; `choices` are [value, label, count]. The controller writes the value to ui[key]. */
const filterSelect = (key, label, choices, value) => `<select data-filter="${key}" aria-label="${label}">${options(choices.map(([k, l, n]) => [k, `${l} (${n})`]), value)}</select>`;
/** The filters every list shares, in one row; `more` adds a view's own filters to it. */
export function filterBar(state, more = "") {
  const { ui } = state;
  const all = (ignore) => scoped(state, state.data.leads, ignore).length;
  return `<div class="fbar">
  ${filterSelect("region", "Region", [["alle", "Alle Regionen", all("region")], ...regionCounts(state).map(([r, n]) => [r, r, n])], ui.region)}
  ${filterSelect("tool", "System", [["alle", "Alle Systeme", all("tool")], ...toolCounts(state).map(([t, n]) => [t, t, n])], ui.tool)}
  ${filterSelect("contact", "Kontakt", [["alle", "Alle Kontakte", all("contact")], ...contactCounts(state)], ui.contact)}${more}
</div>`;
}
export const loadingOr = (state, html) => isReady(state) ? html : `<div class="empty">${esc(state.status.failed || "Lade Daten \u2026")}</div>`;
export function todayView(state, today) {
  const leads = scoped(state), open = leads.filter(isPipeline), wk = addDays(today, 7);
  const byDate = (a, b) => a.followUp < b.followUp ? -1 : 1;
  const soon = open.filter((l) => l.followUp && l.followUp > today && l.followUp <= wk).sort(byDate);
  const fresh = leads.filter((l) => l.status === "neu" && !l.followUp).sort((a, b) => b.fit - a.fit || (b.email ? 1 : 0) - (a.email ? 1 : 0));
  const s = outreachStats(leads, new Map(leads.map((l) => [l.id, actsOf(state, l.id)])));
  const list = (arr, empty) => arr.length ? rowsOf(state, arr, today) : `<div class="empty">${empty}</div>`;
  const date = (new Date(today + "T12:00:00")).toLocaleDateString("de-AT", { weekday: "long", day: "numeric", month: "long" });
  const withMail = fresh.filter((l) => l.email).length;
  return `<div class="wrap wide">
  <div class="head"><div><h1>Heute</h1><p>${esc(date)}${state.ui.region !== "alle" ? " \xB7 " + esc(state.ui.region) : ""}</p></div></div>
  ${filterBar(state)}
  <div class="stats"><div class="stat"><b>${s.contacted}</b><span>kontaktiert</span></div><div class="stat"><b>${s.replied}</b><span>Antworten</span></div><div class="stat"><b>${s.replyRate == null ? "\u2013" : Math.round(s.replyRate * 100) + " %"}</b><span>Antwortquote</span></div><div class="stat"><b>${withMail}</b><span>bereit per Mail</span></div></div>
  ${loadingOr(state, `
  <div class="sec"><h3>N\xE4chste 7 Tage <small>${soon.length}</small></h3>${list(soon, "Keine Termine diese Woche.")}</div>
  <div class="sec"><h3>Bereit zum Anschreiben <small>${fresh.length}</small></h3>${list(fresh, "Keine neuen Betriebe in dieser Auswahl.")}</div>`)}
</div>`;
}
/** Due leads as a to-do list: what to do first, then for whom and since when. */
export function todosView(state, today) {
  const due = scoped(state).filter((l) => isDue(l, today)).sort((a, b) => a.followUp < b.followUp ? -1 : a.followUp > b.followUp ? 1 : b.fit - a.fit);
  const row = (l) => `<li><button class="todo" data-open="${esc(l.id)}">
  <span class="t-what">${esc(nextActionHint(l, actsOf(state, l.id)) || "Nachfassen")}</span>
  <span class="t-who">${esc([l.name, l.city, STAGE_LABEL[l.status]].filter(Boolean).join(" \xB7 "))}</span>
  <span class="t-when">${esc(relDate(l.followUp, today))}</span>
</button></li>`;
  const sec = (title, arr, empty) => `<div class="sec"><h3>${title} <small>${arr.length}</small></h3>${arr.length ? `<ul class="ltable">${arr.map(row).join("")}</ul>` : `<div class="empty">${empty}</div>`}</div>`;
  return `<div class="wrap wide">
  <div class="head"><div><h1>Todos</h1><p>${due.length ? `${due.length} f\xE4llig` : "Alles erledigt"}${state.ui.region !== "alle" ? " \xB7 " + esc(state.ui.region) : ""}</p></div></div>
  ${filterBar(state)}
  ${loadingOr(state, sec("\xDCberf\xE4llig", due.filter((l) => l.followUp < today), "Nichts \xFCberf\xE4llig.") + sec("Heute", due.filter((l) => l.followUp === today), "F\xFCr heute nichts offen."))}
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
  const own = filterSelect("status", "Status", STATUS_FILTERS.map(([k, label, pass]) => [k, label, base.filter(pass).length]), status) + (disq
    ? filterSelect("reason", "Grund", [["alle", "Alle Gr\xFCnde"], ...LOST_REASONS.map((r) => [r, r])].map(([k, label]) => [k, label, closed.filter((l) => byContacted(l) && byReason(l, k)).length]), reason)
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
    <label>Name *<input id="qaName" autocomplete="off"></label>
    <div class="two"><label>Ort<input id="qaCity"></label><label>Instagram<input id="qaIg" placeholder="@handle" autocapitalize="off"></label></div>
    <label>Aufh\xE4nger<input id="qaHook" placeholder="z. B. Neuer\xF6ffnung"></label>
    <div class="two"><button data-act="quickCancel">Abbrechen</button><button class="primary" data-act="quickSave">Hinzuf\xFCgen</button></div>
    <p class="note">Den Rest kann Claude recherchieren und erg\xE4nzen.</p></div>` : "";
  return `<div class="wrap wide">
  <div class="head"><h1>Betriebe</h1><button class="primary" data-act="quick"${state.caps.db ? "" : " disabled"}>+ Neu</button></div>
  ${quickForm}
  ${filterBar(state, own)}
  <div class="toolbar">
    <input type="search" id="q" placeholder="Suchen \u2026" value="${esc(q)}" aria-label="Suchen">
    <select id="sort" aria-label="Sortierung">${options([["prio", "\u2195 Fit"], ["nachfassen", "\u2195 Nachfassen"], ["status", "\u2195 Status"], ["name", "\u2195 Name"]], sort)}</select>
  </div>
  <p class="note count">${list.length} Betriebe${list.length ? ` \xB7 ${list.filter((l) => l.email).length} mit E-Mail` : ""}${hidden ? ` \xB7 <button class="more" data-act="toSearch">${hidden} weitere Treffer au\xDFerhalb der Filter</button>` : ""}</p>
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
  ${r.hit ? `<span class="s-hit"><b>${esc(r.hit.label)}</b>${snippetHtml(r.hit, tokens)}</span>` : ""}
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
export function searchView(state, today) {
  return `<div class="wrap wide">
  <div class="head"><div><h1>Suche</h1><p>Alle Betriebe – unabh\xE4ngig von Region, System, Kontakt und Status</p></div></div>
  <div class="sbox"><div class="sfield">${ICONS.suche}<input type="search" id="gq" value="${esc(state.ui.gq)}" placeholder="Name, Ort, Person, Telefon, Notiz …" aria-label="Alle Betriebe durchsuchen" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></div>
  <p class="note">Findet auch Notizen und den gesamten Verlauf. Umlaute egal, mehrere W\xF6rter grenzen ein.<span class="skeys"> \xB7 <kbd>↑</kbd><kbd>↓</kbd> w\xE4hlen, <kbd>Enter</kbd> \xF6ffnet \xB7 von \xFCberall: <kbd>/</kbd> oder <kbd>Strg K</kbd></span></p></div>
  <div id="sres">${searchResultsHtml(state, today)}</div>
</div>`;
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
  const t = state.data.templates.find((x) => x.id === id) || { name: "", purpose: "followup1", body: "" };
  return `<div class="bar"><button class="link" data-act="back">Abbrechen</button><h2>${id ? "Vorlage" : "Neue Vorlage"}</h2><button class="link" data-act="tplSave">Sichern</button></div>
<form class="wrap sub" id="tform">
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
  const icpBody = state.ui.icpEdit ? `<label>Passt (eine Zeile pro Kriterium)<textarea id="icpFit" rows="7">${esc((icp?.fit || []).join("\n"))}</textarea></label><label>Passt nicht<textarea id="icpNo" rows="4">${esc((icp?.noFit || []).join("\n"))}</textarea></label><div class="two"><button data-act="icpCancel">Abbrechen</button><button class="primary" data-act="icpSave">Speichern</button></div>` : (icp ? `<h4>Passt</h4><ul>${li(icp.fit)}</ul><h4>Passt nicht</h4><ul>${li(icp.noFit)}</ul>${icp.note ? `<p class="note">${esc(icp.note)}</p>` : ""}` : `<p class="note">Noch kein ICP hinterlegt.</p>`) + (state.caps.db ? `<button data-act="icpEdit" style="margin-top:12px">ICP bearbeiten</button>` : "");
  return `<div class="wrap">
  <div class="head"><h1>Mehr</h1></div>
  <div class="sec"><h3>Ideal Customer Profile</h3><div class="card icp">${icpBody}</div></div>
  <div class="sec"><h3>Warum disqualifiziert</h3><div class="card">${lost.length ? `<dl class="facts" style="padding:0">${lost.map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>` : `<p class="note" style="margin:0">Noch keine disqualifizierten Betriebe.</p>`}</div></div>
  <div class="sec"><h3>Nachfass-Rhythmus</h3><div class="card"><p style="margin:0">Nach dem Erstkontakt: Follow-up nach ${cadence[0]} Tagen, dann nach weiteren ${cadence[1]} Tagen. Nach ${maxTouches} Kontakten ohne Antwort schl\xE4gt die App vor, abzuschlie\xDFen.</p></div></div>
  <div class="sec"><h3>Backup</h3><div class="card"><p style="margin:0 0 10px">Alle Betriebe, Kontakte, Vorlagen und das ICP als versionierte JSON-Datei sichern.</p><button class="primary full" data-act="export"${state.caps.db ? "" : " disabled"}>Backup herunterladen</button><button class="full" style="margin-top:8px" data-act="importPick"${state.caps.db ? "" : " disabled"}>Sicherung einspielen</button><input type="file" id="importFile" accept="application/json,.json" hidden></div></div>
  <div class="sec"><h3>Papierkorb</h3><div class="card">${trashHtml(state.ui.trash)}</div></div>
  <div class="sec"><h3>Konto</h3><div class="card"><p style="margin:0 0 10px">${esc(state.me?.email || "")} \xB7 Gmail ${state.caps.gmail ? "verbunden" : `nicht verbunden \u2013 <a href="/auth/login">neu anmelden</a>`}</p><form method="post" action="/auth/logout" style="margin:0"><button class="full">Abmelden</button></form><form method="post" action="/auth/logout-all" style="margin:8px 0 0"><button class="full" data-act="logoutAll">\xDCberall abmelden</button></form><p class="note" style="margin:6px 0 0">Meldet dich auf allen Ger\xE4ten ab und trennt alle verbundenen Agenten.</p>${state.me?.version ? `<p class="note" style="margin:10px 0 0">Version ${esc(state.me.version)}</p>` : ""}</div></div>
</div>`;
}
/** Deleted leads, loaded on demand; each can come back or be erased for good. */
function trashHtml(trash) {
  if (!trash) return `<button class="full" data-act="showTrash">Papierkorb \xF6ffnen</button>`;
  if (!trash.length) return `<p class="note" style="margin:0">Der Papierkorb ist leer.</p>`;
  return (trash.length >= TRASH_SHOWN ? `<p class="note" style="margin:0 0 8px">Die neuesten ${TRASH_SHOWN}; \xE4ltere erscheinen, wenn diese weg sind.</p>` : "") + trash.map(({ lead, actor, at }) => `<div class="entry"><div class="h"><span>${esc(fmtTime(at))} \xB7 ${esc(actorName(actor))}</span></div><p style="margin:2px 0 8px;font-weight:600">${esc([lead.name, lead.city].filter(Boolean).join(" \xB7 "))}</p><div class="two"><button data-restore="${esc(lead.id)}">Wiederherstellen</button><button class="danger" data-purge="${esc(lead.id)}">Endg\xFCltig l\xF6schen</button></div></div>`).join("");
}
/** Who changed what on this lead, loaded on demand. */
function changesHtml(changes) {
  const shown = changes.rows.map((e) => [e, describeChange(e)]).filter(([, lines]) => lines.length);
  return shown.length ? shown.map(([e, lines]) => `<div class="entry"><div class="h"><span>${esc(fmtTime(e.at))} \xB7 ${esc(actorName(e.actor))}</span></div><div class="t">${lines.map(esc).join("<br>")}</div></div>`).join("") : `<p class="note">Noch keine \xC4nderungen aufgezeichnet.</p>`;
}
export const QUICK_FIELDS = [
  { key: "person" },
  { key: "email", type: "email" },
  { key: "phone", type: "tel" },
  { key: "currentTool", options: () => RESERVATION_TOOLS },
  { key: "hook" },
  { key: "fit", options: () => [[3, "\u2605\u2605\u2605 sehr gut"], [2, "\u2605\u2605 passt"], [1, "\u2605 fraglich"]], show: (l) => "\u2605".repeat(l.fit || 2) },
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
export function detailView(state, today) {
  const l = currentLead(state);
  const acts = actsOf(state, l.id);
  const ui = state.ui;
  const c = ui.compose;
  const t = countTouches(acts);
  const lost = l.status === "disqualifiziert";
  const btn = (href, label) => `<a class="btn" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : 'aria-disabled="true"'}>${label}</a>`;
  const clamp = (key, txt) => {
    const long = (txt || "").length > 220 || (txt || "").split("\n").length > 4;
    const o = ui.expanded.has(key);
    return `<div class="t${long && !o ? " clamp" : ""}">${esc(txt)}</div>${long ? `<button class="more" data-expand="${key}">${o ? "Weniger" : "Mehr anzeigen"}</button>` : ""}`;
  };
  const factsHtml = QUICK_FIELDS.map((f) => quickField(l, f, ui.editField)).join("");
  const tplName = Object.fromEntries(state.data.templates.map((x) => [x.id, x.name]));
  const touchTxt = l.status === "kontaktiert" && !hasReply(acts) ? `Kontakt ${t} von ${SEQUENCE_POLICY.maxTouches}` : t ? `${t} Kontakt${t > 1 ? "e" : ""}` : "";
  let compose = "";
  if (c) {
    const link = c.direction === "out" ? channelLink(l, c.channel, c.text) : "";
    const gmail = c.direction === "out" && c.channel === "E-Mail" && !!l.email && state.caps.gmail;
    compose = `<div class="card compose">
    <h3 style="font-size:1.05rem;margin-bottom:10px">${c.direction === "out" ? "Nachricht schreiben" : "Antwort eintragen"}</h3>
    ${c.direction === "out" ? `<label>Vorlage<select id="cTpl"><option value="">Ohne Vorlage</option>${state.data.templates.map((x) => `<option value="${esc(x.id)}"${x.id === c.templateId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : ""}
    <div class="two"><label>Kanal<select id="cCh">${options(CHANNELS, c.channel)}</select></label><label>Datum<input type="date" id="cDate" value="${esc(c.date)}" max="${esc(today)}"></label></div>
    <textarea id="cText" placeholder="${c.direction === "out" ? "Nachricht" : "Was haben sie geantwortet?"}">${esc(c.text)}</textarea>
    ${c.missing?.length ? `<p class="hint">Noch leer: ${esc(c.missing.map((m) => "{" + m + "}").join(", "))}. Erg\xE4nze den Betrieb oder passe den Text an.</p>` : ""}
    ${gmail ? `<label>Betreff<input id="cSubj" value="${esc(c.subject)}"></label>` : ""}
    ${c.direction === "out" ? `<a class="btn full" style="margin-top:8px" data-act="copyOpen" ${link ? `href="${esc(link)}" target="_blank" rel="noopener"` : 'href="#"'}>${link ? `Kopieren & ${esc(c.channel)} \xF6ffnen` : "Text kopieren"}</a>` : ""}
    ${gmail ? `<button class="primary full" style="margin-top:8px" data-act="sendEmail">Per Gmail senden</button>` : ""}
    <div class="two" style="margin-top:8px"><button data-act="composeCancel">Abbrechen</button><button${gmail ? "" : ' class="primary"'} data-act="logActivity">${c.direction === "out" ? "Als gesendet eintragen" : "Eintragen"}</button></div>
  </div>`;
  }
  return `<div class="bar"><button class="link" data-act="back">\u2039 Zur\xFCck</button><h2>${esc(l.name)}</h2><button class="link" data-act="edit">Bearbeiten</button></div>
<div class="wrap sub">
  <div class="card hero">
    <div class="line"><span class="pill${lost ? " lost" : ""}">${esc(STAGE_LABEL[l.status])}${lost ? " \xB7 " + esc(l.lostReason) : ""}</span><span class="touch">${esc(touchTxt)}</span></div>
    <p class="note" style="margin:8px 0 0">${l.contactedAt ? "Kontaktiert seit " + esc(fmtDate(l.contactedAt)) : "Nie kontaktiert"}</p>
    ${takesFollowUp(l) ? `<label style="margin:12px 0 10px">N\xE4chster Schritt<input id="nextStep" value="${esc(l.nextStep || "")}" placeholder="${esc(nextActionHint({ ...l, nextStep: "" }, acts) || "z. B. Di vor 15 Uhr anrufen")}"></label>
    <label style="margin:0">Nachfassen am</label>
    <div class="furow" style="margin-top:4px"><input type="date" id="fu" value="${esc(l.followUp || "")}" aria-label="Nachfassen am"><button data-fu="3">+3 T</button><button data-fu="7">+1 Wo</button><button data-fu="clear">Keins</button></div>
    ${isDue(l, today) ? `<p class="note" style="color:var(--due);font-weight:600">F\xE4llig ${esc(relDate(l.followUp, today))}</p>` : ""}
    ${sequenceExhausted(l, acts) ? `<button class="danger full" style="margin-top:10px" data-act="closeWithoutReply">Ohne Antwort abschlie\xDFen</button>` : ""}` : ""}
  </div>
  ${l.optOutAt ? `<div class="card sec optout"><p style="margin:0;font-weight:600">M\xF6chte keine Nachrichten mehr</p><p class="note" style="margin:2px 0 8px">Opt-out seit ${esc(fmtDate(l.optOutAt))}. Keine Mails, DMs oder Anrufe. Nur aufheben, wenn der Betrieb sich selbst wieder meldet.</p><button class="more" data-act="clearOptOut">Opt-out aufheben</button></div>` : ""}
  ${c ? `<div class="sec">${compose}</div>` : l.optOutAt ? `<div class="sec"><button class="full" data-act="composeIn">Eingehende Nachricht eintragen</button></div>` : `<div class="two sec"><button class="primary" data-act="composeOut">Nachricht schreiben</button><button data-act="composeIn">Antwort eintragen</button></div>`}
  <div class="sec"><div class="quick">${btn(channelLink(l, "Telefon"), "Anrufen")}${btn(channelLink(l, "E-Mail"), "E-Mail")}${btn(instagramProfile(l), "Instagram")}${btn(l.website, "Website")}</div></div>
  <div class="sec"><h3>Status</h3><div class="chips">${STAGES.map(([k, v]) => `<button class="chip${k === "disqualifiziert" ? " lostc" : ""}" data-status="${k}" aria-pressed="${l.status === k}">${v}</button>`).join("")}</div>
    ${l.optOutAt ? "" : `<button class="danger full" style="margin-top:12px" data-act="optOut">Keine Nachrichten mehr (Opt-out)</button>`}
    ${ui.lostPick ? `<div class="card" style="margin-top:10px"><p style="margin:0 0 8px;font-weight:600">Warum disqualifiziert?</p><div class="chips">${LOST_REASONS.map((r) => `<button class="chip lostc" data-lost="${esc(r)}" aria-pressed="${l.lostReason === r}">${esc(r)}</button>`).join("")}</div><button class="more" data-act="lostCancel">Abbrechen</button></div>` : lost && !l.optOutAt ? `<button class="more" data-act="lostPick">Grund \xE4ndern</button>` : ""}
  </div>
  <div class="sec"><h3>Infos <small>zum Bearbeiten antippen</small></h3><dl class="card facts qe">${factsHtml}</dl></div>
  <div class="sec"><h3>Notizen</h3>${ui.editField === "notes" ? `<div class="card"><textarea id="qe" data-field="notes" rows="10">${esc(l.notes || "")}</textarea><div class="qe-actions"><button data-act="qeCancel">Abbrechen</button><button class="primary" data-act="qeSave">Speichern</button></div></div>` : `<div class="card qe-click" data-edit="notes" role="button" tabindex="0">${l.notes ? clamp("notes", l.notes) : `<span class="qe-empty">+ Notiz hinzuf\xFCgen</span>`}</div>`}</div>
  <div class="sec"><h3>Verlauf</h3>${acts.length ? [...acts].reverse().map((e) => `<div class="entry ${e.direction}"><div class="h"><span>${fmtDate(e.date)} \xB7 ${esc(e.channel)} \xB7 ${e.direction === "out" ? "wir \u2192 Betrieb" : "Betrieb \u2192 wir"}${e.templateId && tplName[e.templateId] ? " \xB7 " + esc(tplName[e.templateId]) : ""}</span><button data-copy="${esc(e.id)}">Kopieren</button></div>${clamp("a:" + e.id, e.text)}</div>`).join("") : `<p class="note">Noch keine Eintr\xE4ge.</p>`}</div>
  <div class="sec"><h3>\xC4nderungen</h3>${ui.changes?.leadId === l.id ? changesHtml(ui.changes) : `<button class="more" data-act="showChanges">Wer hat was ge\xE4ndert?</button>`}</div>
</div>`;
}
export function leadEditView(state) {
  const l = state.ui.leadId ? currentLead(state) : null;
  const d = l || { status: "neu", fit: 2, currentTool: "unbekannt", type: "Restaurant" };
  const f = (n, lab, ph = "", type = "text") => `<label>${lab}<input name="${n}" type="${type}" value="${esc(d[n] || "")}" placeholder="${esc(ph)}"></label>`;
  return `<div class="bar"><button class="link" data-act="back">Abbrechen</button><h2>${l ? "Bearbeiten" : "Neuer Betrieb"}</h2><button class="link" data-act="saveLead">Sichern</button></div>
<form class="wrap sub" id="form">
  ${f("name", "Name *")}
  <div class="two">${f("city", "Ort")}<label>Art<select name="type">${options(BUSINESS_TYPES, d.type)}</select></label></div>
  <label>Region<select name="region">${options([["", "automatisch aus Ort" + (d.city ? " (" + regionOf(d) + ")" : "")], ...REGIONS], d.region || "")}</select></label>
  <div class="two"><label>Status<select name="status">${options(STAGES, d.status)}</select></label><label>ICP-Fit<select name="fit">${options([[3, "\u2605\u2605\u2605 sehr gut"], [2, "\u2605\u2605 passt"], [1, "\u2605 fraglich"]], d.fit)}</select></label></div>
  <label id="lostReasonField"${d.status === "disqualifiziert" ? "" : " hidden"}>Grund *<select name="lostReason">${options([["", "Grund w\xE4hlen \u2026"], ...LOST_REASONS], d.lostReason || "")}</select></label>
  ${f("instagram", "Instagram", "@handle")}
  ${f("phone", "Telefon", "+43 \u2026", "tel")}
  ${f("email", "E-Mail", "name@betrieb.at", "email")}
  ${f("website", "Website", "https://", "url")}
  ${f("person", "Ansprechperson")}
  <label>Reserviert aktuell \xFCber<select name="currentTool">${options(RESERVATION_TOOLS, d.currentTool)}</select></label>
  ${f("hook", "Aufh\xE4nger", "z. B. Neuer\xF6ffnung")}
  <label>Notizen<textarea name="notes" rows="8">${esc(d.notes || "")}</textarea></label>
  <button class="primary full" data-act="saveLead">Speichern</button>
  ${l ? `<button class="danger full" data-act="deleteLead" style="margin-top:28px">Betrieb l\xF6schen</button>` : ""}
</form>`;
}
