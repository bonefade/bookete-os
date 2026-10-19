import { STAGES, STAGE_LABEL, OPT_OUT_REASON, LOST_REASONS, SPOKEN_REASONS, BUSINESS_TYPES, RESERVATION_TOOLS, CHANNELS, TEMPLATE_PURPOSES, PURPOSE_LABEL, SEQUENCE_POLICY, CALL_OUTCOMES, OUTCOME_LABEL, TRASH_SHOWN, FIELD_LABEL } from '../domain/constants.js';
import { actsOf, currentLead, icpOf, isReady, mailOpen, scoped, dueByTodo, regionCounts, toolCounts, contactCounts, callList, freshLeads, awaitsAnswer, todayQueue, queueList, roundList } from './selectors.js';
import { addDays, dayLabel, daysBetween, toDateString } from '../domain/dates.js';
import { channelLink } from './platform.js';
import { countTouches, hasReply, isReply, sequenceExhausted, nextActionHint, meetingDue, lastChannel, planAfterActivity, planAfterCall, callActivity, planMeeting, byTimeline } from '../domain/activity.js';
import { esc, fmtDate, fmtDateWithYear, relDate, options, describeChange, statusMove, actorName, fmtTime } from './format.js';
import { fold, searchTokens, searchLeads } from '../domain/search.js';
import { hitLabel, markRanges, markHtml, snippetHtml } from './search.js';
import { isPipeline, takesFollowUp, isDue, lacksNextStep, getsUnsubscribeLink, addressKey, optOutByAddress, mailClosedBy, addressOptOutText } from '../domain/lead.js';
import { lostBreakdown, templateUsage, weekNumbers } from '../domain/stats.js';
import { callScript } from '../domain/template.js';
import { REGIONS, regionOf } from '../domain/region.js';
import { SERVICE_KINDS, SERVICE_STATES, OWNERS, SYSTEMS, accountOf, showsAccount, handledBy } from '../domain/account.js';
import { todosOf } from '../domain/todos.js';
import { PHASES, PHASE_LABEL, CANCEL_REASONS, ONBOARDING, CHECK_IN, CHECK_IN_RESULTS, RESULT_LABEL, customerOf, onboardingOf, attentionOf } from '../domain/customer.js';

export const ICONS = {
  heute: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  betriebe: '<svg viewBox="0 0 24 24"><path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/></svg>',
  kunden: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6.5v5.5c0 4.2 3.2 7.4 7.5 8.5 4.3-1.1 7.5-4.3 7.5-8.5V6.5z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>',
  vorlagen: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
  mehr: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>'
};
export const TABS = [["heute", "Heute"], ["betriebe", "Betriebe"], ["kunden", "Kunden"], ["vorlagen", "Vorlagen"], ["mehr", "Mehr"]];
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
  // A customer's row says so: why it needs attention, else what its care is at.
  const care = l.status === "kunde" ? customerOf(l) : null;
  const tag = care && (attentionOf(care, today) || (care.phase === "onboarding" ? PHASE_LABEL.onboarding : l.nextStep === CHECK_IN ? CHECK_IN : STAGE_LABEL.kunde));
  // A todo due before (or on the day of) the next step is why the business is in the queue, after an answer to
  // write, an appointment to record and a customer's Achtung, which each say more.
  const todo = dueByTodo(l, today);
  const att = care && attentionOf(care, today);
  const [chip, why, go] = awaitsAnswer(state, l) ? [last.channel, quoted(last.text), "Antworten"]
    : meetingDue(l, today) ? ["Termin", `Wie war der Termin? \xB7 ${fmtDate(l.followUp)}`, "Ergebnis"]
    : att ? [att, nextActionHint(l, acts) || "", "\xD6ffnen"]
    : todo ? ["Todo", [todo.text, todo.due < today ? "f\xE4llig " + relDate(todo.due, today) : ""].filter(Boolean).join(" \xB7 "), "\xD6ffnen"]
    : lacksNextStep(l) ? ["Kein n\xE4chster Schritt", `${STAGE_LABEL[l.status]}${last ? `, zuletzt ${relDate(last.date, today)}` : ""}, nichts geplant`, "Planen"]
    : [tag || lastChannel(acts) || STAGE_LABEL[l.status], [nextActionHint(l, acts) || "Nachfassen", l.followUp < today ? "f\xE4llig " + relDate(l.followUp, today) : ""].filter(Boolean).join(" \xB7 "), "\xD6ffnen"];
  return `<li><button class="qrow" data-queue="${esc(l.id)}"><span class="q-name">${esc(l.name)}</span><span class="q-ch${go === "Planen" || att ? " none" : ""}">${esc(chip)}</span><span class="q-why">${esc(why)}</span><span class="q-go">${go} ›</span></button></li>`;
}
/** The best hours to reach a restaurant by phone, between lunch and dinner service. */
const CALL_HOURS = "Am besten 14:30–17:00 Uhr, Montag und Dienstag schw\xE4cher.";
/** Heute as one queue, worked from the top; on a wide screen the week, the next days and the new businesses beside it. */
export function todayView(state, today) {
  const q = todayQueue(state, today);
  const open = q.replies.length + q.attention.length + q.overdue.length + q.today.length;
  // Meine or Alle: whether the customers someone else looks after show too. Only where there are customers.
  const scope = state.data.leads.some((l) => l.status === "kunde") ? `<div class="chips">${[["0", "Meine"], ["1", "Alle"]].map(([k, label]) => `<button class="chip" data-hall="${k}" aria-pressed="${String(!!state.ui.hAll) === (k === "1" ? "true" : "false")}">${label}</button>`).join("")}</div>` : "";
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
    const on = leads.filter((l) => takesFollowUp(l) && l.followUp === d || todosOf(l).some((t) => !t.done && t.due === d));
    const meetings = on.filter((l) => l.followUp === d && /^Termin\b/.test(l.nextStep || "")).length;
    return on.length ? `<li>${esc(fmtDate(d))} \xB7 ${on.length} f\xE4llig${meetings ? `, ${meetings} Termin${meetings > 1 ? "e" : ""}` : ""}</li>` : "";
  }).join("");
  const fresh = freshLeads(state);
  const side = `${week}
  <div class="sec"><h3>N\xE4chste 7 Tage</h3>${days ? `<ul class="days card">${days}</ul>` : `<div class="empty">Nichts geplant.</div>`}</div>
  <div class="sec"><h3>Bereit zum Anschreiben <small>${fresh.length}</small></h3>${fresh.length ? `<p class="note" style="margin:0 0 8px">${fresh.length} ${fresh.length === 1 ? "neuer Betrieb" : "neue Betriebe"} ohne Kontakt, die besten zuerst.</p><button class="full" data-act="freshStart">Erstkontakte starten ›</button>` : `<div class="empty">Keine neuen Betriebe in dieser Auswahl.</div>`}</div>`;
  return `<div class="wrap wide">
  <div class="head"><div><h1>Heute</h1><p>${esc(date)}${state.ui.region !== "alle" ? " \xB7 " + esc(state.ui.region) : ""}${open ? ` \xB7 ${open} offen` : ""}</p></div>${open ? `<button class="primary" data-act="queueStart">Abarbeiten ›</button>` : ""}</div>
  ${filterBar(state, scope)}
  ${loadingOr(state, `<div class="today"><div class="t-main">
  ${open ? `<p class="note" style="margin:0 0 4px">Der Reihe nach von oben. Was Sie erledigen, verschwindet von der Liste.</p>` : `<div class="empty">Alles erledigt.</div>`}
  ${sec("Neue Antworten", `${q.replies.length} \xB7 halten die Nachfass-Folge an`, q.replies)}
  ${sec("Kunden: Achtung", q.attention.length, q.attention)}
  ${sec("\xDCberf\xE4llig", q.overdue.length, q.overdue)}
  ${sec("Heute f\xE4llig", q.today.length, q.today)}
  ${callSec}
  </div><aside class="t-side">${side}</aside></div>`)}
</div>`;
}
/** The Betriebe status filter: [value, label, test]. Offen is the pipeline. */
/** A customer's phase as chips, one tap each; `progress` names how far its onboarding is on the chip of its phase. */
const phaseChips = (c, progress = false) => PHASES.map(([k, label]) => `<button class="chip${k === "gekuendigt" ? " lostc" : ""}" data-phase="${k}" aria-pressed="${c.phase === k}">${esc(progress && c.phase === k ? phaseText(c) : label)}</button>`).join("");
/** How far a customer's onboarding is: "Onboarding 3/7", or its phase. */
const phaseText = (c) => c.phase === "onboarding" ? `${PHASE_LABEL.onboarding} ${c.steps.length}/${ONBOARDING.length}` : PHASE_LABEL[c.phase];
/**
 * The Kunden tab: every customer, by phase and by who looks after them; the next step due first, as Heute has it.
 * A row opens the customer's page.
 */
export function kundenView(state, today) {
  const { kPhase, kOwner } = state.ui;
  const me = state.me?.email;
  const all = state.data.leads.filter((l) => l.status === "kunde").map((l) => ({ l, c: customerOf(l) }));
  const inPhase = (x, p = kPhase) => p === "aktiv" ? x.c.phase !== "gekuendigt" : p === "achtung" ? !!attentionOf(x.c, today) : x.c.phase === p;
  const ownedBy = (x, o = kOwner) => o === "alle" || (o === "ich" ? x.c.owner === me : !x.c.owner);
  const list = all.filter((x) => inPhase(x) && ownedBy(x)).sort((a, b) => !!attentionOf(b.c, today) - !!attentionOf(a.c, today) || ((a.l.followUp || "9") < (b.l.followUp || "9") ? -1 : (a.l.followUp || "9") > (b.l.followUp || "9") ? 1 : a.l.name.localeCompare(b.l.name, "de")));
  const phases = [["aktiv", "Aktiv"], ["achtung", "Achtung"], ...PHASES].map(([k, label]) => [k, label, all.filter((x) => ownedBy(x) && inPhase(x, k)).length]);
  const owners = [["alle", "Alle"], ["ich", "Ich"], ["niemand", "Niemand"]].map(([k, label]) => [k, `Betreut: ${label}`, all.filter((x) => inPhase(x) && ownedBy(x, k)).length]);
  const row = ({ l, c }) => {
    const due = l.followUp && l.followUp <= today;
    const att = attentionOf(c, today);
    const why = [l.nextStep, l.followUp && relDate(l.followUp, today)].filter(Boolean).join(" \xB7 ") || (c.phase === "gekuendigt" ? c.cancelReason : "nichts geplant");
    return `<li${att ? ' class="att"' : ""}><button class="qrow" data-open="${esc(l.id)}"><span class="q-name">${esc(l.name)}${l.city ? ` <small>${esc(l.city)}</small>` : ""}</span><span class="q-ch${att ? " none" : ""}">${esc(att || phaseText(c))}</span><span class="q-why${due ? " due" : ""}">${esc(why)}</span><span class="q-go">${esc(c.owner ? actorName(c.owner) : "\u2013")} ›</span></button></li>`;
  };
  const active = all.filter((x) => x.c.phase !== "gekuendigt");
  return `<div class="wrap wide">
  <div class="head"><div><h1>Kunden</h1><p>${active.length} aktiv \xB7 ${active.filter((x) => x.c.phase === "onboarding").length} im Onboarding</p></div></div>
  <div class="toolbar">${filterSelect("kPhase", "Phase", phases, kPhase)}${filterSelect("kOwner", "Betreut von", owners, kOwner)}</div>
  ${loadingOr(state, list.length ? `<ul class="ltable">${list.map(row).join("")}</ul>` : `<div class="empty">${all.length ? "Niemand in dieser Ansicht." : "Noch keine Kunden. Wer Kunde wird, steht hier."}</div>`)}
</div>`;
}
export const STATUS_FILTERS = [["offen", "Offen", isPipeline], ...STAGES.map(([k, label]) => [k, label, (l) => l.status === k]), ["alle", "Alle", () => true]];
const CONTACTED = [["alle", "Kontaktiert: alle"], ["ja", "Kontaktiert: ja"], ["nein", "Kontaktiert: nein"]];
export const SORTS = {
  prio: (a, b) => b.fit - a.fit || ((a.followUp || "9") < (b.followUp || "9") ? -1 : 1) || a.name.localeCompare(b.name, "de"),
  nachfassen: (a, b) => ((a.followUp || "9") < (b.followUp || "9") ? -1 : (a.followUp || "9") > (b.followUp || "9") ? 1 : 0) || b.fit - a.fit,
  name: (a, b) => a.name.localeCompare(b.name, "de"),
  status: (a, b) => STAGES.findIndex(([k]) => k === b.status) - STAGES.findIndex(([k]) => k === a.status) || b.fit - a.fit
};
export function leadsView(state, today) {
  const { status, reason, contacted, q: typed, quick, sort } = state.ui;
  const q = typed.trim();
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
    <input type="search" id="q" placeholder="Liste filtern \u2026" value="${esc(typed)}" aria-label="Liste filtern">
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
/** The lead's fields to edit in place, by the card they show in: how to reach them, what a talk needs, the rest. */
export const QUICK_FIELDS = [
  { key: "person", group: "contact" },
  { key: "email", type: "email", group: "contact" },
  { key: "phone", type: "tel", group: "contact" },
  { key: "currentTool", options: () => RESERVATION_TOOLS, group: "talk" },
  { key: "hook", group: "talk" },
  { key: "fit", options: () => [[3, "★★★ sehr gut"], [2, "★★ passt"], [1, "★ fraglich"]], show: (l) => "★".repeat(l.fit || 2), group: "talk" },
  { key: "website", type: "url", group: "contact" },
  { key: "instagram", group: "contact" },
  { key: "city", group: "info" },
  { key: "region", options: () => [["", "automatisch"], ...REGIONS], show: (l) => regionOf(l) + (l.region ? "" : " (automatisch)"), group: "info" },
  { key: "type", options: () => BUSINESS_TYPES, group: "info" }
];
export function quickField(l, f, editing, draft = null) {
  const raw = l[f.key] ?? "";
  if (editing === f.key) {
    const value = draft ? draft.value : raw;
    const input = f.options ? `<select id="qe" data-field="${f.key}">${options(f.options(), value)}</select>` : `<input id="qe" data-field="${f.key}" type="${f.type || "text"}" value="${esc(value)}" autocomplete="off">`;
    return `<div class="fact editing"><dt>${FIELD_LABEL[f.key]}</dt><dd>${input}${changedMeanwhile(l, f.key, draft)}<div class="qe-actions"><button data-act="qeCancel">Abbrechen</button><button class="primary" data-act="qeSave">Speichern</button></div></dd></div>`;
  }
  const shown = f.show ? f.show(l) : raw;
  return `<div class="fact qe-click" data-edit="${f.key}" role="button" tabindex="0"><dt>${FIELD_LABEL[f.key]}</dt><dd>${shown ? esc(shown) : `<span class="qe-empty">+ hinzuf\xFCgen</span>`}</dd></div>`;
}
/** A quick edit's typed value is over what the field held then: if someone changed the field since, saving replaces that. */
const changedMeanwhile = (l, key, draft) => draft && String(l[key] ?? "") !== draft.from ? `<p class="hint">Inzwischen ge\xE4ndert. Speichern ersetzt den neuen Stand.</p>` : "";
/** A lead the page offers a call for, with the call sheet: one in the pipeline, open to contact, not at its appointment. */
const takesCall = (l, today) => isPipeline(l) && !l.optOutAt && !meetingDue(l, today);
/**
 * What the lead page holds open but can no longer draw, as the lead changed since (the other user, or a draft kept
 * from earlier): a call or Termin sheet once it takes no call, the meeting's outcome once none is due, a check-in once
 * not live, the "Kontaktiert" question once not Neu, a todo being changed once done or gone. Closed, so no input
 * nobody sees keeps the tabs shut.
 */
export function unshownSheets(state, today) {
  const l = currentLead(state), u = state.ui;
  if (!l) return {};
  const calls = takesCall(l, today);
  return {
    ...(!calls && (u.call || u.termin) && { call: null, termin: null }),
    ...(u.meeting && !meetingDue(l, today) && { meeting: null }),
    ...(u.checkIn && !(l.status === "kunde" && customerOf(l)?.phase === "live") && { checkIn: null }),
    ...(u.contactPick && l.status !== "neu" && { contactPick: null }),
    ...(u.todoEdit && !todosOf(l).some((t) => t.id === u.todoEdit.id && !t.done) && { todoEdit: null }),
  };
}
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
  return planPreview(l, () => {
    const input = callInput(call);
    return planAfterCall(l, acts, callActivity(input, today), input);
  });
}
/** What saving a lead patch that `plan` gives will do, or why it would be refused. */
function planPreview(l, plan) {
  let patch;
  try {
    patch = plan();
  } catch (e) {
    return e.message;
  }
  const status = patch.status || l.status;
  const [followUp, nextStep] = nextAfter(l, patch);
  const move = status === l.status ? `Status bleibt ${STAGE_LABEL[status]}` : `Status wird ${STAGE_LABEL[status]}${status === "disqualifiziert" ? ` (${patch.lostReason})` : ""}`;
  const next = status === "disqualifiziert" ? "kein n\xE4chster Schritt" : followUp ? `${FIELD_LABEL.nextStep} ${fmtDate(followUp)}${nextStep ? " \xB7 " + nextStep : ""}` : "";
  return `Beim Speichern: ${[move, next].filter(Boolean).join(" \xB7 ")}`;
}
/** The note a first contact is logged with when none is typed. */
export const contactText = (channel) => channel === "Vor Ort" ? "Vor Ort besucht" : `\xDCber ${channel} kontaktiert`;
/**
 * "Kontaktiert" on a new lead asks how: a call opens the call sheet and an e-mail the composer, each logging the
 * contact their own way; a visit or a message elsewhere is logged here, today, with a note if any. Logged, the
 * contact makes the lead Kontaktiert and plans its follow-up, as any first contact does.
 */
function contactPickHtml(l, acts, p, calls, today) {
  // A visit first: what a new lead's first contact most often is.
  const chips = ["Vor Ort", ...CHANNELS.filter((ch) => ch !== "Vor Ort")].map((ch) => ch === "Telefon" ? `<button class="chip" data-act="callOpen"${calls ? "" : " disabled"}>${ch}</button>`
    : ch === "E-Mail" ? `<button class="chip" data-compose="E-Mail"${l.email ? "" : " disabled"}>${ch}</button>`
    : `<button class="chip" data-cp="${esc(ch)}" aria-pressed="${p.channel === ch}">${esc(ch)}</button>`).join("");
  const activity = { direction: "out", channel: p.channel, date: today, createdAt: new Date().toISOString() };
  const after = p.channel ? afterLine(l, acts, activity, planAfterActivity(l, acts, activity, today), today) : "";
  const form = p.channel ? `<textarea id="cpText" rows="2" placeholder="${esc(contactText(p.channel))}">${esc(p.text)}</textarea>${after ? `<p class="note after">${esc(after)}</p>` : ""}` : "";
  return `<div class="card sec"><p style="margin:0 0 8px;font-weight:600">Wie war der Kontakt?</p><div class="chips">${chips}</div>${form}
    <div class="two" style="margin-top:8px"><button data-act="contactCancel">Abbrechen</button>${p.channel ? `<button class="primary" data-act="contactSave">Eintragen</button>` : ""}</div></div>`;
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
/** "Weitere": the moves beside the status chips: an appointment agreed, closing without an answer, the opt-out. */
function statusMenuHtml(l, acts, today) {
  const item = (act, title, sub, disabled = false) => `<button class="mitem" data-act="${act}"${disabled ? " disabled" : ""}><span><b>${title}</b><small>${sub}</small></span><span aria-hidden="true">›</span></button>`;
  return `<div class="card menu">
    ${takesCall(l, today) ? item("terminOpen", "Termin eintragen", `wird ${STAGE_LABEL.qualifiziert}`) : ""}
    ${l.status === "kontaktiert" ? item("closeWithoutReply", "Ohne Antwort abschlie\xDFen", `ab Kontakt ${SEQUENCE_POLICY.maxTouches} von ${SEQUENCE_POLICY.maxTouches}`, !sequenceExhausted(l, acts)) : ""}
    <button class="mitem danger" data-act="optOut"><span><b>Keine Kontaktaufnahme gew\xFCnscht</b></span></button>
  </div>`;
}
/**
 * The status as chips, one tap each: Disqualifiziert asks for the reason (and changes it on a lead closed already).
 * After an opt-out only Kunde and Disqualifiziert can be set, as the server holds. A Kunde has its phase beside it.
 */
function statusChipsHtml(l, customer, ui) {
  const lost = l.status === "disqualifiziert";
  const status = STAGES.map(([k, v]) => `<button class="chip${k === "disqualifiziert" ? " lostc" : ""}" data-status="${k}" aria-pressed="${l.status === k}"${l.optOutAt && isPipeline({ status: k }) ? " disabled" : ""}>${esc(v)}${k === "disqualifiziert" && lost ? " \xB7 " + esc(l.lostReason) : ""}</button>`).join("");
  const more = l.optOutAt ? "" : `<button class="link" data-act="statusMenu" aria-expanded="${!!ui.statusMenu}">Weitere ▾</button>`;
  const phases = customer ? `<div class="chips phchips"><span class="note">Phase</span>${phaseChips(customer, true)}</div>` : "";
  return `<div class="chips stchips" role="group" aria-label="${esc(FIELD_LABEL.status)}">${status}${more}</div>${phases}`;
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
/**
 * A Kunde's care on its page: who looks after it and its phase (also in the header), the check-ins once live, and
 * the onboarding as a checklist. The first open step
 * stands out with its buttons, and every other open step can be done or left out before it; a done one can be opened
 * again. Gekündigt shows the steps as they stood. A step without a day
 * belongs to a customer from before whose care is not stored yet.
 */
function customerHtml(state, l, c, today) {
  const me = state.me?.email;
  const team = [...new Set([...(state.me?.team || []), c.owner].filter(Boolean))];
  const owner = `<label class="owner">Betreut von<select id="kOwnerOf">${options([["", "\u2013"], ...team.map((e) => [e, actorName(e) + (e === me ? " (ich)" : "")])], c.owner)}</select></label>`;
  const steps = onboardingOf(c);
  // Steps can be ticked in every phase but Gekündigt: a customer from before, live already, ticks its list once.
  const open = c.phase !== "gekuendigt" ? steps.find((s) => !s.at) : null;
  const rows = steps.map((s) => {
    if (s.at) return `<li class="ok"><b>${esc(s.title)}${s.skipped ? " \xB7 entf\xE4llt" : ""}</b><small>${esc(fmtDate(s.at))} \xB7 ${esc(actorName(s.by))}${s.skipped && s.skipped !== "entf\xE4llt" ? " \xB7 " + esc(s.skipped) : ""}</small>${c.phase === "gekuendigt" ? "" : `<button class="more" data-step-undo="${s.id}">Wieder offen</button>`}</li>`;
    // Due days belong to the onboarding; once live, a step still open is no longer late.
    const late = c.phase === "onboarding" && s.due && s.due < today;
    const when = c.phase === "onboarding" && s.due ? `<small${late ? ' class="late"' : ""}>${late ? "f\xE4llig war " : ""}${esc(fmtDate(s.due))}</small>` : "";
    if (s === open) return `<li class="now"><b>${esc(s.title)}</b>${when}<div class="two"><button class="primary" data-step="${s.id}">Erledigt</button>${s.id === "live" ? "" : `<button data-skip="${s.id}">Entf\xE4llt \u2026</button>`}</div></li>`;
    // A later step can be done or left out before the first open one: the first open one stays the next step.
    const early = c.phase === "gekuendigt" ? "" : `<span class="early"><button class="more" data-step="${s.id}">Erledigt</button>${s.id === "live" ? "" : `<button class="more" data-skip="${s.id}">Entf\xE4llt \u2026</button>`}</span>`;
    return `<li class="todo"><b>${esc(s.title)}</b>${when}${early}</li>`;
  }).join("");
  const where = c.phase === "gekuendigt" ? ` \xB7 ${esc(c.cancelReason)}` : c.phase === "live" && c.liveAt ? ` seit ${esc(fmtDate(c.liveAt))}` : ` \xB7 Tag ${c.since ? Math.max(0, daysBetween(c.since, today)) : 0} von ${ONBOARDING.at(-1)[2]}`;
  const att = attentionOf(c, today);
  const onboarding = `<h3 style="margin-top:14px">Onboarding <small>${c.steps.length} von ${ONBOARDING.length}</small></h3><ol class="card checks">${rows}</ol>`;
  // Live: the check-ins first, the onboarding as it stood below them.
  return `<div class="sec cust"><h3>Kunde <small>${esc(PHASE_LABEL[c.phase])}${where}</small></h3>
    ${att ? `<p class="att-line">Achtung: ${esc(att)}</p>` : ""}
    <div class="card">${owner}<div class="chips">${phaseChips(c)}</div></div>
    ${c.phase === "live" ? checkInsHtml(c, state.ui.checkIn, today) + onboarding : onboarding}</div>`;
}
/** A live customer's check-ins: when the next is due, the form to enter one, and the last three. */
function checkInsHtml(c, form, today) {
  const late = c.nextCheckIn && c.nextCheckIn < today;
  const due = c.nextCheckIn ? `N\xE4chster Check-in <b${late ? ' class="late"' : ""}>${esc(fmtDate(c.nextCheckIn))}</b>` : "Kein Check-in geplant";
  const sheet = form ? `<div class="card sheet">
    <p style="margin:0 0 8px;font-weight:600">Wie l\xE4uft's?</p>
    <div class="chips">${CHECK_IN_RESULTS.map(([k, label]) => `<button class="chip${k === "unzufrieden" ? " lostc" : ""}" data-checkin-result="${k}" aria-pressed="${form.result === k}">${label}</button>`).join("")}</div>
    <label>Notiz <small>optional</small><textarea id="ciNote" rows="2">${esc(form.note || "")}</textarea></label>
    <label>N\xE4chster Check-in ${form.result === "unzufrieden" ? "" : "<small>leer: nach dem Rhythmus</small>"}<input type="date" id="ciNext" min="${esc(addDays(today, 1))}" value="${esc(form.next || "")}"></label>
    <div class="two" style="margin-top:8px"><button data-act="checkInCancel">Abbrechen</button><button class="primary" data-act="checkInSave"${form.result && (form.result !== "unzufrieden" || form.next) ? "" : " disabled"}>Speichern</button></div>
  </div>` : `<button class="full" data-act="checkInOpen">Check-in eintragen</button>`;
  const past = c.checkIns.slice(-3).reverse().map((x) => `<li class="ok"><b>${esc(RESULT_LABEL[x.result])}</b><small>${esc(fmtDate(x.at))} \xB7 ${esc(actorName(x.by))}${x.note ? " \xB7 " + esc(x.note) : ""}</small></li>`).join("");
  return `<h3 style="margin-top:14px">Check-ins <small>${c.checkIns.length}</small></h3>
    <div class="card"><p class="note" style="margin:0 0 8px">${due}</p>${sheet}${past ? `<ol class="checks" style="padding:4px 0 0">${past}</ol>` : ""}</div>`;
}
/**
 * The business's todos: the open ones by due day with a tick and a bin, and a tap on one to change its text or day;
 * a line to add one; the done ones folded.
 */
function todosHtml(l, ui, today) {
  const all = todosOf(l);
  const open = all.filter((t) => !t.done), done = all.filter((t) => t.done);
  const draft = ui.todoDraft || {};
  const editing = ui.todoEdit && all.find((t) => t.id === ui.todoEdit.id && !t.done) ? ui.todoEdit : null;
  const when = (t) => t.done ? `<small>erledigt ${esc(fmtDate(t.done))}</small>` : t.due ? `<small${t.due < today ? ' class="late"' : ""}>${t.due < today ? "f\xE4llig war " : ""}${esc(fmtDate(t.due))}</small>` : "";
  const row = (t) => editing?.id === t.id
    ? `<li class="edit"><div class="tadd"><input id="teText" value="${esc(editing.text)}" aria-label="Todo"><input type="date" id="teDue" value="${esc(editing.due)}" aria-label="F\xE4llig am"></div><div class="two" style="margin-top:6px"><button data-act="todoEditCancel">Abbrechen</button><button class="primary" data-act="todoSave">Speichern</button></div></li>`
    : `<li${t.done ? ' class="done"' : ""}><button class="tick" data-todo-${t.done ? "undo" : "done"}="${esc(t.id)}" aria-label="${t.done ? "Wieder offen" : "Erledigt"}">${t.done ? "\u2713" : ""}</button>${t.done ? `<span>${esc(t.text)}${when(t)}</span>` : `<button class="ttext" data-todo-edit="${esc(t.id)}">${esc(t.text)}${when(t)}</button>`}<button class="bin" data-todo-remove="${esc(t.id)}" aria-label="Todo l\xF6schen">\xD7</button></li>`;
  return `<div class="sec todos"><h3>Todos <small>${open.length ? `${open.length} offen` : "keine offen"}</small></h3><div class="card">
    ${open.length ? `<ul class="tlist">${open.map(row).join("")}</ul>` : ""}
    <div class="tadd"><input id="tdText" placeholder="Neues Todo \u2026" value="${esc(draft.text || "")}" aria-label="Neues Todo"><input type="date" id="tdDue" value="${esc(draft.due || "")}" aria-label="F\xE4llig am"><button class="primary" data-act="todoAdd"${(draft.text || "").trim() ? "" : " disabled"}>+</button></div>
    ${done.length ? `<button class="more" data-act="todosDoneToggle">${ui.todosDone ? "Erledigte ausblenden" : `${done.length} erledigt`}</button>${ui.todosDone ? `<ul class="tlist">${done.map(row).join("")}</ul>` : ""}` : ""}
  </div></div>`;
}
/**
 * The sequence on a wide screen, as a checklist: a row per day we made contact (as countTouches counts them), the
 * answer that stopped it, with what we would have done without it, and the contacts still to come.
 */
function sequenceHtml(l, acts, today) {
  if (l.status !== "kontaktiert") return "";
  const max = SEQUENCE_POLICY.maxTouches, cadence = SEQUENCE_POLICY.cadence;
  const sorted = [...acts].sort(byTimeline);
  const replyAt = sorted.findIndex(isReply);
  const reply = replyAt < 0 ? null : sorted[replyAt];
  // One row per day, with every contact of that day.
  const days = [];
  for (const a of replyAt < 0 ? sorted : sorted.slice(0, replyAt)) {
    const day = days.at(-1)?.date === a.date ? days.at(-1) : (days.push({ date: a.date, acts: [] }), days.at(-1));
    day.acts.push(a);
  }
  const n = days.length;
  const row = (done, title, sub, cls = "") => `<li class="${done ? "ok" : "todo"}${cls}"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</li>`;
  const how = (a) => a.outcome ? `Anruf \xB7 ${esc(OUTCOME_LABEL[a.outcome])}` : esc(a.channel);
  const rows = days.map((d, i) => row(true, `${i ? "Nachfassen" : "Erstkontakt"} \xB7 ${d.acts.map(how).join(", ")}`, esc(fmtDate(d.date))));
  if (reply) {
    // Without the answer the sequence would have gone on by its cadence from the last contact.
    const would = n && n < max ? `Ohne Antwort ginge es am ${esc(fmtDate(addDays(days.at(-1).date, cadence[Math.min(n - 1, cadence.length - 1)])))} weiter.` : "";
    const answer = reply.direction === "in" && !l.optOutAt ? (reply.mail?.threadId ? `<button data-act="reply" data-thread="${esc(reply.mail.threadId)}">Antworten</button>` : `<button data-compose="${esc(reply.channel)}">Antworten</button>`) : "";
    const termin = takesCall(l, today) ? `<button data-act="terminOpen">Termin eintragen</button>` : "";
    rows.push(`<li class="now"><b>${reply.direction === "in" ? `Antwort \xB7 ${esc(reply.channel)}` : how(reply)}</b><small>${esc(fmtDate(reply.date))}</small>${would ? `<small>${would}</small>` : ""}${answer || termin ? `<div class="two">${answer}${termin}</div>` : ""}</li>`);
  }
  for (let k = n + 1; k <= max; k++) {
    const sub = reply ? "angehalten" : k === n + 1 && l.followUp ? `f\xE4llig ${esc(fmtDate(l.followUp))}` : k === max ? "danach: Ohne Antwort abschlie\xDFen" : "";
    rows.push(row(false, `Kontakt ${k}`, sub));
  }
  const state = reply ? " \xB7 angehalten" : n >= max ? " \xB7 ohne Antwort" : "";
  return `<div class="sec desk seq"><h3>Nachfass-Folge <small>${Math.min(n, max)} von ${max}${state}</small></h3><ol class="card checks">${rows.join("")}</ol>${!reply && n >= max ? `<p class="note">Alle Kontakte ohne Antwort. Abschlie\xDFen?</p>` : ""}</div>`;
}
/**
 * The lead's feed, newest first: the notes pinned on top, mail grouped by its Gmail thread, single messages and
 * calls, and the status moves from the history as grey lines. The chips filter it by kind.
 */
function feedHtml(state, l, acts, today, clamp) {
  const ui = state.ui;
  const mine = (a) => !a.mail?.mailbox || a.mail.mailbox === state.me?.email;
  const kind = (a) => a.outcome || a.channel === "Telefon" ? "call" : a.channel === "E-Mail" ? "mail" : "msg";
  const count = { mail: acts.filter((a) => kind(a) === "mail").length, call: acts.filter((a) => kind(a) === "call").length, msg: acts.filter((a) => kind(a) === "msg").length, note: l.notes ? 1 : 0 };
  const f = ui.feed;
  const chips = `<div class="chips feedc">${[["alle", "Alle"], ["mail", "E-Mail"], ["call", "Anrufe"], ["msg", "Nachrichten"], ["note", "Notizen"]].map(([k, label]) => `<button class="chip" data-feed="${k}" aria-pressed="${f === k}">${label}${k === "alle" ? "" : ` <small>${count[k]}</small>`}</button>`).join("")}</div>`;
  const notes = `<div class="sec"><h3>${FIELD_LABEL.notes}</h3>${ui.editField === "notes" ? `<div class="card"><textarea id="qe" data-field="notes" rows="10">${esc(ui.editDraft ? ui.editDraft.value : l.notes || "")}</textarea>${changedMeanwhile(l, "notes", ui.editDraft)}<div class="qe-actions"><button data-act="qeCancel">Abbrechen</button><button class="primary" data-act="qeSave">Speichern</button></div></div>` : `<div class="card qe-click" data-edit="notes" role="button" tabindex="0">${l.notes ? clamp("notes", l.notes) : `<span class="qe-empty">+ Notiz hinzuf\xFCgen</span>`}</div>`}</div>`;
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
      <div class="two">${l.optOutAt ? "" : `<button data-act="reply" data-thread="${esc(last.mail.threadId)}">Antworten</button>`}${takesCall(l, today) ? `<button data-act="terminOpen">Termin eintragen</button>` : ""}</div></div>`;
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
  const part = q ? [["replies", "Neue Antworten"], ["attention", "Kunden: Achtung"], ["overdue", "\xDCberf\xE4llig"], ["today", "Heute f\xE4llig"]].find(([k]) => q[k].some((x) => x.id === l.id)) : null;
  const label = r.list === "calls" ? "Anrufliste" : r.list === "fresh" ? "Erstkontakte" : `Heute${part ? " \xB7 " + part[1] : ""}`;
  const later = state.ui.later ? `<div class="chips later"><button class="chip" data-later="1">Morgen</button><button class="chip" data-later="7">N\xE4chste Woche</button><input type="date" id="laterDate" min="${esc(addDays(today, 1))}" aria-label="Sp\xE4ter am"></div>` : "";
  return `<div class="l-round"><div class="qbar"><span class="q-pos"><b>${label}</b> \xB7 ${r.seen.length + 1} von ${r.seen.length + 1 + rest.length}</span>${takesFollowUp(l) || r.list === "queue" && dueByTodo(l, today) ? `<button class="link" data-act="later" aria-expanded="${!!state.ui.later}">Sp\xE4ter ▾</button>` : ""}<button class="primary" data-act="roundNext">Weiter ›</button></div>${later}</div>`;
}
export function detailView(state, today) {
  if (!isReady(state)) return loadingOr(state, "");
  const l = currentLead(state);
  const acts = actsOf(state, l.id);
  const ui = state.ui;
  const t = countTouches(acts);
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
  const customer = l.status === "kunde" ? customerOf(l) : null;
  const tel = channelLink(l, "Telefon");
  const act = (href, label, attrs = "") => href ? `<a class="btn" href="${esc(href)}"${href.startsWith("tel:") ? "" : ' target="_blank" rel="noopener"'}${attrs}>${label}</a>` : `<a class="btn" aria-disabled="true">${label}</a>`;
  const write = (channel, label, can) => `<button data-compose="${esc(channel)}"${can ? "" : " disabled"}>${label}</button>`;
  // On a phone the row sticks above the tabs; while the composer is open it has its own buttons.
  const actions = ui.compose ? "" : `<div class="acts">${act(l.optOutAt ? "" : tel, "Anrufen", calls ? ' data-act="callOpen"' : "")}${write("E-Mail", "E-Mail", !!l.email)}${write("WhatsApp", "WhatsApp", !l.optOutAt && !!channelLink(l, "WhatsApp"))}${write("Instagram", "Instagram", !l.optOutAt && !!l.instagram)}<button data-compose="in">Eintragen</button></div>`;
  const filled = QUICK_FIELDS.filter((f) => l[f.key] && f.key !== "fit" && f.key !== "type" && !(l.status === "kunde" && f.group === "talk")).map((f) => FIELD_LABEL[f.key]).slice(0, 4).join(", ");
  const infoOpen = ui.infoOpen || (ui.editField && ui.editField !== "notes");
  const sheet = calls && ui.termin ? terminHtml(l, ui.termin, today) : calls && (ui.call || ui.round?.list === "calls") ? callHtml(l, acts, ui, today, state.data.templates) : meetingDue(l, today) ? meetingHtml(ui, today) : "";
  const fields = (group) => QUICK_FIELDS.filter((f) => f.group === group).map((f) => quickField(l, f, ui.editField, ui.editDraft)).join("");
  // On a wide screen the name heads the page and the action row stands beside it; on a phone the top bar names it.
  return `<div class="bar lbar"><button class="link" data-act="back">‹ Zur\xFCck</button><h2>${esc(l.name)}</h2><button class="link" data-act="edit">Bearbeiten</button></div>
<div class="wrap lead">
  ${roundBar(state, l, today)}
  <div class="card hero">
    <div class="h-top">
    <h1 class="desk">${esc(l.name)}</h1>
    ${statusChipsHtml(l, customer, ui)}${l.website ? `<a class="note" href="${esc(l.website)}" target="_blank" rel="noopener">Website ↗</a>` : ""}
    <p class="note" style="margin:8px 0 0">${sub}</p>
    </div>
    ${actions}
    ${ui.statusMenu && !l.optOutAt ? statusMenuHtml(l, acts, today) : ""}
    ${nextStepHtml(l, acts, ui, today)}
  </div>
  <div class="l-top">
  ${l.optOutAt ? `<div class="card sec optout"><p style="margin:0;font-weight:600">M\xF6chte keine Nachrichten mehr</p><p class="note" style="margin:2px 0 8px">Opt-out seit ${esc(fmtDate(l.optOutAt))}. Keine Mails, DMs oder Anrufe. Nur aufheben, wenn der Betrieb sich selbst wieder meldet.</p><button class="more" data-act="clearOptOut">Opt-out aufheben</button></div>` : ""}
  ${customer && ui.cancelPick ? `<div class="card sec"><p style="margin:0 0 8px;font-weight:600">Warum gek\xFCndigt?</p><div class="chips">${CANCEL_REASONS.map((r) => `<button class="chip lostc" data-cancel="${esc(r)}">${esc(r)}</button>`).join("")}</div><button class="more" data-act="cancelPickClose">Abbrechen</button></div>` : ""}
  ${ui.contactPick ? contactPickHtml(l, acts, ui.contactPick, calls, today) : ""}
  ${ui.lostPick ? `<div class="card sec"><p style="margin:0 0 8px;font-weight:600">Warum disqualifiziert?</p><div class="chips">${(l.optOutAt ? [OPT_OUT_REASON] : LOST_REASONS).map((r) => `<button class="chip lostc" data-lost="${esc(r)}" aria-pressed="${l.lostReason === r}">${esc(r)}</button>`).join("")}</div><button class="more" data-act="lostCancel">Abbrechen</button></div>` : ""}
  ${sheet}
  ${ui.compose ? `<div class="sec">${composerHtml(state, l, acts, today, offersMailto)}</div>` : ""}
  </div>
  <aside class="l-side">
  <div class="sec infos${infoOpen ? " open" : ""}"><button class="ifold" data-act="infoToggle" aria-expanded="${!!infoOpen}">Infos${filled ? " \xB7 " + esc(filled) : ""} ${infoOpen ? "▴" : "▾"}</button><h3>Kontakt <small>zum Bearbeiten antippen</small></h3><dl class="card facts qe">${fields("contact")}</dl><h3>Infos</h3><dl class="card facts qe">${fields("info")}</dl></div>
  ${showsAccount(l) ? accountHtml(l, offersMailto) : ""}
  </aside>
  <div class="l-work">
  ${todosHtml(l, ui, today)}
  ${customer ? customerHtml(state, l, customer, today) : `<div class="sec talk"><h3>F\xFCr das Gespr\xE4ch</h3><dl class="card facts qe">${fields("talk")}</dl></div>
  ${sequenceHtml(l, acts, today)}`}
  </div>
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
/** An appointment agreed by mail, message or in person: its day as the next step, and no call logged. */
function terminHtml(l, t, today) {
  const preview = t.date ? planPreview(l, () => planMeeting(l, t, today)) : "";
  return `<div class="sec"><div class="card sheet">
    <h3>Termin mit ${esc(l.name)}</h3>
    <p class="note" style="margin:0 0 8px">Per E-Mail, Nachricht oder vor Ort vereinbart. Ein Termin am Telefon geht \xFCber \u201EAnrufen\u201C.</p>
    ${agreedFields(today, t)}
    ${preview ? `<p class="hint">${esc(preview)}</p>` : ""}
    <div class="two" style="margin-top:8px"><button data-act="terminCancel">Abbrechen</button><button class="primary" data-act="terminSave"${t.date ? "" : " disabled"}>Speichern</button></div>
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
