import { STAGE_LABEL, OPT_OUT_REASON } from '../domain/constants.js';
import { ValidationError } from '../domain/errors.js';
import { actsOf, currentLead, icpOf, isReady, roundList } from './selectors.js';
import { todosOf } from '../domain/todos.js';
import { notesOf } from '../domain/notes.js';
import { isDue, takesDate, isContact } from '../domain/lead.js';
import { addDays } from '../domain/dates.js';
import { copyText, channelLink, mailSubject, saveFile } from './platform.js';
import { createBackup } from '../domain/backup.js';
import { fillTemplate, defaultTemplate, DEFAULT_SCRIPT } from '../domain/template.js';
import { lastChannel } from '../domain/activity.js';
import { relDate, actorName } from './format.js';
import { PHASE_LABEL, customerOf } from '../domain/customer.js';
import { HOSTING_CARE, KIND_LABEL, ordersOf } from '../domain/orders.js';
import { TABS, tabBar, todayView, leadsView, kundenView, kontakteView, TALK_NOTE, searchResultsHtml, searchView, templatesView, templateEditView, moreView, detailView, leadEditView, accountEditView, callInput, unshownSheets, stepsEditOpen, VISIT_NOTE } from './views.js';

export const UI_ONLY_ACTIONS = new Set(["qeCancel", "back", "edit", "accountEdit", "quick", "quickCancel", "composeCancel", "composeFu", "reply", "copyOpen", "lostCancel", "contactCancel", "cancelPickClose", "checkInOpen", "checkInCancel", "statusMenu", "todosDoneToggle", "todoEditCancel", "stepsEditToggle", "stepEditCancel", "orderNew", "orderCancel", "noteEditCancel", "logMenu", "visitOpen", "talkOpen", "nextEdit", "infoToggle", "changesToggle", "callOpen", "terminOpen", "terminCancel", "callCancel", "meetingCancel", "callStart", "queueStart", "freshStart", "roundNext", "later", "scriptToggle", "tplNew", "icpEdit", "icpCancel", "searchClose", "toSearch", "importPick", "logoutAll"]);
/**
 * Every screen has an address (`#/betriebe`, `#/betrieb/<id>`, …), so the browser's Back, a reload and a shared
 * link all land on it. Hash addresses need no server route. The address decides tab, view and record; what a
 * screen has open on top (compose, reason picker, quick edit) stays out of it. `#/todos`, from before Heute took in
 * the Todos, lands on Heute as any unknown tab does.
 */
export function routeOf({ tab, view, leadId, templateId }) {
  const id = (x) => encodeURIComponent(x);
  // A record opened from Kontakte is at #/kontakt/…, so Back and a reload land in Kontakte.
  const at = tab === "kontakte" ? `#/kontakt/${id(leadId)}` : `#/betrieb/${id(leadId)}`;
  if (view === "detail") return at;
  if (view === "editLead") return `${at}/bearbeiten`;
  if (view === "editAccount") return `${at}/${tab === "kontakte" ? "personen" : "kunde"}`;
  if (view === "editTemplate") return templateId ? `#/vorlage/${id(templateId)}` : "#/vorlage/neu";
  return `#/${tab}`;
}
export function parseRoute(hash) {
  let parts;
  try {
    parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  } catch {
    parts = [];
  }
  const [a, b, c] = parts;
  if (a === "betrieb" && b) return { view: { bearbeiten: "editLead", kunde: "editAccount" }[c] || "detail", leadId: b };
  if (a === "kontakt" && b) return { view: { bearbeiten: "editLead", personen: "editAccount" }[c] || "detail", leadId: b, tab: "kontakte" };
  // A template belongs to Vorlagen, so one opened from a link or a reload goes back there.
  if (a === "vorlage" && b) return { view: "editTemplate", templateId: b === "neu" ? null : b, tab: "vorlagen" };
  return { view: null, tab: TABS.some(([k]) => k === a) ? a : "heute" };
}
const LEAD_VIEWS = new Set(["detail", "editLead", "editAccount"]);
/** The quick-add form's fields and the draft key each one types into; the draft outlives any redraw of the list. */
const QUICK_ADD_FIELDS = { qaName: "name", qaCity: "city", qaIg: "instagram", qaHook: "hook", qaTopic: "topic" };
/** The call and meeting sheets' fields and the key of the sheet's state each one fills. */
const AGREED_FIELDS = { agDate: "date", agTime: "time", agReason: "reason", agNote: "note" };
/** The open sheet the agreed fields belong to. */
const sheetKey = (ui) => ui.termin ? "termin" : ui.meeting ? "meeting" : "call";
/** The phone layout of index.html: the action row fixed at the bottom, above the tabs. */
const PHONE_LAYOUT = "(max-width:759px),(max-height:479px)";
const FORM_VIEWS = new Set(["editLead", "editTemplate", "editAccount"]);
/** A screen holding input not yet saved: search stays shut there, so that it cannot leave the screen by accident. */
// The call sheet holds input once an outcome is picked: its fields show only then.
const holdsInput = (u) => FORM_VIEWS.has(u.view) || !!(u.compose || u.editField || u.call?.outcome || u.termin || u.checkIn || u.todoDraft?.text?.trim() || u.todoEdit || u.stepDraft?.text?.trim() || u.stepEdit || u.orderEdit || u.noteDraft?.trim() || u.noteEdit || u.meeting || u.contactPick || u.quick || u.icpEdit);
/**
 * What a lead page holds open and not yet saved: the composer, the sheets, a todo, a quick edit with what is typed
 * in it. It belongs to its lead until saved or cancelled: leaving the page keeps it in `ui.drafts` under the lead's
 * id, coming back opens it again, and the device keeps all of them (draftsOf), through a reload or the phone
 * dropping the page.
 */
/** The fields of the Auftrag form by input, kept as typed in `ui.orderEdit`. */
const ORDER_INPUTS = { oTitle: "title", oAmount: "amount", oRhythm: "rhythm", oSigned: "signedAt", oStart: "start", oMonths: "months", oContract: "contract", oNote: "note" };
const DRAFT_KEYS = ["compose", "call", "termin", "meeting", "checkIn", "contactPick", "todoDraft", "todoEdit", "stepDraft", "stepEdit", "orderEdit", "noteDraft", "noteEdit", "editField", "editDraft"];
function draftOf(ui) {
  const open = DRAFT_KEYS.filter((k) => ui[k]);
  return open.length ? Object.fromEntries(open.map((k) => [k, ui[k]])) : null;
}
/** Every lead's draft, the one on screen included, without those of leads gone once the data is there. */
export function draftsOf(st) {
  const u = st.ui;
  const all = { ...u.drafts, ...(LEAD_VIEWS.has(u.view) && u.leadId && { [u.leadId]: draftOf(u) }) };
  const known = isReady(st) && new Set(st.data.leads.map((l) => l.id));
  return Object.fromEntries(Object.entries(all).filter(([id, d]) => d && (!known || known.has(id))));
}
/**
 * The UI state for an address. What a lead page has open lasts only while that lead is on screen: leaving it, or
 * opening another, starts fresh. The quick-add and ICP forms close on any address, as they show on their tab only;
 * so does the search over the screen.
 * Mehr starts with the Papierkorb closed so it is never shown stale. A round through a list lasts from lead to lead
 * and ends on a tab.
 */
export function enterRoute(ui, route) {
  const sameLead = LEAD_VIEWS.has(route.view) && LEAD_VIEWS.has(ui.view) && ui.leadId === route.leadId;
  let page = {};
  if (!sameLead) {
    // The draft of the lead left goes to `drafts`; the one of the lead opened comes back out of it onto the page.
    const drafts = { ...ui.drafts };
    if (LEAD_VIEWS.has(ui.view) && ui.leadId) drafts[ui.leadId] = draftOf(ui);
    const opened = LEAD_VIEWS.has(route.view) && drafts[route.leadId];
    if (opened) delete drafts[route.leadId];
    page = { ...Object.fromEntries(DRAFT_KEYS.map((k) => [k, null])), ...opened, drafts: Object.fromEntries(Object.entries(drafts).filter(([, d]) => d)), lostPick: false, cancelPick: false, todosDone: false, stepsEdit: false, changes: null, expanded: new Set(), statusMenu: false, logMenu: false, nextEdit: false, infoOpen: false, feed: "alle", changesOpen: false, later: false };
  }
  const next = { ...ui, ...route, quick: false, icpEdit: false, searchOpen: false, ...page };
  if (route.view) return next;
  return { ...next, round: null, ...(route.tab === "mehr" && ui.tab !== "mehr" && { trash: null }) };
}
/** A screen whose record is not there once the data has loaded: a deleted lead or template, or a wrong address. */
export function recordMissing(st) {
  if (!isReady(st)) return false;
  const { view, leadId, templateId } = st.ui;
  if (view === "detail" || view === "editAccount" || view === "editLead" && leadId) return !currentLead(st);
  if (view === "editTemplate" && templateId) return !st.data.templates.some((t) => t.id === templateId);
  return false;
}
/**
 * Moving between addresses. Our own history entries carry how many of ours lead up to them (the page's first entry
 * carries none), so leaving a screen steps back through them instead of adding a second copy of the screen before.
 * The open search has an entry of its own, at the address of the screen under it, so Back closes it first.
 */
export function createNavigation(history, location, applyRoute) {
  const depth = () => history.state?.crm || 0;
  // history.go lands later; until then the state is still this screen's, so a second leave would step back again.
  let leaving = false;
  /**
   * A new history entry, or with `replace` one in place of the current entry, which keeps its depth. The search's
   * entry gives way to the screen opened from it, so Back from there skips the search.
   */
  const go = (route, { replace = false } = {}) => {
    const overSearch = !!history.state?.search;
    // The screen under the search, asked for again: a step back off the search's entry shows it, with no second copy.
    if (overSearch && route === location.hash) return leave(route);
    if (overSearch || route !== location.hash) replace || overSearch ? history.replaceState(overSearch ? { crm: depth() } : history.state, "", route) : history.pushState({ crm: depth() + 1 }, "", route);
    applyRoute();
  };
  /** The entry of the search, opened over the screen at this address. */
  const pushSearch = () => history.pushState({ crm: depth() + 1, search: true }, "", location.hash);
  /** Leaves this screen for the one `steps` up: back through our own entries when they are there, else in place of this one. */
  const leave = (route, steps = 1) => {
    if (leaving) return;
    if (depth() < steps) return go(route, { replace: true });
    leaving = true;
    history.go(-steps);
  };
  /** The browser's popstate: a step back of ours, or the browser's own Back and Forward, has landed. */
  const landed = () => {
    leaving = false;
    applyRoute();
  };
  return { go, leave, landed, pushSearch };
}
/** Where the in-app Zurück leads when there is no earlier screen of ours to go back to: the screen above. */
export const backRoute = (ui) => ui.view === "editLead" || ui.view === "editAccount" ? routeOf({ tab: ui.tab, view: "detail", leadId: ui.leadId }) : routeOf({ tab: ui.tab });
/**
 * The Kundenakte form as the parts of an account: rows by index, without those marked to remove and without a new
 * row left empty.
 */
export function accountInput(elements) {
  const rows = { contacts: [] };
  const systems = {};
  const dropped = new Set();
  for (const el of elements) {
    const [part, a, b] = (el.name || "").split(".");
    if (part === "systems") {
      if (b) (systems[a] ||= {})[b] = el.value;
      else systems[a] = el.value;
    } else if (rows[part] && b === "drop") {
      if (el.checked) dropped.add(`${part}.${a}`);
    } else if (rows[part] && b) (rows[part][a] ||= {})[b] = el.value;
  }
  const keep = (part) => rows[part].filter((r, i) => r && !dropped.has(`${part}.${i}`) && (r.id || Object.values(r).some((v) => v !== "")));
  return { contacts: keep("contacts"), systems };
}
/**
 * A form's fields by name. With `onlyChanged`, only those whose value differs from what the form showed when
 * it opened, so saving cannot undo someone else's edit to a field this user never touched.
 */
export function formInput(elements, onlyChanged) {
  const input = {};
  for (const el of elements) {
    if (!el.name) continue;
    const shown = el.options ? ([...el.options].find((o) => o.defaultSelected) ?? el.options[0])?.value : el.defaultValue;
    if (!onlyChanged || el.value !== shown) input[el.name] = el.value;
  }
  return input;
}
/**
 * Saves the lead form: an update of the lead it was opened for, by id, even if that lead is gone from this
 * browser's state by now (the server then answers "Betrieb nicht gefunden"); a new lead only from the empty form.
 */
export async function saveLeadForm(uc, leadId, elements) {
  if (!leadId) return uc.addLead(formInput(elements, false));
  await uc.updateLead({ id: leadId }, formInput(elements, true));
  return leadId;
}
/** A reason picked in the lead view: disqualifies with it in one write, or changes the reason of a lead already disqualified. */
export function pickLostReason(uc, lead, reason) {
  return lead.status === "disqualifiziert" ? uc.setLostReason(lead, reason) : uc.changeStatus(lead, "disqualifiziert", reason);
}
const confirmOptOut = (lead) => confirm(`\u201E${lead.name}\u201C m\xF6chte keine Nachrichten mehr?

Der Betrieb wird geschlossen und jede weitere Nachricht blockiert.`);
/**
 * `deviceDrafts` keeps the drafts on this device (read, write; null clears), so they outlast the page. Signing out
 * clears them, as the next to sign in here may be someone else.
 */
export function mountApp({ root, tabsEl, searchEl, searchBox, toastEl, store: store2, clock, deviceDrafts = { read: () => null, write() {} } }) {
  let uc = null;
  const S = () => store2.get();
  const ui = (p) => store2.ui(p);
  store2.ui({ drafts: deviceDrafts.read() || {} });
  let kept = JSON.stringify(draftsOf(S()));
  store2.subscribe((st) => {
    const drafts = draftsOf(st);
    const json = JSON.stringify(drafts);
    if (json === kept) return;
    kept = json;
    deviceDrafts.write(Object.keys(drafts).length ? drafts : null);
  });
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    clearTimeout(toastEl._h);
    toastEl._h = setTimeout(() => toastEl.classList.remove("on"), 2e3);
  }
  async function run(fn, okMsg, failMsg = "Speichern fehlgeschlagen") {
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
      return r;
    } catch (e) {
      toast(e instanceof ValidationError ? e.message : failMsg);
      if (!(e instanceof ValidationError)) console.error(e);
      return void 0;
    }
  }
  let pending = false;
  /** Draws the current screen; false when there was none to draw and it went to the tab instead. */
  /** Search and the tabs shut while the screen holds input not yet saved, so neither can leave it by accident. */
  function lockForInput(st, today) {
    searchEl.disabled = holdsInput(st.ui);
    tabsEl.innerHTML = tabBar(st, today, holdsInput(st.ui));
  }
  function render() {
    const today = clock.today();
    const unshown = unshownSheets(S(), today);
    if (Object.keys(unshown).length) ui(unshown);
    const st = S();
    const view = st.ui.view;
    if (recordMissing(st)) return go(routeOf({ tab: st.ui.tab }), { replace: true }), false;
    lockForInput(st, today);
    drawSearch(st);
    root.innerHTML = view === "detail" ? detailView(st, today) : view === "editLead" ? leadEditView(st) : view === "editTemplate" ? templateEditView(st) : view === "editAccount" ? accountEditView(st) : { heute: todayView, betriebe: leadsView, kunden: kundenView, kontakte: kontakteView, vorlagen: templatesView, mehr: moreView }[st.ui.tab](st, today);
    // The tabs show on every screen; while a form holds input they are shut, as the search field is, so nothing typed is lost.

    if (view === "detail") loadHistory(st);
    if (st.ui.compose?.channel === "E-Mail" && st.caps.gmail) loadSignature();
    return true;
  }
  // The lead whose history is on its way, as id@updatedAt, so a redraw meanwhile asks for it only once.
  let historyLoading = null;
  /** The lead page's history (status moves in the feed, Änderungen), loaded on open and again after each write to the lead. */
  function loadHistory(st) {
    const lead = uc && currentLead(st);
    const key = lead && lead.id + "@" + lead.updatedAt;
    if (!lead || st.ui.changes?.leadId === lead.id && st.ui.changes.at === lead.updatedAt || historyLoading === key) return;
    historyLoading = key;
    uc.history(lead).catch((e) => {
      console.error(e);
      toast("Laden fehlgeschlagen");
      return null;
    }).then((rows) => {
      if (historyLoading === key) historyLoading = null;
      if (S().ui.leadId !== lead.id) return;
      // Failed, it stays `rows: null` until the lead changes, so the page does not ask again on every redraw.
      ui({ changes: { leadId: lead.id, at: lead.updatedAt, rows } });
      safeRender();
    });
  }
  let signatureLoading = false;
  /**
   * The user's Gmail signature for the composer's preview, once per page: `ui.signature` is { has, text } (use case
   * `signature`), null when the grant cannot read it, or { failed } (sending reads it again).
   */
  function loadSignature() {
    if (S().ui.signature !== undefined || signatureLoading) return;
    signatureLoading = true;
    uc.signature().catch((e) => {
      console.error(e);
      return { failed: true };
    }).then((signature) => {
      signatureLoading = false;
      ui({ signature });
      safeRender();
    });
  }
  function safeRender() {
    const a = document.activeElement;
    const v = S().ui.view;
    // An open form is never redrawn under the user; one still waiting for its data is.
    if (FORM_VIEWS.has(v) && root.querySelector("form")) return;
    if (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      pending = true;
      return;
    }
    const y = window.scrollY;
    if (render()) window.scrollTo(0, y);
  }
  // App forms are saved by their buttons' actions; only forms with an action (sign-out) really submit.
  // No inline onsubmit: the Content-Security-Policy blocks inline handlers.
  root.addEventListener("submit", (ev) => {
    if (!ev.target.hasAttribute("action")) ev.preventDefault();
    else if (ev.target.getAttribute("action").startsWith("/auth/logout")) deviceDrafts.write(null);
  });
  root.addEventListener("focusout", () => {
    if (pending) {
      pending = false;
      setTimeout(safeRender, 300);
    }
  });
  const saveScroll = () => {
    const u = S().ui;
    if (!u.view) ui({ scroll: { ...u.scroll, [u.tab]: window.scrollY } });
  };
  const show = (patch, y = 0) => {
    store2.ui(patch);
    if (render()) window.scrollTo(0, y);
  };
  // The address whose screen shows, so a step onto or off the search's entry, which has the same address, leaves it as it is.
  let shown = null;
  /**
   * Shows the screen of the current address, and the search on the search's entry. On the address already on screen
   * only a step onto or off the search's entry lands (Back, Forward, a step back of ours): the screen stays as it is.
   */
  function applyRoute() {
    const onSearch = !!history.state?.search;
    if (location.hash === shown) {
      // Forward onto the search's entry over a form holding input steps off it again: the search stays shut, as by every other way in.
      if (onSearch && holdsInput(S().ui)) return leave(location.hash);
      if (onSearch !== S().ui.searchOpen) setSearch(onSearch);
      return;
    }
    const route = parseRoute(location.hash);
    // A lead page opened by a link or a reload was opened from no tab: it belongs to Betriebe (a Kontakt's address
    // names Kontakte), as a template to Vorlagen.
    if (shown === null && LEAD_VIEWS.has(route.view)) route.tab ||= "betriebe";
    shown = location.hash;
    saveScroll();
    const next = enterRoute(S().ui, route);
    show(next, next.view ? 0 : next.scroll[next.tab] || 0);
    if (onSearch) setSearch(true);
  }
  const { go, leave, landed, pushSearch } = createNavigation(history, location, applyRoute);
  history.scrollRestoration = "manual";
  window.addEventListener("popstate", landed);
  const goTab = (tab) => go(routeOf({ tab }));
  /** The search over the current screen, which stays as it is under it, and the field's query while it shows. */
  function drawSearch(st = S()) {
    // The field shows the query only while the search is open, so a screen never looks filtered by it.
    searchEl.value = st.ui.searchOpen ? st.ui.gq : "";
    searchBox.hidden = !st.ui.searchOpen;
    // The screen under the search takes no focus and no keys, so Tab moves through the search and the tabs only.
    root.inert = st.ui.searchOpen;
    const results = searchBox.querySelector("#sres");
    // Once open, only the results are drawn again, so the list keeps its scroll position through a sync.
    if (st.ui.searchOpen && results) results.innerHTML = searchResultsHtml(st, clock.today());
    else searchBox.innerHTML = st.ui.searchOpen ? searchView(st, clock.today()) : "";
  }
  /** Opens or closes the search; each time it opens it starts over: with `q`, or with the recently changed leads. */
  const setSearch = (open, q = "") => {
    ui({ searchOpen: open, gq: open ? q : "", sIdx: 0 });
    drawSearch();
  };
  /** Opens the search unless a form holds input; whether it is open now. */
  const showSearch = (q = "") => {
    const u = S().ui;
    if (!u.searchOpen && !holdsInput(u)) {
      setSearch(true, q);
      pushSearch();
    }
    return S().ui.searchOpen;
  };
  /** Closes the search by stepping back off its entry, as the browser's Back does. */
  const closeSearch = () => leave(location.hash);
  const openSearch = (q) => {
    if (!showSearch(q)) return false;
    searchEl.focus();
    searchEl.select();
    return true;
  };
  // A click opens it, focus alone does not: Tab, or coming back to the window, lands on the field without meaning to search.
  searchEl.addEventListener("click", () => showSearch());
  function moveSelection(delta) {
    const rows = searchBox.querySelectorAll("#sres .srow");
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, S().ui.sIdx + delta));
    ui({ sIdx: i });
    rows.forEach((r, k) => r.classList.toggle("act", k === i));
    rows[i].scrollIntoView({ block: "nearest" });
  }
  document.addEventListener("keydown", (ev) => {
    const t = ev.target;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    const cmdK = (ev.key === "k" || ev.key === "K") && (ev.metaKey || ev.ctrlKey) && !ev.altKey;
    const slash = ev.key === "/" && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey;
    // Where no search can open, the key keeps its own meaning: Ctrl+K in a text field, the browser's elsewhere.
    if ((cmdK || slash) && openSearch()) ev.preventDefault();
  });
  const back = () => leave(backRoute(S().ui));
  const openLead = (id) => go(routeOf({ tab: S().ui.tab, view: "detail", leadId: id }));
  /** A lead picked in the search; it ends a round, as leaving the round for a tab does. */
  const openResult = (id) => {
    ui({ round: null });
    openLead(id);
  };
  /**
   * A round through a list (Heute's queue, the call list, the new businesses), from its top or from the lead `id`
   * picked in it: those above it count as done, so Weiter goes on below it.
   */
  const startRound = (list, id = null) => {
    const all = roundList(S(), clock.today(), list);
    const i = id ? Math.max(0, all.findIndex((l) => l.id === id)) : 0;
    if (!all[i]) return toast("Niemand in der Liste");
    ui({ round: { list, seen: all.slice(0, i).map((l) => l.id) } });
    openLead(all[i].id);
  };
  /**
   * The next lead of the round, freshly computed: one dealt with has dropped out, one seen in this round is skipped.
   * In place of this page, so Zurück ends the round.
   */
  function roundNext() {
    const st = S();
    const seen = [...st.ui.round.seen, st.ui.leadId];
    const next = roundList(st, clock.today(), st.ui.round.list).find((l) => !seen.includes(l.id));
    if (!next) return toast("Liste erledigt"), back();
    ui({ round: { ...st.ui.round, seen } });
    go(routeOf({ tab: S().ui.tab, view: "detail", leadId: next.id }), { replace: true });
  }
  /**
   * "Später" in a round: whatever puts the business on today's list moves to `date`, so it leaves it. In Heute, each
   * todo due and the next step if it is due (or, with neither, the next step); in a round of calls or first
   * contacts, the next step, which is what put it there.
   */
  async function postpone(date) {
    const lead = currentLead(S());
    const today = clock.today();
    const todos = S().ui.round?.list === "queue" ? todosOf(lead).filter((t) => !t.done && t.due && t.due <= today) : [];
    const followUp = takesDate(lead) && (!todos.length || isDue(lead, today));
    const later = async () => {
      for (const t of todos) await uc.changeTodo(lead, { todo: t.id, due: date });
      if (followUp) await uc.setFollowUp(lead, date);
      return true;
    };
    if (await run(later, "Sp\xE4ter: " + relDate(date, today)) === undefined) return;
    ui({ later: false });
    roundNext();
  }
  const openTemplate = (id) => go(routeOf({ view: "editTemplate", templateId: id }));
  /** A page of the Papierkorb: the newest, or those deleted before `before`. */
  const loadTrash = (before = null) => run(async () => {
    ui({ trash: await uc.trash(before), trashBefore: before });
    render();
  }, null, "Laden fehlgeschlagen");
  /**
   * Opens the composer: "out" to write (on an opted-out lead, who gets no message, "in" instead), "in" to enter what
   * came in. `channel` defaults to the last one used; from a mail thread (`thread`) the answer goes by mail as "Re: …".
   */
  function startCompose(direction, channel = null, thread = null) {
    const st = S();
    const lead = currentLead(st);
    const acts = actsOf(st, lead.id);
    const mode = direction === "out" && lead.optOutAt ? "in" : direction;
    const tpl = mode === "out" ? defaultTemplate(lead, acts, st.data.templates) : null;
    const filled = tpl ? fillTemplate(tpl.body, lead) : { text: "", missing: [] };
    const subject = thread ? (/^re:/i.test(thread.subject) ? thread.subject : "Re: " + thread.subject) : mailSubject(lead);
    ui({ compose: { direction: mode, templateId: tpl?.id || "", channel: channel || lastChannel(acts) || (lead.instagram ? "Instagram" : "E-Mail"), date: clock.today(), subject, text: filled.text, missing: filled.missing, thread, followUp: null, fuEdit: false }, call: null, termin: null, contactPick: null, statusMenu: false, logMenu: false });
    render();
    // The composer opens above; on a phone the buttons are at the bottom, so it comes into view, with its title on top.
    reveal(".compose");
  }
  /** Closes the composer after a save, then sets the follow-up picked under "Danach" where the save planned another. */
  async function composeSaved(c) {
    ui({ compose: null });
    render();
    const lead = currentLead(S());
    if (c.followUp && lead && lead.followUp !== c.followUp) await run(() => uc.setFollowUp(lead, c.followUp), "Nachfassen " + relDate(c.followUp, clock.today()));
  }
  async function logCall(lead, call) {
    const today = clock.today();
    const r = await run(() => uc.logCall(lead, call), ({ plan }) => plan.status === "disqualifiziert" ? "Eingetragen \xB7 Disqualifiziert" : plan.followUp ? "Eingetragen \xB7 wieder " + relDate(plan.followUp, today) : "Eingetragen");
    if (!r) return;
    ui({ call: null });
    // In the call list's round, saving moves on to the next call.
    if (S().ui.round?.list === "calls") return roundNext();
    render();
  }
  /**
   * A form just opened comes into view, with its title on top, on a phone only (the owner's call), where the buttons
   * sit at the bottom, and only when it is out of view. On a laptop the page stays where it is.
   */
  function reveal(selector) {
    const el = root.querySelector(selector);
    const box = el?.getBoundingClientRect?.();
    const phone = window.matchMedia?.(PHONE_LAYOUT).matches;
    if (phone && box && (box.top < 0 || box.top > window.innerHeight - 200)) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  async function saveTermin(lead, { date, time }) {
    if (await run(() => uc.scheduleMeeting(lead, { date, time: time || undefined }), "Termin eingetragen") !== undefined) {
      ui({ termin: null });
      render();
    }
  }
  async function saveMeeting(lead, meeting) {
    if (await run(() => uc.meetingOutcome(lead, meeting), meeting.result === "kunde" ? "Status: Kunde" : "Eingetragen") !== undefined) {
      ui({ meeting: null });
      render();
    }
  }
  /** Sets an open sheet's state (`call`, `termin`, `meeting`, `compose`) and draws the page again. */
  const sheet = (key, patch) => {
    ui({ [key]: { ...S().ui[key], ...patch } });
    render();
  };
  async function saveQuickEdit() {
    const x = root.querySelector("#qe");
    const lead = currentLead(S());
    if (!x || !lead) return;
    const changed = await run(() => uc.updateField(lead, x.dataset.field, x.value));
    if (changed === void 0) {
      x.focus();
      return;
    }
    if (changed) toast("Gespeichert");
    ui({ editField: null, editDraft: null });
    render();
  }
  searchEl.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      moveSelection(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const row = searchBox.querySelectorAll("#sres .srow")[S().ui.sIdx];
      if (row && searchEl.value.trim()) {
        searchEl.blur();
        openResult(row.dataset.open);
      }
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      if (searchEl.value) {
        searchEl.value = "";
        ui({ gq: "", sIdx: 0 });
        drawSearch();
      } else {
        // Shut already, as after Back or Tab into the field, Escape only leaves the field: closing steps back in history.
        if (S().ui.searchOpen) closeSearch();
        searchEl.blur();
      }
    }
  });
  searchEl.addEventListener("input", () => {
    // Typing while the search is shut, as after Back with the field still focused, opens it with what is typed.
    if (!S().ui.searchOpen) return showSearch(searchEl.value);
    ui({ gq: searchEl.value, sIdx: 0 });
    drawSearch();
  });
  root.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.edit && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      t.click();
      return;
    }
    if (t.id !== "qe") return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ui({ editField: null, editDraft: null });
      render();
    } else if (ev.key === "Enter" && (t.tagName !== "TEXTAREA" || ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      saveQuickEdit();
    }
  });
  const actions = {
    back,
    edit: () => go(routeOf({ tab: S().ui.tab, view: "editLead", leadId: S().ui.leadId })),
    accountEdit: () => go(routeOf({ tab: S().ui.tab, view: "editAccount", leadId: S().ui.leadId })),
    async accountSave() {
      const f = root.querySelector("#aform");
      const lead = { id: S().ui.leadId };
      const saved = await run(() => uc.saveAccount(lead, accountInput(f.elements), JSON.parse(f.elements.before.value)), "Kundenakte gespeichert");
      if (saved !== undefined) back();
    },
    quick: () => {
      // Kontakte asks for a name and a Thema, Leads for what a lead is found by.
      const keys = S().ui.tab === "kontakte" ? ["name", "topic"] : Object.values(QUICK_ADD_FIELDS).filter((key) => key !== "topic");
      ui({ quick: S().ui.quick ? false : Object.fromEntries(keys.map((key) => [key, ""])) });
      render();
      // Into Name once, as it opens: a later redraw (a sync, the list filter typed into) leaves the focus where it is.
      if (S().ui.quick) setTimeout(() => root.querySelector("#qaName")?.focus(), 30);
    },
    quickCancel: () => {
      ui({ quick: false });
      render();
    },
    /** In Kontakte the form makes a Kontakt and opens it, to fill in; in Leads it adds a lead to the list. */
    async quickSave() {
      const contact = S().ui.tab === "kontakte";
      const id = await run(() => uc.addLead(contact ? { ...S().ui.quick, kind: "kontakt" } : S().ui.quick), "Hinzugef\xFCgt");
      if (id) {
        ui({ quick: false, ...(!contact && { status: "offen" }) });
        if (contact) return openLead(id);
        render();
      }
    },
    composeCancel: () => {
      ui({ compose: null });
      render();
    },
    composeFu: () => sheet("compose", { fuEdit: !S().ui.compose.fuEdit }),
    reply: (el) => {
      const st = S();
      const msg = actsOf(st, st.ui.leadId).findLast((a) => a.mail?.threadId === el.dataset.thread);
      // The answer goes into that thread: the server sends it there with the newest mail's Message-ID.
      startCompose("out", "E-Mail", { threadId: el.dataset.thread, subject: msg?.mail.subject || "", replyTo: msg?.id || null });
    },
    async noteAdd() {
      const text = (S().ui.noteDraft || "").trim();
      if (!text) return;
      if (await run(() => uc.changeNote(currentLead(S()), { add: text }), "Notiz gespeichert") === undefined) return;
      ui({ noteDraft: null });
      render();
    },
    async noteSave() {
      const { id, text } = S().ui.noteEdit;
      const changed = await run(() => uc.changeNote(currentLead(S()), { note: id, text }));
      if (changed === undefined) return;
      // Removed meanwhile: the form gives way to a new note with the text (unshownSheets).
      if (!changed) return toast("Die Notiz wurde inzwischen gel\xF6scht. Ihr Text steht oben als neue Notiz.");
      toast("Gespeichert");
      ui({ noteEdit: null });
      render();
    },
    noteEditCancel: () => {
      ui({ noteEdit: null });
      render();
    },
    statusMenu: () => {
      ui({ statusMenu: !S().ui.statusMenu });
      render();
    },
    nextEdit: () => {
      ui({ nextEdit: !S().ui.nextEdit });
      render();
    },
    infoToggle: () => {
      ui({ infoOpen: !S().ui.infoOpen });
      render();
    },
    changesToggle: () => {
      ui({ changesOpen: !S().ui.changesOpen });
      render();
    },
    logMenu: () => {
      ui({ logMenu: !S().ui.logMenu, statusMenu: false });
      render();
    },
    /** A visit, from "Eintragen": the visit's form, on any lead open to contact. */
    visitOpen: () => {
      ui({ contactPick: { channel: "Vor Ort", text: "" }, compose: null, call: null, termin: null, logMenu: false });
      render();
      reveal("#cpText");
    },
    /** A talk with a Kontakt, from "Eintragen": on the phone or met, with what was said. */
    talkOpen: () => {
      ui({ contactPick: { channel: "Telefon", text: "" }, compose: null, logMenu: false });
      render();
      reveal("#cpText");
    },
    /** The call sheet, opened by the call itself (the tel link goes on to dial), from "Eintragen" or the Kontaktiert question. */
    callOpen: () => {
      ui({ call: S().ui.call || {}, termin: null, compose: null, contactPick: null, statusMenu: false, logMenu: false });
      render();
      reveal(".sheet");
    },
    /** An appointment agreed outside a call: its own sheet, which logs no call. */
    terminOpen: () => {
      ui({ termin: S().ui.termin || {}, call: null, compose: null, statusMenu: false, logMenu: false });
      render();
      root.querySelector("#agDate")?.scrollIntoView({ block: "center" });
    },
    later: () => {
      ui({ later: !S().ui.later });
      render();
    },
    roundNext,
    callStart: () => startRound("calls"),
    queueStart: () => startRound("queue"),
    freshStart: () => startRound("fresh"),
    copyOpen: (el, ev) => {
      toast(copyText(S().ui.compose.text) ? "Text kopiert" : "Kopieren nicht m\xF6glich");
      if (el.getAttribute("href") === "#") ev.preventDefault();
    },
    async logActivity() {
      const st = S();
      const lead = currentLead(st);
      const c = st.ui.compose;
      const r = await run(
        () => uc.logActivity(lead, actsOf(st, lead.id), { direction: c.direction, channel: c.channel, date: c.date, text: c.text, templateId: c.templateId }),
        (res) => res.plan.followUp && c.direction === "out" ? "Eingetragen \xB7 nachfassen " + relDate(res.plan.followUp, clock.today()) : "Eingetragen"
      );
      if (r) composeSaved(c);
    },
    async contactSave() {
      const st = S();
      const lead = currentLead(st);
      const { channel, text } = st.ui.contactPick;
      const r = await run(
        () => uc.logActivity(lead, actsOf(st, lead.id), { direction: "out", channel, date: clock.today(), text: text.trim() || (isContact(lead) ? TALK_NOTE[channel] : VISIT_NOTE) }),
        (res) => isContact(lead) ? "Gespr\xE4ch eingetragen" : res.plan.status !== "kontaktiert" ? "Besuch eingetragen" : res.plan.followUp ? "Kontaktiert \xB7 nachfassen " + relDate(res.plan.followUp, clock.today()) : "Kontaktiert"
      );
      if (r) {
        ui({ contactPick: null });
        render();
      }
    },
    contactCancel: () => {
      ui({ contactPick: null });
      render();
    },
    callSave: () => logCall(currentLead(S()), callInput(S().ui.call)),
    terminSave: () => saveTermin(currentLead(S()), S().ui.termin),
    terminCancel: () => {
      ui({ termin: null });
      render();
    },
    callCancel: () => {
      ui({ call: null });
      render();
    },
    meetingSave: () => {
      const { result, date, time, reason } = S().ui.meeting;
      return saveMeeting(currentLead(S()), result === "kein-abschluss" ? { result, reason: reason || undefined } : { result, date: date || undefined, time: time || undefined });
    },
    meetingCancel: () => {
      ui({ meeting: null });
      render();
    },
    scriptToggle: () => {
      ui({ script: !S().ui.script });
      render();
    },
    /** The default call script as a template, to adapt under Vorlagen; the lead page shows it from the next sync. */
    scriptTemplate: () => run(() => uc.saveTemplate(null, { name: "Gespr\xE4chsleitfaden", purpose: "leitfaden", body: DEFAULT_SCRIPT }), "Vorlage angelegt \xB7 unter Vorlagen anpassen"),
    closeWithoutReply: () => {
      ui({ statusMenu: false });
      return run(() => uc.closeWithoutReply(currentLead(S())), "Abgeschlossen");
    },
    async todoAdd() {
      const { text = "", due = "" } = S().ui.todoDraft || {};
      if (await run(() => uc.changeTodo(currentLead(S()), { add: text, ...(due && { due }) }), "Todo angelegt") !== undefined) {
        ui({ todoDraft: null });
        render();
      }
    },
    async todoSave() {
      const { id, text, due } = S().ui.todoEdit;
      if (await run(() => uc.changeTodo(currentLead(S()), { todo: id, text, due }), "Gespeichert") !== undefined) {
        ui({ todoEdit: null });
        render();
      }
    },
    todoEditCancel: () => {
      ui({ todoEdit: null });
      render();
    },
    todosDoneToggle: () => {
      ui({ todosDone: !S().ui.todosDone });
      render();
    },
    /** "Fertig" closes the editing with what it holds unsaved; "Schritte bearbeiten" opens it. */
    stepsEditToggle: () => {
      ui(stepsEditOpen(S().ui) ? { stepsEdit: false, stepEdit: null, stepDraft: null } : { stepsEdit: true });
      render();
    },
    async stepAdd() {
      const { text = "", due = "" } = S().ui.stepDraft || {};
      if (await run(() => uc.changeCustomer(currentLead(S()), { addStep: text, ...(due && { due }) }), "Schritt angelegt") !== undefined) {
        ui({ stepDraft: null });
        render();
      }
    },
    async stepSave() {
      const { id, title, due } = S().ui.stepEdit;
      // Live keeps its name: only its day goes.
      if (await run(() => uc.changeCustomer(currentLead(S()), { editStep: id, ...(id !== "live" && { title }), due }), "Gespeichert") !== undefined) {
        ui({ stepEdit: null });
        render();
      }
    },
    stepEditCancel: () => {
      ui({ stepEdit: null });
      render();
    },
    orderNew: () => {
      ui({ orderEdit: { id: "", kind: "bookete", title: "", amount: "", rhythm: "einmalig", signedAt: "", start: "", months: "", renews: false, contract: "", note: "" } });
      render();
    },
    /**
     * A new Auftrag or the one tapped, as typed: an amount and a runtime typed as text go as numbers, "" as none. Of the
     * one tapped only the fields changed against it as opened go, so what someone else changed meanwhile stays.
     */
    async orderSave() {
      const { id, from, ...e } = S().ui.orderEdit;
      const number = (v) => String(v).trim() === "" ? "" : Number(String(v).replace(",", "."));
      const typed = (o) => ({ ...o, title: o.title.trim(), amount: number(o.amount), months: number(o.months), contract: o.contract.trim(), note: o.note.trim() });
      const fields = typed(e);
      const changes = id ? Object.fromEntries(Object.entries(fields).filter(([k, v]) => k !== "id" && JSON.stringify(v) !== JSON.stringify(typed(from)[k]))) : null;
      if (changes && !Object.keys(changes).length) return this.orderCancel();
      if (await run(() => uc.changeOrder(currentLead(S()), id ? { order: id, ...changes } : { add: fields }), "Gespeichert") !== undefined) {
        ui({ orderEdit: null });
        render();
      }
    },
    orderCancel: () => {
      ui({ orderEdit: null });
      render();
    },
    checkInOpen: () => {
      ui({ checkIn: {} });
      render();
      root.querySelector('[data-checkin-result]')?.scrollIntoView({ block: "center" });
    },
    checkInCancel: () => {
      ui({ checkIn: null });
      render();
    },
    async checkInSave() {
      const { result, note, next } = S().ui.checkIn;
      if (await run(() => uc.changeCustomer(currentLead(S()), { checkIn: result, note: note || undefined, next: next || undefined }), "Check-in eingetragen") !== undefined) {
        ui({ checkIn: null });
        render();
      }
    },
    cancelPickClose: () => {
      ui({ cancelPick: false });
      render();
    },
    lostCancel: () => {
      ui({ lostPick: false });
      render();
    },
    qeCancel: () => {
      ui({ editField: null, editDraft: null });
      render();
    },
    qeSave: () => saveQuickEdit(),
    toSearch: () => openSearch(S().ui.q),
    searchClose: () => closeSearch(),
    async optOut() {
      const lead = currentLead(S());
      if (!confirmOptOut(lead)) return;
      ui({ statusMenu: false });
      const note = prompt("Optional: Wie kam das Opt-out? (z. B. \u201Eper Mail: passt schon\u201C)", "") || "";
      await run(() => uc.optOut(lead, note), "Opt-out gespeichert");
    },
    async clearOptOut() {
      const lead = currentLead(S());
      if (!confirm("Opt-out wirklich aufheben? Nur wenn der Betrieb sich selbst wieder gemeldet hat.")) return;
      await run(() => uc.clearOptOut(lead), "Opt-out aufgehoben");
    },
    async saveLead() {
      const { leadId } = S().ui;
      const id = await run(() => saveLeadForm(uc, leadId, root.querySelector("#form").elements), "Gespeichert");
      // An edit goes back to its lead page; a new lead's form becomes the new lead's page.
      if (id) leadId ? back() : go(routeOf({ tab: S().ui.tab, view: "detail", leadId: id }), { replace: true });
    },
    async deleteLead() {
      const lead = currentLead(S());
      if (!lead) return toast("Betrieb nicht gefunden");
      if (!confirm(`\u201E${lead.name}\u201C l\xF6schen? Er kommt in den Papierkorb (unter Mehr) und l\xE4sst sich von dort wiederherstellen.`)) return;
      if (await run(() => uc.deleteLead(lead).then(() => true), "Im Papierkorb")) {
        ui({ trash: null });
        // From the edit form, past the lead's page too.
        leave(routeOf({ tab: S().ui.tab }), 2);
      }
    },
    tplNew: () => openTemplate(null),
    async tplSave() {
      const f = root.querySelector("#tform");
      const id = await run(() => uc.saveTemplate(S().ui.templateId, { name: f.elements.name.value, purpose: f.elements.purpose.value, body: f.elements.body.value }), "Vorlage gespeichert");
      if (id) back();
    },
    async tplDelete() {
      if (!confirm("Vorlage l\xF6schen?")) return;
      if (await run(() => uc.deleteTemplate(S().ui.templateId).then(() => true), "Gel\xF6scht")) back();
    },
    icpEdit: () => {
      const icp = icpOf(S());
      ui({ icpEdit: { fit: (icp?.fit || []).join("\n"), noFit: (icp?.noFit || []).join("\n") } });
      render();
    },
    icpCancel: () => {
      ui({ icpEdit: false });
      render();
    },
    async icpSave() {
      const { fit, noFit } = S().ui.icpEdit;
      if (await run(() => uc.saveIcp({ ...icpOf(S()) || {}, fit: fit.split("\n"), noFit: noFit.split("\n") }).then(() => true), "ICP gespeichert")) {
        ui({ icpEdit: false });
        render();
      }
    },
    async export() {
      const { leads, activities, templates, settings } = S().data;
      saveFile(`bookete-crm-backup-${clock.today()}.json`, JSON.stringify(createBackup({ leads, activities, templates, settings }, clock.now()), null, 2));
    },
    async sendEmail() {
      const st = S();
      const lead = currentLead(st);
      const c = st.ui.compose;
      if (!confirm(`E-Mail an ${lead.email} jetzt senden?`)) return;
      if (await run(() => uc.sendEmail(lead, { subject: c.subject, text: c.text, templateId: c.templateId, replyTo: c.thread?.replyTo || null, signed: c.signed !== false }), "Gesendet und eingetragen")) composeSaved(c);
    },
    importPick: () => root.querySelector("#importFile")?.click(),
    showTrash: () => loadTrash(),
    trashOlder: (el) => loadTrash(Number(el.dataset.before)),
    logoutAll: (el, ev) => {
      if (!confirm("Auf allen Ger\xE4ten abmelden und alle verbundenen Agenten trennen?")) ev.preventDefault();
    }
  };
  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest("button,a[data-act],[data-open],[data-edit]");
    if (!el) return;
    const d = el.dataset;
    const st = S();
    if (d.tab) {
      // Another tab, or the tab a lead page or template was opened from: its screen.
      if (d.tab !== st.ui.tab || st.ui.view) return goTab(d.tab);
      // The screen already shown: under the open search, back to it as it was; else to its top.
      return st.ui.searchOpen ? closeSearch() : window.scrollTo(0, 0);
    }
    if (d.open) return st.ui.searchOpen ? openResult(d.open) : openLead(d.open);
    if (d.queue) return startRound("queue", d.queue);
    if (d.compose) return d.compose === "in" ? startCompose("in") : startCompose("out", d.compose);
    if (d.ch) return sheet("compose", { channel: d.ch });
    if (d.cp) return sheet("contactPick", { channel: d.cp });
    if (d.feed) {
      ui({ feed: d.feed });
      return render();
    }
    if (d.tpl) return openTemplate(d.tpl);
    if (d.edit) {
      if (st.ui.editField === d.edit) return;
      ui({ editField: d.edit, editDraft: null });
      render();
      const x = root.querySelector("#qe");
      if (x) {
        x.focus();
        if (x.select && x.tagName === "INPUT") x.select();
      }
      return;
    }
    if (d.expand) {
      const s = new Set(st.ui.expanded);
      s.has(d.expand) ? s.delete(d.expand) : s.add(d.expand);
      ui({ expanded: s });
      return render();
    }
    if (d.copy) {
      const a = st.data.activities.find((x) => x.id === d.copy);
      return toast(a && copyText(a.text) ? "Kopiert" : "Kopieren nicht m\xF6glich");
    }
    const writes = d.status || d.lost || d.todoDone || d.todoUndo || d.todoRemove || d.noteRemove || d.fu || d.later || d.undo || d.meeting || d.restore || d.purge || d.step || d.stepUndo || d.skip || d.stepUp || d.stepDown || d.stepRemove || d.orderRemove || d.cancel || d.phase && d.phase !== "gekuendigt" || d.act && !UI_ONLY_ACTIONS.has(d.act);
    if (writes && !uc) return toast("Keine Verbindung zur Datenbank");
    if (d.restore) return await run(() => uc.restoreLead(d.restore).then(() => true), "Wiederhergestellt") && loadTrash(st.ui.trashBefore);
    if (d.purge) {
      if (!confirm("Endg\xFCltig l\xF6schen? Der Betrieb, seine Kontakte und alle \xC4nderungen sind dann weg. Das l\xE4sst sich nicht r\xFCckg\xE4ngig machen.")) return;
      return await run(() => uc.purgeLead(d.purge).then(() => true), "Endg\xFCltig gel\xF6scht") && loadTrash(st.ui.trashBefore);
    }
    const lead = currentLead(st);
    if (d.status) {
      // Disqualifiziert needs a reason: the picker asks for it (on a closed lead, for a new one), and the reason
      // picked writes both at once. Any other status is one tap.
      if (d.status === "disqualifiziert") {
        ui({ lostPick: true, statusMenu: false });
        return render();
      }
      if (lead.status === d.status) return;
      // A new lead becomes Kontaktiert once someone speaks with them: the question where logs it and plans the follow-up.
      if (d.status === "kontaktiert" && lead.status === "neu") {
        ui({ contactPick: S().ui.contactPick || { channel: "", text: "" }, statusMenu: false, lostPick: false });
        return render();
      }
      // Back to Neu clears what speaking with them gave; the server refuses it once anyone did.
      if (d.status === "neu" && lead.contactedAt && !confirm(`\u201E${lead.name}\u201C zur\xFCck auf Neu?\n\nDer Erstkontakt, das Nachfass-Datum und der n\xE4chste Schritt werden gel\xF6scht. Das geht nur, wenn noch niemand mit ihnen gesprochen hat.`)) return;
      ui({ statusMenu: false, lostPick: false, contactPick: null });
      return run(() => uc.changeStatus(lead, d.status), "Status: " + STAGE_LABEL[d.status]);
    }
    if (d.lost) {
      // A tap on the opt-out reason records the opt-out, so it asks first, as the Opt-out button does.
      if (d.lost === OPT_OUT_REASON && !lead.optOutAt && !confirmOptOut(lead)) return;
      ui({ lostPick: false });
      return run(() => pickLostReason(uc, lead, d.lost), lead.status === "disqualifiziert" ? "Grund gespeichert" : "Status: " + STAGE_LABEL.disqualifiziert);
    }
    if (d.checkinResult) return sheet("checkIn", { result: d.checkinResult });
    if (d.todoDone) return run(() => uc.changeTodo(lead, { todo: d.todoDone, done: true }), "Erledigt");
    if (d.todoUndo) return run(() => uc.changeTodo(lead, { todo: d.todoUndo, done: false }), "Wieder offen");
    if (d.todoEdit) {
      const t = (currentLead(st).todos || []).find((x) => x.id === d.todoEdit);
      ui({ todoEdit: t ? { id: t.id, text: t.text, due: t.due || "" } : null });
      render();
      return root.querySelector("#teText")?.focus();
    }
    if (d.todoRemove) return run(() => uc.changeTodo(lead, { todo: d.todoRemove, remove: true }), "Todo gel\xF6scht");
    if (d.noteRemove) return confirm("Diese Notiz l\xF6schen?") && run(() => uc.changeNote(lead, { note: d.noteRemove, remove: true }), "Notiz gel\xF6scht");
    if (d.noteEdit) {
      const n = notesOf(lead).find((x) => x.id === d.noteEdit);
      if (!n) return;
      ui({ noteEdit: { id: n.id, text: n.text } });
      render();
      return root.querySelector("#neText")?.focus();
    }
    if (d.hall) {
      ui({ hAll: d.hall === "1" });
      return render();
    }
    // A Kunde's care: a step done, open again or skipped; the phase, Gekündigt with its reason.
    if (d.step) return run(() => uc.changeCustomer(lead, { step: d.step }), "Erledigt");
    if (d.stepUndo) return run(() => uc.changeCustomer(lead, { step: d.stepUndo, done: false }), "Wieder offen");
    if (d.skip) {
      const why = prompt("Warum entf\xE4llt der Schritt? (optional)");
      return why === null ? undefined : run(() => uc.changeCustomer(lead, { step: d.skip, skip: why }), "Entf\xE4llt");
    }
    if (d.stepUp || d.stepDown) return run(() => uc.changeCustomer(lead, { moveStep: d.stepUp || d.stepDown, up: !!d.stepUp }), "Verschoben");
    if (d.stepRemove) {
      const step = customerOf(lead)?.steps.find((s) => s.id === d.stepRemove);
      if (step?.at && !confirm(`\u201E${step.title}\u201C ist erledigt. Trotzdem l\xF6schen?`)) return;
      return run(() => uc.changeCustomer(lead, { removeStep: d.stepRemove }), "Schritt gel\xF6scht");
    }
    if (d.stepEdit) {
      const step = customerOf(lead)?.steps.find((s) => s.id === d.stepEdit);
      ui({ stepEdit: step ? { id: step.id, title: step.title, due: step.due } : null });
      return render();
    }
    if (d.orderEdit) {
      const o = ordersOf(lead).find((x) => x.id === d.orderEdit);
      // The Auftrag as opened goes along, so saving sends only what was changed against it.
      const opened = o && { ...o, amount: String(o.amount), months: String(o.months) };
      ui({ orderEdit: opened ? { ...opened, from: opened } : null });
      return render();
    }
    if (d.orderRemove) {
      const o = ordersOf(lead).find((x) => x.id === d.orderRemove);
      if (o && !confirm(`Auftrag \u201E${[KIND_LABEL[o.kind], o.title].filter(Boolean).join(" \xB7 ")}\u201C l\xF6schen?`)) return;
      return run(() => uc.changeOrder(lead, { order: d.orderRemove, remove: true }), "Auftrag gel\xF6scht");
    }
    if (d.phase) {
      // The phase it has already changes nothing, as the status chip does.
      if (d.phase === customerOf(lead)?.phase) return;
      if (d.phase === "gekuendigt") {
        ui({ cancelPick: true });
        return render();
      }
      return run(() => uc.changeCustomer(lead, { phase: d.phase }), "Phase: " + PHASE_LABEL[d.phase]);
    }
    if (d.cancel) {
      ui({ cancelPick: false });
      return run(() => uc.changeCustomer(lead, { phase: "gekuendigt", reason: d.cancel }), "Gek\xFCndigt");
    }
    // Every outcome is picked first, Nicht erreicht too, so the sheet shows what saving does before it is saved.
    if (d.call) return sheet("call", { outcome: d.call });
    if (d.undo) {
      const call = st.data.activities.find((a) => a.id === d.undo);
      if (!call || !confirm("Diesen Anruf zur\xFCcknehmen? Status und n\xE4chster Schritt gehen zur\xFCck auf den Stand davor.")) return;
      return run(() => uc.undoCall(call), "Anruf zur\xFCckgenommen");
    }
    if (d.later) return postpone(addDays(clock.today(), +d.later));
    if (d.meeting) {
      if (d.meeting === "kunde") return saveMeeting(lead, { result: "kunde" });
      return sheet("meeting", { result: d.meeting });
    }
    if (d.fu) {
      const v = d.fu === "clear" ? "" : addDays(clock.today(), +d.fu);
      return run(() => uc.setFollowUp(lead, v), v ? "Nachfassen " + relDate(v, clock.today()) : "Kein Nachfass-Termin");
    }
    if (d.act && actions[d.act]) return actions[d.act](el, ev);
  });
  root.addEventListener("input", (ev) => {
    const t = ev.target;
    const c = S().ui.compose;
    // The list filters of Leads (q) and Kontakte (cq).
    if (t.id === "q" || t.id === "cq") {
      const pos = t.selectionStart;
      // Kept as typed: the field is drawn back from it, so a trimmed copy would take a space just typed.
      ui({ [t.id]: t.value });
      render();
      const n = root.querySelector("#" + t.id);
      n.focus();
      n.setSelectionRange(pos, pos);
    }
    // What is typed into the quick-add and ICP forms is kept as typed, so a redraw (a sync, a sort, a filter) draws it back.
    const { quick, icpEdit } = S().ui;
    if (QUICK_ADD_FIELDS[t.id] && quick) return ui({ quick: { ...quick, [QUICK_ADD_FIELDS[t.id]]: t.value } });
    if ((t.id === "icpFit" || t.id === "icpNo") && icpEdit) return ui({ icpEdit: { ...icpEdit, [t.id === "icpFit" ? "fit" : "noFit"]: t.value } });
    // The call, Termin and meeting sheets keep what is typed in the UI state too, for their preview and any redraw.
    const outcomeKey = sheetKey(S().ui);
    if (AGREED_FIELDS[t.id] && S().ui[outcomeKey]) return ui({ [outcomeKey]: { ...S().ui[outcomeKey], [AGREED_FIELDS[t.id]]: t.value.trim() } });
    // The new todo's text is kept as typed; only its button follows it, so the field keeps its focus.
    if (t.id === "tdText") {
      ui({ todoDraft: { ...S().ui.todoDraft, text: t.value } });
      const add = root.querySelector('[data-act="todoAdd"]');
      if (add) add.disabled = !t.value.trim();
      // Typed text is input to keep: search and the tabs shut while it is there.
      return lockForInput(S(), clock.today());
    }
    // A quick edit keeps what is typed, with the value it was typed over, so a redraw or a return draws it back.
    if (t.id === "qe" && S().ui.editField) return ui({ editDraft: { value: t.value, from: S().ui.editDraft?.from ?? String(currentLead(S())?.[t.dataset.field] ?? "") } });
    // A note being written or changed is kept as typed; only the add button follows it, so the field keeps its focus.
    if (t.id === "ntText") {
      ui({ noteDraft: t.value });
      const add = root.querySelector('[data-act="noteAdd"]');
      if (add) add.disabled = !t.value.trim();
      return lockForInput(S(), clock.today());
    }
    if (t.id === "neText" && S().ui.noteEdit) return ui({ noteEdit: { ...S().ui.noteEdit, text: t.value } });
    if (t.id === "teText" && S().ui.todoEdit) return ui({ todoEdit: { ...S().ui.todoEdit, text: t.value } });
    // A new step's title as typed; only its button follows it, so the field keeps its focus.
    if (t.id === "sdText") {
      ui({ stepDraft: { ...S().ui.stepDraft, text: t.value } });
      const add = root.querySelector('[data-act="stepAdd"]');
      if (add) add.disabled = !t.value.trim();
      return lockForInput(S(), clock.today());
    }
    if (t.id === "seTitle" && S().ui.stepEdit) return ui({ stepEdit: { ...S().ui.stepEdit, title: t.value } });
    if (ORDER_INPUTS[t.id] && S().ui.orderEdit) return ui({ orderEdit: { ...S().ui.orderEdit, [ORDER_INPUTS[t.id]]: t.value } });
    if (t.id === "cpText" && S().ui.contactPick) return ui({ contactPick: { ...S().ui.contactPick, text: t.value } });
    if (t.id === "ciNote" && S().ui.checkIn) return ui({ checkIn: { ...S().ui.checkIn, note: t.value } });
    if (t.id === "cSubj" && c) return ui({ compose: { ...c, subject: t.value } });
    if (t.id === "cText" && c) {
      ui({ compose: { ...c, text: t.value } });
      const a = root.querySelector('[data-act="copyOpen"]');
      if (a && a.getAttribute("href") !== "#") a.setAttribute("href", channelLink(currentLead(S()), c.channel, t.value));
    }
  });
  root.addEventListener("change", async (ev) => {
    const t = ev.target;
    const st = S();
    const c = st.ui.compose;
    const lead = currentLead(st);
    if (t.id === "cTpl" && c) {
      const tp = st.data.templates.find((x) => x.id === t.value);
      const f = tp ? fillTemplate(tp.body, lead) : { text: c.text, missing: [] };
      ui({ compose: { ...c, templateId: t.value, text: f.text, missing: f.missing } });
      return render();
    }
    if (t.id === "cCh" && c) return t.value ? sheet("compose", { channel: t.value }) : undefined;
    if (t.id === "cSig" && c) {
      ui({ compose: { ...c, signed: t.checked } });
      return render();
    }
    // The date changes what logging plans, so the line under "Danach" is drawn again.
    if (t.id === "cDate" && c) return sheet("compose", { date: t.value });
    if (t.id === "cFu" && c) return sheet("compose", { followUp: t.value || null, fuEdit: false });
    const outcomeKey = sheetKey(st.ui);
    if (AGREED_FIELDS[t.id] && st.ui[outcomeKey] && t.id !== "agNote") return sheet(outcomeKey, { [AGREED_FIELDS[t.id]]: t.value.trim() });
    if (t.id === "laterDate" && t.value) return postpone(t.value);
    if (t.id === "qe" && t.tagName === "SELECT") return saveQuickEdit();
    if (t.id === "teDue" && st.ui.todoEdit) return ui({ todoEdit: { ...st.ui.todoEdit, due: t.value } });
    if (t.id === "tdDue") return ui({ todoDraft: { ...st.ui.todoDraft, due: t.value } });
    if (t.id === "seDue" && st.ui.stepEdit) return ui({ stepEdit: { ...st.ui.stepEdit, due: t.value } });
    if (t.id === "oRenews" && st.ui.orderEdit) return ui({ orderEdit: { ...st.ui.orderEdit, renews: t.checked } });
    // Hosting picked for an Auftrag with no amount yet starts as the package we sell.
    if (t.id === "oKind" && st.ui.orderEdit) {
      const e = st.ui.orderEdit;
      const care = t.value === "hosting" && e.amount === "" ? { title: e.title || HOSTING_CARE.title, amount: String(HOSTING_CARE.amount), rhythm: HOSTING_CARE.rhythm, months: String(HOSTING_CARE.months), renews: HOSTING_CARE.renews } : {};
      ui({ orderEdit: { ...e, kind: t.value, ...care } });
      return render();
    }
    if (ORDER_INPUTS[t.id] && st.ui.orderEdit) return ui({ orderEdit: { ...st.ui.orderEdit, [ORDER_INPUTS[t.id]]: t.value } });
    if (t.id === "sdDue") return ui({ stepDraft: { ...st.ui.stepDraft, due: t.value } });
    if (t.id === "ciNext" && st.ui.checkIn) return sheet("checkIn", { next: t.value });
    // A call entered later: its day, today unless picked; today itself is no day picked.
    if (t.id === "callDay" && st.ui.call) return sheet("call", { day: t.value && t.value !== clock.today() ? t.value : "" });
    // What a Kunde agreed on: each field saves when it is left.
    if (t.id === "kOwnerOf") return run(() => uc.changeCustomer(lead, { owner: t.value }), t.value ? "Betreut von " + actorName(t.value) : "Niemand betreut");
    if (t.dataset.filter) {
      ui({ [t.dataset.filter]: t.value });
      return render();
    }
    // The edit form asks for a reason only with Disqualifiziert.
    if (t.name === "status" && t.form?.id === "form") {
      root.querySelector("#lostReasonField").hidden = t.value !== "disqualifiziert";
      return;
    }
    if (t.id === "sort") {
      ui({ sort: t.value });
      return render();
    }
    if (t.id === "fu") return run(() => uc.setFollowUp(lead, t.value), t.value ? "Nachfassen " + relDate(t.value, clock.today()) : "Kein Nachfass-Termin");
    if (t.id === "nextStep") return run(() => uc.setNextStep(lead, t.value), "Gespeichert");
    if (t.id === "importFile" && t.files[0]) {
      let backup;
      try {
        backup = JSON.parse(await t.files[0].text());
      } catch {
        return toast("Keine g\xFCltige JSON-Datei");
      }
      t.value = "";
      if (confirm("Sicherung einspielen? Nur Eintr\xE4ge, die das CRM noch nie hatte, kommen dazu; bestehende bleiben unver\xE4ndert.")) await run(() => uc.importBackup(backup, clock.today()), (n) => `${n} neue Eintr\xE4ge eingespielt`);
    }
  });
  applyRoute();
  return {
    connect(useCases) {
      uc = useCases;
    },
    onDataChanged: safeRender,
    fail(msg) {
      store2.set((s) => ({ ...s, status: { ...s.status, failed: msg } }));
      safeRender();
    }
  };
}
