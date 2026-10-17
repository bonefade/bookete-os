import { STAGE_LABEL } from '../domain/constants.js';
import { ValidationError } from '../domain/errors.js';
import { actsOf, currentLead, icpOf } from './selectors.js';
import { addDays } from '../domain/dates.js';
import { copyText, channelLink, mailSubject, saveFile } from './platform.js';
import { createBackup } from '../domain/backup.js';
import { fillTemplate, defaultTemplate } from '../domain/template.js';
import { lastChannel } from '../domain/activity.js';
import { relDate } from './format.js';
import { tabBar, todayView, todosView, leadsView, searchResultsHtml, searchView, templatesView, templateEditView, moreView, detailView, leadEditView } from './views.js';

export const UI_ONLY_ACTIONS = new Set(["qeCancel", "back", "edit", "quick", "quickCancel", "composeOut", "composeIn", "composeCancel", "copyOpen", "lostPick", "lostCancel", "tplNew", "icpEdit", "icpCancel", "toSearch", "importPick", "logoutAll"]);
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
  function render() {
    const st = S();
    const today = clock.today();
    const view = st.ui.view;
    if (view === "detail" && !currentLead(st)) {
      ui({ view: null });
      return;
    }
    tabsEl.hidden = !!view;
    root.innerHTML = view === "detail" ? detailView(st, today) : view === "editLead" ? leadEditView(st) : view === "editTemplate" ? templateEditView(st) : { heute: todayView, todos: todosView, betriebe: leadsView, suche: searchView, vorlagen: templatesView, mehr: moreView }[st.ui.tab](st, today);
    if (!view) tabsEl.innerHTML = tabBar(st, today);
    if (st.ui.quick && !view && st.ui.tab === "betriebe") setTimeout(() => root.querySelector("#qaName")?.focus(), 30);
  }
  function safeRender() {
    const a = document.activeElement;
    const v = S().ui.view;
    if (v === "editLead" || v === "editTemplate") return;
    if (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      pending = true;
      return;
    }
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
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
    render();
    window.scrollTo(0, y);
  };
  const goTab = (tab) => {
    saveScroll();
    // The Papierkorb is loaded on demand; coming back to Mehr starts closed, so it is never shown stale.
    show({ tab, view: null, quick: false, ...(tab === "mehr" && { trash: null }) }, S().ui.scroll[tab] || 0);
  };
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
    if (u.view === "editLead" || u.view === "editTemplate" || u.compose || u.editField) return;
    ev.preventDefault();
    openSearch();
  });
  const openView = (view, patch = {}) => {
    saveScroll();
    show({ view, ...patch });
  };
  const back = () => {
    const u = S().ui;
    if (u.view === "editLead" && u.leadId && currentLead(S())) return openView("detail");
    show({ view: null }, u.scroll[u.tab] || 0);
  };
  const openLead = (id) => openView("detail", { leadId: id, compose: null, lostPick: false, editField: null, changes: null, expanded: new Set() });
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
  let qeSaving = false;
  async function saveQuickEdit() {
    const x = root.querySelector("#qe");
    const lead = currentLead(S());
    if (!x || !lead || qeSaving) return;
    qeSaving = true;
    const changed = await run(() => uc.updateField(lead, x.dataset.field, x.value));
    qeSaving = false;
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
    edit: () => openView("editLead"),
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
      const id = await run(() => saveLeadForm(uc, S().ui.leadId, root.querySelector("#form").elements), "Gespeichert");
      if (id) openLead(id);
    },
    async deleteLead() {
      const lead = currentLead(S());
      if (!lead) return toast("Betrieb nicht gefunden");
      if (!confirm(`\u201E${lead.name}\u201C l\xF6schen? Er kommt in den Papierkorb (unter Mehr) und l\xE4sst sich von dort wiederherstellen.`)) return;
      if (await run(() => uc.deleteLead(lead).then(() => true), "Im Papierkorb")) show({ view: null, trash: null });
    },
    tplNew: () => openView("editTemplate", { templateId: null }),
    async tplSave() {
      const f = root.querySelector("#tform");
      const id = await run(() => uc.saveTemplate(S().ui.templateId, { name: f.elements.name.value, purpose: f.elements.purpose.value, body: f.elements.body.value }), "Vorlage gespeichert");
      if (id) show({ view: null });
    },
    async tplDelete() {
      if (!confirm("Vorlage l\xF6schen?")) return;
      if (await run(() => uc.deleteTemplate(S().ui.templateId).then(() => true), "Gel\xF6scht")) show({ view: null });
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
    if (d.tpl) return openView("editTemplate", { templateId: d.tpl });
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
    const writes = d.status || d.lost || d.fu || d.restore || d.purge || d.act && !UI_ONLY_ACTIONS.has(d.act);
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
  render();
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
