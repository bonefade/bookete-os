import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createD1 } from "./d1.js";
import { upgradeLead, LEAD_FIELDS } from "../src/domain/lead.js";

const MIGRATION_0003 = readFileSync(new URL("../migrations/0003_statuses.sql", import.meta.url), "utf8");
const OPT_OUT = "Keine Kontaktaufnahme gew\xFCnscht";
const ACTOR = "jo@bookete.com (web)";

// A lead as 1.3 stored it: lead n was created on 2026-03-n and last written on 2026-09-n.
const day = (n) => String(n).padStart(2, "0");
const old = (n, fields) => ({ name: `Betrieb ${n}`, city: "Graz", fit: 2, schemaVersion: 2, createdAt: `2026-03-${day(n)}T08:00:00.000Z`, updatedAt: `2026-09-${day(n)}T08:00:00.000Z`, ...fields });
const act = (leadId, date, direction, deleted = 0) => ({ deleted, data: { leadId, date, direction, channel: "Telefon", text: "Anruf", templateId: null, createdAt: `${date}T10:00:00.000Z` } });

// Missing keys are what 1.3's json_patch left after writing null.
const LEADS = {
  l01: old(1, { status: "recherchiert", followUp: "2026-10-20" }),
  l02: old(2, { status: "recherchiert" }),
  l03: old(3, { status: "recherchiert" }),
  l04: old(4, { status: "kontaktiert", followUp: "2026-10-18" }),
  l05: old(5, { status: "antwort", followUp: "2026-10-16" }),
  l06: old(6, { status: "demo", followUp: "2026-10-22" }),
  l07: old(7, { status: "onboarding", followUp: "2026-10-25" }),
  l08: old(8, { status: "kunde" }),
  l09: old(9, { status: "kunde", optOutAt: "2026-08-01" }),
  l10: old(10, { status: "kein-interesse", lostReason: "Hat schon ein Tool" }),
  l11: old(11, { status: "kein-interesse", lostReason: "Hat schon ein Tool" }),
  l12: old(12, { status: "kein-interesse", lostReason: "Sonstiges" }),
  l13: old(13, { status: "kein-interesse", lostReason: "Keine Antwort" }),
  l14: old(14, { status: "kein-interesse", lostReason: "Zu wenig Reservierungen", followUp: "2026-11-01" }),
  l15: old(15, { status: "kein-interesse", lostReason: "Telefon reicht ihnen" }),
  l16: old(16, { status: "kein-interesse", lostReason: "Sp\xE4ter nochmal", followUp: "2026-12-01" }),
  l17: old(17, { status: "kein-interesse" }),
  l18: old(18, { status: "kein-interesse", lostReason: OPT_OUT, optOutAt: "2026-07-07" }),
  l19: old(19, { status: "kein-interesse", lostReason: OPT_OUT }),
  l20: (({ updatedAt: _, ...l }) => l)(old(20, { status: "kein-interesse", lostReason: OPT_OUT })),
  l21: old(21, { status: "kein-interesse", lostReason: "Hat schon ein Tool", optOutAt: "2026-08-21" }),
  l22: old(22, { status: "kontaktiert", optOutAt: "2026-08-22", followUp: "2026-10-19" }),
  l23: (({ schemaVersion: _, ...l }) => l)(old(23, { status: "recherchiert" })),
  // Partly written by 1.4.0 before the migration: new values, old schemaVersion.
  l24: old(24, { status: "qualifiziert" }),
  l25: old(25, { status: "kontaktiert", contactedAt: "2026-06-15" }),
  l26: old(26, { status: "disqualifiziert", lostReason: "Nicht unsere Zielgruppe" }),
  l27: old(27, { status: "kunde", lostReason: "Hat schon ein Tool" }),
  // In the Papierkorb.
  l28: old(28, { status: "recherchiert" }),
  l29: old(29, { status: "kein-interesse", lostReason: "Zu wenig Reservierungen", followUp: "2026-10-30" }),
  l30: {},
  l31: { ...old(31, { status: "neu", contactedAt: null, lostReason: null, optOutAt: null, followUp: null }), schemaVersion: 3 },
  // An old import stored a timestamp in another format: no date is cut from it.
  l32: { ...old(2, { status: "kein-interesse", lostReason: OPT_OUT }), updatedAt: "01.10.2026 08:00" },
  // A call 1.3 logged ahead of its day is no first contact yet.
  l33: old(3, { status: "recherchiert" }),
  l34: old(4, { status: "antwort" }),
  // No status key at all: neu, as the store reads it.
  l35: old(5, {}),
};
const TRASHED = new Set(["l28", "l29", "l30"]);
const ACTIVITIES = {
  a01: act("l02", "2026-05-10", "out"),
  a02: act("l02", "2026-05-03", "out"),
  a03: act("l02", "2026-04-01", "out", 1),
  a04: act("l02", "2026-04-15", "in"),
  a05: act("l03", "2026-05-05", "in"),
  a06: act("l07", "2026-04-02", "out"),
  a07: act("l11", "2026-06-01", "out"),
  a08: act("l15", "2026-06-03", "out"),
  a09: act("l25", "2026-06-01", "out"),
  a10: act("l28", "2026-04-22", "out", 1),
  a11: act("l28", "2026-04-20", "out", 1),
  // No write path leaves a live activity on a trashed lead; here it proves the rule only reads the trashed ones.
  a12: act("l28", "2026-04-10", "out"),
  a13: act("l31", "2026-06-06", "out"),
  a14: act("l33", "2999-01-01", "out"),
  a15: act("l34", "2999-01-01", "out"),
};
// Written by hand from the rule in the plan, not from upgradeLead: [status, lostReason, contactedAt, optOutAt, followUp].
const EXPECTED = {
  l01: ["neu", null, null, null, "2026-10-20"],
  l02: ["kontaktiert", null, "2026-04-15", null, null],
  l03: ["kontaktiert", null, "2026-05-05", null, null],
  l04: ["kontaktiert", null, "2026-03-04", null, "2026-10-18"],
  l05: ["kontaktiert", null, "2026-03-05", null, "2026-10-16"],
  l06: ["qualifiziert", null, "2026-03-06", null, "2026-10-22"],
  l07: ["kunde", null, "2026-04-02", null, "2026-10-25"],
  l08: ["kunde", null, "2026-03-08", null, null],
  l09: ["kunde", null, "2026-03-09", "2026-08-01", null],
  l10: ["neu", null, null, null, null],
  l11: ["kontaktiert", null, "2026-06-01", null, null],
  l12: ["neu", null, null, null, null],
  l13: ["kontaktiert", null, "2026-03-13", null, null],
  l14: ["disqualifiziert", "Zu klein", null, null, null],
  l15: ["disqualifiziert", "Kein Bedarf", "2026-06-03", null, null],
  l16: ["neu", null, null, null, "2026-12-01"],
  l17: ["neu", null, null, null, null],
  l18: ["disqualifiziert", OPT_OUT, null, "2026-07-07", null],
  l19: ["disqualifiziert", OPT_OUT, null, "2026-09-19", null],
  l20: ["disqualifiziert", OPT_OUT, null, "2026-03-20", null],
  l21: ["disqualifiziert", OPT_OUT, null, "2026-08-21", null],
  l22: ["disqualifiziert", OPT_OUT, "2026-03-22", "2026-08-22", null],
  l23: ["neu", null, null, null, null],
  l24: ["qualifiziert", null, "2026-03-24", null, null],
  l25: ["kontaktiert", null, "2026-06-15", null, null],
  l26: ["disqualifiziert", "Nicht unsere Zielgruppe", null, null, null],
  l27: ["kunde", null, "2026-03-27", null, null],
  l28: ["kontaktiert", null, "2026-04-20", null, null],
  l29: ["disqualifiziert", "Zu klein", null, null, null],
  l32: ["disqualifiziert", OPT_OUT, null, "2026-03-02", null],
  l33: ["neu", null, null, null, null],
  l34: ["kontaktiert", null, "2026-03-04", null, null],
  l35: ["neu", null, null, null, null],
};
const UNTOUCHED = ["l30", "l31"];

// Seqs out of id order, so the test sees that new seqs follow the old ones.
const leadIds = Object.keys(LEADS);
const LEAD_SEQ = Object.fromEntries(leadIds.map((id, i) => [id, ((i + 1) * 11) % leadIds.length + 1]));
const OLD_COUNTER = leadIds.length + Object.keys(ACTIVITIES).length;

/** A database at schema 0002 holding the seed, plus any extra lead rows. */
async function seeded(extra = {}) {
  const db = createD1({ until: "0002" });
  const insert = (collection, id, data, seq, deleted) => db.prepare("INSERT INTO docs (collection, id, data, seq, deleted, updated_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(collection, id, JSON.stringify(data), seq, deleted, ACTOR).run();
  for (const id of leadIds) await insert("leads", id, LEADS[id], LEAD_SEQ[id], TRASHED.has(id) ? 1 : 0);
  let seq = leadIds.length;
  for (const [id, a] of Object.entries(ACTIVITIES)) await insert("activities", id, a.data, ++seq, a.deleted);
  for (const [id, data] of Object.entries(extra)) await insert("leads", id, data, ++seq, 0);
  await db.prepare("UPDATE counter SET seq = ? WHERE id = 1").bind(seq).run();
  return db;
}
/** As wrangler applies a migration: the whole file in one transaction, undone if any statement fails. */
async function migrate(db, sql = MIGRATION_0003) {
  try {
    await db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}
const rows = async (db) => (await db.prepare("SELECT collection, id, data, seq, deleted, updated_by FROM docs ORDER BY collection, id").all()).results
  .map((r) => ({ ...r, data: JSON.parse(r.data) }));
const counter = async (db) => (await db.prepare("SELECT seq FROM counter WHERE id = 1").first()).seq;
const history = async (db) => (await db.prepare("SELECT * FROM history ORDER BY seq").all()).results;
const leadsOf = (all) => Object.fromEntries(all.filter((r) => r.collection === "leads").map((r) => [r.id, r]));

test("0003 rewrites every pre-1.4.0 lead to the five statuses, as written by hand", async () => {
  const db = await seeded();
  await migrate(db);
  const leads = leadsOf(await rows(db));
  for (const [id, [status, lostReason, contactedAt, optOutAt, followUp]] of Object.entries(EXPECTED))
    assert.deepEqual(leads[id].data, { ...LEADS[id], status, lostReason, contactedAt, optOutAt, followUp, schemaVersion: 3 }, id);
  for (const id of UNTOUCHED) assert.deepEqual(leads[id].data, LEADS[id], id);
});

test("0003 gives the same leads as upgradeLead, the rule an old backup is upgraded by", async () => {
  const db = await seeded();
  await migrate(db);
  const leads = leadsOf(await rows(db));
  // The earliest activity up to today, either way, in the lead's own state: live with live, trashed with trashed.
  const today = new Date().toISOString().slice(0, 10);
  const firstContact = (id) => Object.values(ACTIVITIES).filter((a) => a.data.leadId === id && a.deleted === (TRASHED.has(id) ? 1 : 0))
    .map((a) => a.data.date).filter((d) => d <= today).sort()[0] ?? null;
  // A row without a status reads as LEAD_FIELDS' status.
  for (const id of leadIds.filter((id) => id !== "l30")) assert.deepEqual(leads[id].data, upgradeLead({ status: LEAD_FIELDS.status, ...LEADS[id] }, firstContact(id)), id);
});

// An old import stored timestamps in another format, and no contact is logged: the upgrade finds no date where a
// 1.4.0 lead needs one. 0003 dates it today, as normalizeLead does on a write.
test("0003 dates a first contact or an opt-out it finds no day for today", async () => {
  const broken = { createdAt: "16.03.2026 08:00", updatedAt: "01.10.2026 08:00" };
  const extra = {
    x1: { ...old(47, { status: "kontaktiert" }), ...broken },
    x2: { ...old(48, { status: "kein-interesse", lostReason: OPT_OUT }), ...broken },
  };
  const today = new Date().toISOString().slice(0, 10);
  const db = await seeded(extra);
  await migrate(db);
  const migrated = leadsOf(await rows(db));
  const rule = (l) => ["status", "lostReason", "contactedAt", "optOutAt"].map((k) => l[k] ?? null);
  assert.deepEqual(rule(migrated.x1.data), ["kontaktiert", null, today, null]);
  assert.deepEqual(rule(migrated.x2.data), ["disqualifiziert", OPT_OUT, null, today]);
});

test("0003: live leads get new seqs in their old order and a history row, trashed ones keep theirs, a second run changes nothing", async () => {
  const db = await seeded();
  const before = await rows(db);
  const historyBefore = await history(db);
  await migrate(db);
  const after = await rows(db);
  const leads = leadsOf(after);

  const live = Object.keys(EXPECTED).filter((id) => !TRASHED.has(id)).sort((a, b) => LEAD_SEQ[a] - LEAD_SEQ[b]);
  assert.deepEqual(live.map((id) => leads[id].seq), live.map((_, i) => OLD_COUNTER + 1 + i));
  assert.equal(await counter(db), OLD_COUNTER + live.length);
  for (const id of live) assert.equal(leads[id].updated_by, "migration 0003", id);

  const added = (await history(db)).slice(historyBefore.length);
  assert.deepEqual(added.map((h) => [h.seq, h.collection, h.id, JSON.parse(h.before), JSON.parse(h.after), h.deleted, h.actor]),
    live.map((id) => [leads[id].seq, "leads", id, LEADS[id], leads[id].data, 0, "migration 0003"]));

  // Trashed leads change in place; the tombstone, the current lead and every activity not at all.
  const old = leadsOf(before);
  for (const id of ["l28", "l29"]) assert.deepEqual([leads[id].seq, leads[id].deleted, leads[id].updated_by], [old[id].seq, 1, ACTOR], id);
  for (const id of UNTOUCHED) assert.deepEqual(leads[id], old[id], id);
  assert.deepEqual(after.filter((r) => r.collection === "activities"), before.filter((r) => r.collection === "activities"));

  await migrate(db);
  assert.deepEqual(await rows(db), after);
  assert.equal((await history(db)).length, historyBefore.length + live.length);
  assert.equal(await counter(db), OLD_COUNTER + live.length);
});

test("0003's last statement fails the migration on any lead that breaks a 1.4.0 rule, and nothing is changed", async () => {
  const v3 = (n, fields) => ({ ...old(n, fields), schemaVersion: 3 });
  // Rows already at schema 3 are out of the migration's scope, but the check reads every lead.
  const breaking = {
    "unknown status": old(40, { status: "archiv" }),
    "follow-up on disqualifiziert": v3(41, { status: "disqualifiziert", lostReason: "Zu klein", followUp: "2026-11-01" }),
    "disqualifiziert without a reason": v3(42, { status: "disqualifiziert" }),
    "disqualifiziert with an old reason": v3(43, { status: "disqualifiziert", lostReason: "Sonstiges" }),
    "a reason on an open lead": v3(44, { status: "kontaktiert", contactedAt: "2026-10-01", lostReason: "Zu klein" }),
    "neu with a first contact": v3(45, { status: "neu", contactedAt: "2026-10-01" }),
    "kontaktiert without a first contact": v3(46, { status: "kontaktiert" }),
    "opt-out reason without an opt-out": v3(48, { status: "disqualifiziert", lostReason: OPT_OUT }),
    "opt-out on an open lead": v3(49, { status: "kontaktiert", contactedAt: "2026-10-01", optOutAt: "2026-10-02" }),
    "opt-out with another reason": v3(50, { status: "disqualifiziert", lostReason: "Zu klein", optOutAt: "2026-10-01" }),
    "first contact after today": v3(53, { status: "kontaktiert", contactedAt: "2999-01-01" }),
    "first contact that is not a date": v3(51, { status: "kontaktiert", contactedAt: "16.03.2026" }),
    "opt-out that is not a date": v3(52, { status: "disqualifiziert", lostReason: OPT_OUT, optOutAt: "01.10.2026" }),
  };
  const stale = (e) => /stale_write/.test(e.message);
  for (const [rule, lead] of Object.entries(breaking)) {
    const db = await seeded({ x: lead });
    const [before, historyBefore, counterBefore] = [await rows(db), await history(db), await counter(db)];
    await assert.rejects(migrate(db), stale, rule);
    assert.deepEqual([await rows(db), await history(db), await counter(db)], [before, historyBefore, counterBefore], rule);
  }
  // A rewrite that leaves a lead below schema 3 fails too.
  await assert.rejects(migrate(await seeded(), MIGRATION_0003.replace("'$.schemaVersion', 3", "'$.schemaVersion', 2")), stale);
});
