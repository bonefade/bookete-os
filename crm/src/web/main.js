import { createStore, initialState } from './store.js';
import { mountApp } from './controller.js';
import { createApi } from './api.js';
import { systemClock } from '../adapters/system.js';
import { COLLECTIONS } from '../domain/constants.js';

const POLL_MS = 5000;
const store = createStore(initialState());
const app = mountApp({
  root: document.getElementById("app"),
  tabsEl: document.getElementById("tabs"),
  toastEl: document.getElementById("toast"),
  store,
  clock: systemClock
});

// Live sync: pull everything written since the last seq. Runs on a timer, on tab focus and after each own write.
const records = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
let seq = 0, running = null, again = false;
async function pull() {
  const { seq: next, changes } = await api.changes(seq);
  const touched = new Set(seq ? [] : COLLECTIONS);
  for (const c of changes) {
    if (c.deleted) records[c.collection].delete(c.id);
    else records[c.collection].set(c.id, c.record);
    touched.add(c.collection);
  }
  seq = next;
  for (const name of touched) store.data(name, [...records[name].values()]);
  if (touched.size) app.onDataChanged();
}
function sync() {
  if (running) return (again = true, running);
  running = pull().catch(() => app.fail("Verbindung unterbrochen – versuche es erneut …")).finally(() => {
    running = null;
    if (again) (again = false, sync());
  });
  return running;
}
const api = createApi(sync);

async function boot() {
  const me = await api.me();
  app.connect(api);
  store.set((s) => ({ ...s, me, caps: { db: true, gmail: me.gmail } }));
  await sync();
  setInterval(() => document.visibilityState === "visible" && sync(), POLL_MS);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && sync());
}
boot().catch(() => app.fail("Laden fehlgeschlagen. Seite neu \xF6ffnen."));
