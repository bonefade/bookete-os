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
  caps: { db: false, gmail: false },
  me: null,
  ui: { tab: "heute", view: null, leadId: null, templateId: null, status: "offen", reason: "alle", contacted: "alle", q: "", gq: "", sIdx: 0, region: "alle", tool: "alle", contact: "alle", sort: "prio", quick: false, compose: null, expanded: new Set(), icpEdit: false, lostPick: false, call: null, meeting: null, calling: null, script: false, editField: null, changes: null, trash: null, scroll: {} }
});
