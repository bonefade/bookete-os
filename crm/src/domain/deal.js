import { ValidationError } from './errors.js';
import { isDate } from './dates.js';
import { oneLine as line } from './lead.js';

/**
 * What a customer agreed on beyond its package (customer.js): the price, who hosts, the day of the contract and one
 * free line. It lives on the lead record, so the write guard, history, trash, erase and backup cover it. Empty is "",
 * never null: the store writes a patch as RFC 7396, which drops a null nested in an object.
 */
export const HOSTING = [["care", "Care (wir hosten)"], ["selbst", "Selbst gehostet"]];
export const EMPTY_DEAL = { price: "", hosting: "", signedAt: "", note: "" };

/** A stored or given deal in today's shape. A value not allowed is refused, never replaced. */
export function normalizeDeal(input) {
  const d = input || {};
  const hosting = d.hosting ?? "";
  if (hosting && !HOSTING.some(([k]) => k === hosting)) throw new ValidationError("hosting", "Unbekanntes Hosting");
  const signedAt = line(d.signedAt, 20);
  if (signedAt && !isDate(signedAt)) throw new ValidationError("signedAt", "Datum ung\xFCltig");
  return { price: line(d.price, 200), hosting, signedAt, note: line(d.note, 500) };
}
/** A lead's deal in today's shape; a lead that never had one has the empty one. */
export const dealOf = (lead) => normalizeDeal(lead.deal);
/** The deal with the given fields changed; the others stay. */
export const dealAfter = (deal, change) => normalizeDeal({ ...deal, ...change });
