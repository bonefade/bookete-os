import { STAGE_LABEL } from '../domain/constants.js';
import { activitiesByLead } from './selectors.js';
import { esc, fmtDate } from './format.js';
import { isPipeline } from '../domain/lead.js';
import { regionOf } from '../domain/region.js';

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
  ["name", "Name", 60],
  ["city", "Ort", 30],
  ["person", "Person", 30],
  ["email", "E-Mail", 25],
  ["phone", "Telefon", 25],
  ["instagram", "Instagram", 25],
  ["website", "Website", 20],
  ["hook", "Aufh\xE4nger", 15],
  ["nextStep", "N\xE4chster Schritt", 15],
  ["notes", "Notiz", 10]
];
let idxLeads = null, idxActs = null, idxVal = [];
export function searchIndex(state) {
  const { leads, activities } = state.data;
  if (idxLeads === leads && idxActs === activities) return idxVal;
  const byLead = activitiesByLead(state);
  idxVal = leads.map((l) => {
    const fields = SEARCH_FIELDS.filter(([k]) => l[k]).map(([key, label, w]) => ({ key, label, w, ...fold(l[key]) }));
    const tags = [regionOf(l), STAGE_LABEL[l.status], l.lostReason, l.currentTool !== "unbekannt" ? l.currentTool : "", l.type].filter(Boolean).join(" \xB7 ");
    fields.push({ key: "tags", label: "Merkmale", w: 20, ...fold(tags) });
    for (const a of [...byLead.get(l.id) || []].reverse())
      fields.push({ key: "act", label: `Verlauf ${fmtDate(a.date)} \xB7 ${a.direction === "in" ? "Antwort" : a.channel}`, w: 8, ...fold(a.text) });
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
export function markRanges(f, tokens) {
  const r = [];
  for (const t of tokens) for (let p = f.s.indexOf(t); p >= 0; p = f.s.indexOf(t, p + t.length)) r.push([f.map[p], f.map[p + t.length - 1] + 1]);
  r.sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const x of r) {
    const last = m[m.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else m.push([...x]);
  }
  return m;
}
export function markHtml(src, ranges, from = 0, to = src.length) {
  let h = "", i = from;
  for (const [a, b] of ranges) {
    if (b <= from || a >= to) continue;
    const s = Math.max(a, from), e = Math.min(b, to);
    h += esc(src.slice(i, s)) + "<mark>" + esc(src.slice(s, e)) + "</mark>";
    i = e;
  }
  return h + esc(src.slice(i, to));
}
export function snippetHtml(f, tokens, radius = 45) {
  const ranges = markRanges(f, tokens);
  const src = f.src, len = src.length;
  const first = ranges.length ? ranges[0][0] : 0;
  let from = Math.max(0, first - radius), to = Math.min(len, first + radius * 3);
  if (from > 0) {
    const sp = src.slice(from, first).search(/\s/);
    if (sp >= 0) from += sp + 1;
  }
  if (to < len) {
    const sp = src.lastIndexOf(" ", to);
    if (sp > first) to = sp;
  }
  return (from > 0 ? "… " : "") + markHtml(src, ranges, from, to) + (to < len ? " …" : "");
}
