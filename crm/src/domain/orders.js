import { ValidationError } from './errors.js';
import { isDate, addDays, addMonths } from './dates.js';
import { oneLine as line } from './lead.js';
import { PACKAGE_LABEL } from './customer.js';

/**
 * What a customer agreed on, as Aufträge: each what it is, an amount (net €), how often it is paid, its contract day,
 * its runtime and the contract's link. A list on the lead record, so the write guard, history, trash, erase and backup
 * cover it; empty is "", never null, as the store writes a patch as RFC 7396. They replace the one Vereinbarung
 * (`lead.deal`) of before 1.30.0, which reads as one Auftrag until the first write. The kinds decide the customer's
 * package (packageOf).
 */
export const ORDER_KINDS = [["bookete", "bookete"], ["website", "Website"], ["hosting", "Hosting"], ["individuell", "Individuell"], ["sonstiges", "Sonstiges"]];
export const KIND_LABEL = Object.fromEntries(ORDER_KINDS);
export const RHYTHMS = [["einmalig", "einmalig"], ["monatlich", "monatlich"], ["jaehrlich", "j\xE4hrlich"]];
export const RHYTHM_LABEL = Object.fromEntries(RHYTHMS);
export const ORDER_LIMIT = 50;
export const MAX_AMOUNT = 1e6;
export const MAX_MONTHS = 120;
/** The hosting package as we sell it: a .com or a normal local domain included, no premium domains. */
export const HOSTING_CARE = { kind: "hosting", title: "Hosting Care inkl. Domain", amount: 99, rhythm: "jaehrlich", months: 12, renews: true };

const refuse = (field, text) => { throw new ValidationError(field, text); };
const day = (v, field) => v === "" || v == null ? "" : isDate(v) ? v : refuse(field, "Datum ung\xFCltig");
function amountOf(v) {
  if (v === "" || v == null) return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT || Math.round(n * 100) / 100 !== n) refuse("amount", "Betrag in Euro, h\xF6chstens zwei Kommastellen");
  return n;
}
function monthsOf(v) {
  if (v === "" || v == null) return "";
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MONTHS) refuse("months", `Laufzeit in Monaten, 1 bis ${MAX_MONTHS}`);
  return n;
}
function linkOf(v) {
  const url = line(v, 500);
  if (url && !/^https:\/\/\S+$/.test(url)) refuse("contract", "Der Vertragslink beginnt mit https://");
  return url;
}

/** One Auftrag in today's shape; a value not allowed is refused, never replaced. */
function normalizeOrder(o, newId) {
  if (!KIND_LABEL[o.kind]) refuse("kind", "Welche Art von Auftrag?");
  const rhythm = o.rhythm || "einmalig";
  if (!RHYTHM_LABEL[rhythm]) refuse("rhythm", "Unbekannter Rhythmus");
  return {
    id: line(o.id, 100) || newId(),
    kind: o.kind,
    title: line(o.title, 200),
    amount: amountOf(o.amount),
    rhythm,
    signedAt: day(o.signedAt, "signedAt"),
    start: day(o.start, "start"),
    months: monthsOf(o.months),
    renews: o.renews === true,
    contract: linkOf(o.contract),
    note: line(o.note, 500),
  };
}
export function normalizeOrders(list, newId) {
  const orders = (Array.isArray(list) ? list : []).map((o) => normalizeOrder(o || {}, newId));
  if (orders.length > ORDER_LIMIT) refuse("orders", `H\xF6chstens ${ORDER_LIMIT} Auftr\xE4ge`);
  if (new Set(orders.map((o) => o.id)).size !== orders.length) refuse("orders", "Doppelter Auftrag");
  return orders;
}
/**
 * A Vereinbarung of before 1.30.0 as one Auftrag: its contract day kept, the price text, who hosted and its line in
 * the note, the amount open for a person to fill in.
 */
export function orderFromDeal(deal) {
  const hosting = { care: "Hosting: Care", selbst: "Hosting: selbst" }[deal.hosting];
  return normalizeOrder({ id: "vereinbarung", kind: "sonstiges", title: "Vereinbarung", signedAt: isDate(deal.signedAt) ? deal.signedAt : "", note: [deal.price, hosting, deal.note].map((x) => line(x, 200)).filter(Boolean).join(" \xB7 ") }, () => "");
}
/** A lead's Aufträge: those stored, or its Vereinbarung of before as one, or none. */
export const ordersOf = (lead) => lead.orders ? normalizeOrders(lead.orders, () => "") : lead.deal ? [orderFromDeal(lead.deal)] : [];

/**
 * One change to the Aufträge: a new one (`add`, its fields), one changed by id (`order`, only the fields given), or
 * one gone (`order` and `remove`). One already gone is no change to remove.
 */
export function ordersAfter(list, change, { newId }) {
  if ("add" in change) return normalizeOrders([...list, { ...change.add, id: "" }], newId);
  const { order, remove, ...fields } = change;
  if (!list.some((o) => o.id === order)) return remove ? list : refuse("order", "Unbekannter Auftrag");
  if (remove) return list.filter((o) => o.id !== order);
  return normalizeOrders(list.map((o) => o.id === order ? { ...o, ...fields } : o), newId);
}

/** The last day of an Auftrag's runtime, from its start and months; "" for one open-ended or without a start. */
export const orderEnd = (o) => o.start && o.months ? addDays(addMonths(o.start, o.months), -1) : "";
/**
 * A customer's package now: the one picked and stored on its care before 1.30.0 until its first Aufträge are written,
 * as the Vereinbarung of before says nothing of it; from then on its Aufträge's (packageOf).
 */
export const packageOfLead = (lead) => !lead.orders && PACKAGE_LABEL[lead.customer?.package] ? lead.customer.package : packageOf(ordersOf(lead));
/**
 * The customer's package from its Aufträge: a website comes with bookete (the owner, 2026-10-22: "no website customer
 * will get a website without bookete so far"), so a website Auftrag makes both, else bookete.
 */
export const packageOf = (orders) => orders.some((o) => o.kind === "website") ? "beides" : "bookete";
