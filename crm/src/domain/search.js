import { STAGE_LABEL, FIELD_LABEL } from './constants.js';
import { timelinesByLead } from './stats.js';
import { isPipeline } from './lead.js';
import { regionOf } from './region.js';
import { notesOf } from './notes.js';

export function fold(text) {
  const src = String(text ?? "");
  let s = "";
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const f = c === "\xDF" || c === "ẞ" ? "ss" : c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    for (const ch of f) {
      s += ch;
      map.push(i);
    }
  }
  map.push(src.length);
  return { src, s, map };
}
export const digitsOf = (s) => String(s || "").replace(/\D/g, "").replace(/^(00)?43/, "").replace(/^0+/, "");
export const SEARCH_FIELDS = [
  ["name", FIELD_LABEL.name, 60],
  ["city", FIELD_LABEL.city, 30],
  ["person", FIELD_LABEL.person, 30],
  ["email", FIELD_LABEL.email, 25],
  ["phone", FIELD_LABEL.phone, 25],
  ["instagram", FIELD_LABEL.instagram, 25],
  ["website", FIELD_LABEL.website, 20],
  ["hook", FIELD_LABEL.hook, 15],
  ["nextStep", FIELD_LABEL.nextStep, 15],
  ["notes", FIELD_LABEL.notes, 10]
];
let idxLeads = null, idxActs = null, idxVal = [];
export function searchIndex(state) {
  const { leads, activities } = state.data;
  if (idxLeads === leads && idxActs === activities) return idxVal;
  const byLead = timelinesByLead(activities);
  idxVal = leads.map((l) => {
    // The notes are searched as one text, every note's.
    const valueOf = (key) => key === "notes" ? notesOf(l).map((n) => n.text).join("\n") : l[key];
    const fields = SEARCH_FIELDS.filter(([k]) => valueOf(k)).map(([key, label, w]) => ({ key, label, w, ...fold(valueOf(key)) }));
    const tags = [regionOf(l), STAGE_LABEL[l.status], l.lostReason, l.currentTool !== "unbekannt" ? l.currentTool : "", l.type].filter(Boolean).join(" \xB7 ");
    fields.push({ key: "tags", label: "Merkmale", w: 20, ...fold(tags) });
    // Newest first: of equal hits in the history, the newest is shown. The web app writes its heading (hitLabel).
    for (const a of [...byLead.get(l.id) || []].reverse())
      fields.push({ key: "act", label: "Verlauf", act: a, w: 8, ...fold(a.text) });
    return { lead: l, fields, phone: digitsOf(l.phone) };
  });
  idxLeads = leads;
  idxActs = activities;
  return idxVal;
}
export const searchTokens = (q) => fold(q).s.split(/\s+/).filter(Boolean);
export const WORD_START = /[\s\-/(.,@&+'"]/;
export function searchLeads(state, q) {
  const tokens = searchTokens(q);
  if (!tokens.length) return [];
  const out = [];
  for (const e of searchIndex(state)) {
    let score = 0, hit = null, ok = true;
    for (const t of tokens) {
      let best = 0, bestF = null;
      for (const f of e.fields) {
        const p = f.s.indexOf(t);
        if (p < 0) continue;
        const atWord = p === 0 || WORD_START.test(f.s[p - 1]);
        const w = f.key === "name" ? p === 0 ? 100 : atWord ? 80 : 60 : f.w + (atWord ? 5 : 0);
        if (w > best) {
          best = w;
          bestF = f;
        }
      }
      if (/^\+?[\d\-/()]{3,}$/.test(t) && e.phone) {
        const d = digitsOf(t);
        if (d.length >= 3 && e.phone.includes(d) && best < 25) {
          best = 25;
          bestF = e.fields.find((f) => f.key === "phone");
        }
      }
      if (!best) {
        ok = false;
        break;
      }
      score += best;
      if (!hit && bestF && bestF.key !== "name" && bestF.key !== "city") hit = bestF;
    }
    if (ok) out.push({ lead: e.lead, score, hit });
  }
  return out.sort((a, b) => b.score - a.score || (isPipeline(b.lead) ? 1 : 0) - (isPipeline(a.lead) ? 1 : 0) || (b.lead.fit || 2) - (a.lead.fit || 2) || a.lead.name.localeCompare(b.lead.name, "de"));
}
