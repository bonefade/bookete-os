export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(update) {
      state = typeof update === "function" ? update(state) : { ...state, ...update };
      listeners.forEach((l) => l(state));
    },
    ui(patch) {
      state = { ...state, ui: { ...state.ui, ...patch } };
      listeners.forEach((l) => l(state));
    },
    data(key, rows) {
      state = { ...state, data: { ...state.data, [key]: rows }, status: { ...state.status, [key]: true } };
      listeners.forEach((l) => l(state));
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    }
  };
}
export const initialState = () => ({
  data: { leads: [], activities: [], templates: [], settings: [] },
  status: { leads: false, activities: false, templates: false, settings: false, failed: "" },
  caps: { db: false, gmail: false, gmailRead: false },
  me: null,
  ui: { tab: "heute", view: null, leadId: null, templateId: null, status: "offen", kPhase: "aktiv", kOwner: "alle", cancelPick: false, checkIn: null, hAll: false, todoDraft: null, todoEdit: null, todosDone: false, reason: "alle", contacted: "alle", q: "", gq: "", sIdx: 0, searchOpen: false, region: "alle", tool: "alle", contact: "alle", sort: "prio", quick: false, compose: null, expanded: new Set(), icpEdit: false, lostPick: false, call: null, termin: null, meeting: null, round: null, statusMenu: false, nextEdit: false, infoOpen: false, feed: "alle", changesOpen: false, later: false, script: false, editField: null, changes: null, trash: null, trashBefore: null, scroll: {} }
});
