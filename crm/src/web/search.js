import { esc, fmtDate } from './format.js';

/** A hit's heading; one in the history names the entry's day and channel. */
export const hitLabel = (f) => f.act ? `${f.label} ${fmtDate(f.act.date)} \xB7 ${f.act.direction === "in" ? "Antwort" : f.act.channel}` : f.label;
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
