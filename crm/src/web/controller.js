import { STAGE_LABEL } from '../domain/constants.js';
import { ValidationError } from '../domain/errors.js';
import { actsOf, currentLead, icpOf, isReady, callList } from './selectors.js';
import { addDays } from '../domain/dates.js';
import { copyText, channelLink, mailSubject, saveFile } from './platform.js';
import { createBackup } from '../domain/backup.js';
import { fillTemplate, defaultTemplate, DEFAULT_SCRIPT } from '../domain/template.js';
import { lastChannel } from '../domain/activity.js';
import { relDate } from './format.js';
import { TABS, tabBar, todayView, todosView, leadsView, searchResultsHtml, searchView, templatesView, templateEditView, moreView, detailView, leadEditView, accountEditView } from './views.js';

export const UI_ONLY_ACTIONS = new Set(["qeCancel", "back", "edit", "accountEdit", "quick", "quickCancel", "composeOut", "composeIn", "composeCancel", "copyOpen", "lostPick", "lostCancel", "callCancel", "meetingCancel", "callStart", "callNext", "scriptToggle", "tplNew", "icpEdit", "icpCancel", "toSearch", "importPick", "logoutAll"]);
/**
 * Every screen has an address (`#/betriebe`, `#/betrieb/<id>`, …), so the browser's Back, a reload and a shared
 * link all land on it. Hash addresses need no server route. The address decides tab, view and record; what a
 * screen has open on top (compose, reason picker, quick edit) stays out of it.
 */
export function routeOf({ tab, view, leadId, templateId }) {
  const id = (x) => encodeURIComponent(x);
  if (view === "detail") return `#/betrieb/${id(leadId)}`;
  if (view === "editLead") return `#/betrieb/${id(leadId)}/bearbeiten`;
  if (view === "editAccount") return `#/betrieb/${id(leadId)}/kunde`;
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
  // A template belongs to Vorlagen, so one opened from a link or a reload goes back there.
  if (a === "vorlage" && b) return { view: "editTemplate", templateId: b === "neu" ? null : b, tab: "vorlagen" };
  return { view: null, tab: TABS.some(([k]) => k === a) ? a : "heute" };
}
const LEAD_VIEWS = new Set(["detail", "editLead", "editAccount"]);
const FORM_VIEWS = new Set(["editLead", "editTemplate", "editAccount"]);
/** The UI state for an address: a lead other than the one open starts fresh, and Mehr starts with the Papierkorb closed so it is never shown stale. */
export function enterRoute(ui, route) {
  if (LEAD_VIEWS.has(route.view)) {
    const sameLead = LEAD_VIEWS.has(ui.view) && ui.leadId === route.leadId;
    return { ...ui, ...route, ...(!sameLead && { compose: null, lostPick: false, call: null, meeting: null, editField: null, changes: null, expanded: new Set() }) };
  }
  if (route.view) return { ...ui, ...route };
  return { ...ui, ...route, quick: false, calling: null, ...(route.tab === "mehr" && ui.tab !== "mehr" && { trash: null }) };
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
 */
export function createNavigation(history, location, applyRoute) {
  const depth = () => history.state?.crm || 0;
  // history.go lands later; until then the state is still this screen's, so a second leave would step back again.
  let leaving = false;
  /** A new history entry, or with `replace` one in place of the current entry, which keeps its depth. */
  const go = (route, { replace = false } = {}) => {
    if (route !== location.hash) replace ? history.replaceState(history.state, "", route) : history.pushState({ crm: depth() + 1 }, "", route);
    applyRoute();
  };
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
  return { go, leave, landed };
}
/** Where the in-app Zurück leads when there is no earlier screen of ours to go back to: the screen above. */
export const backRoute = (ui) => ui.view === "editLead" || ui.view === "editAccount" ? routeOf({ view: "detail", leadId: ui.leadId }) : routeOf({ tab: ui.tab });
/**
 * The Kundenakte form as the parts of an account: rows by index, without those marked to remove and without a new
 * row left empty.
 */
export function accountInput(elements) {
  const rows = { services: [], contacts: [] };
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
  return { services: keep("services"), contacts: keep("contacts"), systems };
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
export function mountApp({ root, tabsEl, toastEl, store: store2, clock }) {
  let uc = null;
  const S = () => store2.get();
  const ui = (p) => store2.ui(p);
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
  function render() {
    const st = S();
    const today = clock.today();
    const view = st.ui.view;
    if (recordMissing(st)) return go(routeOf({ tab: st.ui.tab }), { replace: true }), false;
    tabsEl.hidden = !!view;
    root.innerHTML = view === "detail" ? detailView(st, today) : view === "editLead" ? leadEditView(st) : view === "editTemplate" ? templateEditView(st) : view === "editAccount" ? accountEditView(st) : { heute: todayView, todos: todosView, betriebe: leadsView, suche: searchView, vorlagen: templatesView, mehr: moreView }[st.ui.tab](st, today);
    if (!view) tabsEl.innerHTML = tabBar(st, today);
    if (st.ui.quick && !view && st.ui.tab === "betriebe") setTimeout(() => root.querySelector("#qaName")?.focus(), 30);
    return true;
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
  /** Shows the screen of the current address; also runs on the browser's Back and Forward. */
  function applyRoute() {
    saveScroll();
    const next = enterRoute(S().ui, parseRoute(location.hash));
    show(next, next.view ? 0 : next.scroll[next.tab] || 0);
  }
  const { go, leave, landed } = createNavigation(history, location, applyRoute);
  history.scrollRestoration = "manual";
  window.addEventListener("popstate", landed);
  const goTab = (tab) => go(routeOf({ tab }));
  const focusSearch = () => {
    const n = root.querySelector("#gq");
    if (!n) return;
    n.focus();
    n.select();
  };
  const openSearch = (q) => {
    if (q != null) ui({ gq: q, sIdx: 0 });
    if (S().ui.tab !== "suche" || S().ui.view) goTab("suche");
    focusSearch();
  };
  const refreshResults = () => {
    const box = root.querySelector("#sres");
    if (box) box.innerHTML = searchResultsHtml(S(), clock.today());
  };
  function moveSelection(delta) {
    const rows = root.querySelectorAll("#sres .srow");
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
    if (!cmdK && !slash) return;
    const u = S().ui;
    if (FORM_VIEWS.has(u.view) || u.compose || u.editField) return;
    ev.preventDefault();
    openSearch();
  });
  const back = () => leave(backRoute(S().ui));
  const openLead = (id) => go(routeOf({ view: "detail", leadId: id }));
  const openTemplate = (id) => go(routeOf({ view: "editTemplate", templateId: id }));
  const loadTrash = () => run(async () => {
    ui({ trash: await uc.trash() });
    render();
  }, null, "Laden fehlgeschlagen");
  function startCompose(direction) {
    const st = S();
    const lead = currentLead(st);
    const acts = actsOf(st, lead.id);
    const tpl = direction === "out" ? defaultTemplate(lead, acts, st.data.templates) : null;
    const filled = tpl ? fillTemplate(tpl.body, lead) : { text: "", missing: [] };
    ui({ compose: { direction, templateId: tpl?.id || "", channel: lastChannel(acts) || (lead.instagram ? "Instagram" : "E-Mail"), date: clock.today(), subject: mailSubject(lead), text: filled.text, missing: filled.missing } });
    render();
    root.querySelector("#cText")?.scrollIntoView({ block: "center" });
  }
  // What the open outcome form holds; an empty field is left out.
  const agreed = () => Object.fromEntries(["date:agDate", "time:agTime", "reason:agReason", "note:agNote"].map((x) => x.split(":")).map(([k, id]) => [k, root.querySelector("#" + id)?.value.trim() || undefined]));
  async function logCall(lead, call) {
    const today = clock.today();
    const r = await run(() => uc.logCall(lead, call), ({ plan }) => plan.status === "disqualifiziert" ? "Eingetragen \xB7 Disqualifiziert" : plan.followUp ? "Eingetragen \xB7 wieder " + relDate(plan.followUp, today) : "Eingetragen");
    if (r) {
      ui({ call: null });
      render();
    }
  }
  async function saveMeeting(lead, meeting) {
    if (await run(() => uc.meetingOutcome(lead, meeting), meeting.result === "kunde" ? "Status: Kunde" : "Eingetragen") !== undefined) {
      ui({ meeting: null });
      render();
    }
  }
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
    ui({ editField: null });
    render();
  }
  root.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.edit && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      t.click();
      return;
    }
    if (t.id === "gq") {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        moveSelection(ev.key === "ArrowDown" ? 1 : -1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const row = root.querySelectorAll("#sres .srow")[S().ui.sIdx];
        if (row && t.value.trim()) openLead(row.dataset.open);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        if (t.value) {
          t.value = "";
          ui({ gq: "", sIdx: 0 });
          refreshResults();
        } else t.blur();
      }
      return;
    }
    if (t.id !== "qe") return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ui({ editField: null });
      render();
    } else if (ev.key === "Enter" && (t.tagName !== "TEXTAREA" || ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      saveQuickEdit();
    }
  });
  const actions = {
    back,
    edit: () => go(routeOf({ view: "editLead", leadId: S().ui.leadId })),
    accountEdit: () => go(routeOf({ view: "editAccount", leadId: S().ui.leadId })),
    async accountSave() {
      const f = root.querySelector("#aform");
      const lead = { id: S().ui.leadId };
      const saved = await run(() => uc.saveAccount(lead, accountInput(f.elements), JSON.parse(f.elements.before.value)), "Kundenakte gespeichert");
      if (saved !== undefined) back();
    },
    quick: () => {
      ui({ quick: !S().ui.quick });
      render();
    },
    quickCancel: () => {
      ui({ quick: false });
      render();
    },
    async quickSave() {
      const g = (id2) => root.querySelector("#" + id2).value;
      const id = await run(() => uc.addLead({ name: g("qaName"), city: g("qaCity"), instagram: g("qaIg"), hook: g("qaHook") }), "Hinzugef\xFCgt");
      if (id) {
        ui({ quick: false, status: "offen" });
        render();
      }
    },
    composeOut: () => startCompose("out"),
    composeIn: () => startCompose("in"),
    composeCancel: () => {
      ui({ compose: null });
      render();
    },
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
      if (r) {
        ui({ compose: null });
        render();
      }
    },
    callSave: () => logCall(currentLead(S()), { outcome: S().ui.call.outcome, ...agreed() }),
    callCancel: () => {
      ui({ call: null });
      render();
    },
    meetingSave: () => {
      const { note: _note, ...fields } = agreed();
      return saveMeeting(currentLead(S()), { result: S().ui.meeting.result, ...fields });
    },
    meetingCancel: () => {
      ui({ meeting: null });
      render();
    },
    /** Starts a call session at the top of the call list; Zurück or a tab ends it. */
    callStart: () => {
      const [first] = callList(S(), clock.today());
      if (!first) return toast("Niemand zum Anrufen");
      ui({ calling: { seen: [] } });
      openLead(first.id);
    },
    /** The next on the call list, freshly computed: a lead called in this session is skipped, as is one whose follow-up moved on. In place of this page, so Zurück ends the session. */
    callNext: () => {
      const st = S();
      const seen = [...st.ui.calling.seen, st.ui.leadId];
      const next = callList(st, clock.today()).find((l) => !seen.includes(l.id));
      if (!next) return toast("Anrufliste erledigt"), back();
      ui({ calling: { seen } });
      go(routeOf({ view: "detail", leadId: next.id }), { replace: true });
    },
    scriptToggle: () => {
      ui({ script: !S().ui.script });
      render();
    },
    /** The default call script as a template, to adapt under Vorlagen; the lead page shows it from the next sync. */
    scriptTemplate: () => run(() => uc.saveTemplate(null, { name: "Gespr\xE4chsleitfaden", purpose: "leitfaden", body: DEFAULT_SCRIPT }), "Vorlage angelegt \xB7 unter Vorlagen anpassen"),
    closeWithoutReply: () => run(() => uc.closeWithoutReply(currentLead(S())), "Abgeschlossen"),
    lostPick: () => {
      ui({ lostPick: true });
      render();
    },
    lostCancel: () => {
      ui({ lostPick: false });
      render();
    },
    qeCancel: () => {
      ui({ editField: null });
      render();
    },
    qeSave: () => saveQuickEdit(),
    toSearch: () => openSearch(S().ui.q),
    async optOut() {
      const lead = currentLead(S());
      if (!confirm(`\u201E${lead.name}\u201C m\xF6chte keine Nachrichten mehr?

Der Betrieb wird geschlossen und jede weitere Nachricht blockiert.`)) return;
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
      if (id) leadId ? back() : go(routeOf({ view: "detail", leadId: id }), { replace: true });
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
      ui({ icpEdit: true });
      render();
    },
    icpCancel: () => {
      ui({ icpEdit: false });
      render();
    },
    async icpSave() {
      const lines = (id) => root.querySelector("#" + id).value.split("\n");
      if (await run(() => uc.saveIcp({ ...icpOf(S()) || {}, fit: lines("icpFit"), noFit: lines("icpNo") }).then(() => true), "ICP gespeichert")) {
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
      if (await run(() => uc.sendEmail(lead, { subject: c.subject, text: c.text, templateId: c.templateId }), "Gesendet und eingetragen")) {
        ui({ compose: null });
        render();
      }
    },
    importPick: () => root.querySelector("#importFile")?.click(),
    async showChanges() {
      const lead = currentLead(S());
      const rows = await run(() => uc.history(lead), null, "Laden fehlgeschlagen");
      if (rows) {
        ui({ changes: { leadId: lead.id, rows } });
        render();
      }
    },
    showTrash: loadTrash,
    logoutAll: (el, ev) => {
      if (!confirm("Auf allen Ger\xE4ten abmelden und alle verbundenen Agenten trennen?")) ev.preventDefault();
    }
  };
  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest("button,a[data-act],[data-open],[data-edit]");
    if (!el) return;
    const d = el.dataset;
    const st = S();
    if (d.tab === "suche") return openSearch();
    if (d.tab) return d.tab === st.ui.tab ? window.scrollTo(0, 0) : goTab(d.tab);
    if (d.open) return openLead(d.open);
    if (d.tpl) return openTemplate(d.tpl);
    if (d.edit) {
      if (st.ui.editField === d.edit) return;
      ui({ editField: d.edit });
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
    const writes = d.status || d.lost || d.fu || d.call || d.meeting || d.restore || d.purge || d.act && !UI_ONLY_ACTIONS.has(d.act);
    if (writes && !uc) return toast("Keine Verbindung zur Datenbank");
    if (d.restore) return await run(() => uc.restoreLead(d.restore).then(() => true), "Wiederhergestellt") && loadTrash();
    if (d.purge) {
      if (!confirm("Endg\xFCltig l\xF6schen? Der Betrieb, seine Kontakte und alle \xC4nderungen sind dann weg. Das l\xE4sst sich nicht r\xFCckg\xE4ngig machen.")) return;
      return await run(() => uc.purgeLead(d.purge).then(() => true), "Endg\xFCltig gel\xF6scht") && loadTrash();
    }
    const lead = currentLead(st);
    if (d.status) {
      if (lead.status === d.status) return;
      // Disqualifiziert needs a reason: the picker asks for it, and the reason picked writes both at once.
      ui({ lostPick: d.status === "disqualifiziert" });
      if (d.status === "disqualifiziert") return render();
      return run(() => uc.changeStatus(lead, d.status), "Status: " + STAGE_LABEL[d.status]);
    }
    if (d.lost) {
      ui({ lostPick: false });
      return run(() => pickLostReason(uc, lead, d.lost), lead.status === "disqualifiziert" ? "Grund gespeichert" : "Status: " + STAGE_LABEL.disqualifiziert);
    }
    if (d.call) {
      if (d.call === "nicht-erreicht") return logCall(lead, { outcome: d.call });
      ui({ call: { outcome: d.call } });
      return render();
    }
    if (d.meeting) {
      if (d.meeting === "kunde") return saveMeeting(lead, { result: "kunde" });
      ui({ meeting: { result: d.meeting } });
      return render();
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
    if (t.id === "gq") {
      ui({ gq: t.value, sIdx: 0 });
      refreshResults();
      return;
    }
    if (t.id === "q") {
      const pos = t.selectionStart;
      ui({ q: t.value.trim() });
      render();
      const n = root.querySelector("#q");
      n.focus();
      n.setSelectionRange(pos, pos);
    }
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
    if (t.id === "cCh" && c) {
      ui({ compose: { ...c, channel: t.value } });
      return render();
    }
    if (t.id === "cDate" && c) return ui({ compose: { ...c, date: t.value } });
    if (t.id === "qe" && t.tagName === "SELECT") return saveQuickEdit();
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
