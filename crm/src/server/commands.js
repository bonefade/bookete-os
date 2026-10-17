import { z } from "zod";
import { LEAD_FIELDS } from "../domain/lead.js";
import { IMPORT_CHUNK } from "../domain/backup.js";
import { STAGES, LOST_REASONS } from "../domain/constants.js";
import { SERVICE_KINDS, SERVICE_STATES, OWNERS, SYSTEMS, ACCOUNT_LIMIT } from "../domain/account.js";

const id = z.string().min(1).max(100);
const text = z.string().max(20000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Status = z.enum(STAGES.map(([k]) => k));
export const Reason = z.enum(LOST_REASONS);
// lostReason takes "" from the form's empty option; normalizeLead then asks for a reason where one is needed.
const FIELD = { fit: z.coerce.number().int().min(1).max(3), followUp: date.nullable(), contactedAt: date.nullable(), status: Status, lostReason: z.union([Reason, z.literal("")]).nullable() };
// optOutAt is not writable here: it is set by optOut or by picking the opt-out reason, and cleared only by clearOptOut.
export const LeadInput = z.object(Object.fromEntries(Object.keys(LEAD_FIELDS).filter((k) => k !== "optOutAt").map((k) => [k, FIELD[k] ?? text.nullable()]))).partial().strict();
// The Kundenakte, part by part; normalizeAccount checks values. Strict, so no field for a password can be added.
// Choices and dates also take "" from the form's empty option and empty date field.
const str = (max) => z.string().max(max).nullish();
const choice = (values) => z.union([z.enum(values), z.literal("")]).nullish();
const day = z.union([date, z.literal("")]).nullish();
const Owner = choice(OWNERS.map(([k]) => k));
const System = z.object({ what: str(200), by: str(100) }).strict();
export const AccountInput = z.object({
  services: z.array(z.object({ id: str(100), kind: choice(SERVICE_KINDS), state: choice(SERVICE_STATES.map(([k]) => k)), since: day, goLive: day, contractEnd: day, price: str(200), note: str(2000) }).strict()).max(ACCOUNT_LIMIT),
  systems: z.object({ ...Object.fromEntries(SYSTEMS.map(([k]) => [k, System])), domainOwner: Owner, registrar: str(200), googleProfile: Owner, access: str(500) }).strict().partial(),
  contacts: z.array(z.object({ id: str(100), name: z.string().max(200), company: str(200), role: str(200), handles: str(500), email: str(200), phone: str(100), note: str(2000) }).strict()).max(ACCOUNT_LIMIT),
}).partial().strict();
const ActivityInput = z.object({ direction: z.enum(["out", "in"]), channel: z.string().max(40), date: z.union([date, z.literal("")]).optional(), text, templateId: z.string().max(100).nullish() });
const Email = z.object({ id, subject: z.string().min(1).max(300), text: text.min(1), templateId: z.string().max(100).nullish() });

/** Web-app commands: name → input schema and the use case it runs. */
export const COMMANDS = {
  addLead: [z.object({ input: LeadInput }), (uc, a) => uc.addLead(a.input)],
  updateLead: [z.object({ id, input: LeadInput }), (uc, a) => uc.updateLead(a.id, a.input)],
  updateField: [z.discriminatedUnion("key", Object.entries(LeadInput.shape).map(([key, value]) => z.object({ id, key: z.literal(key), value }))), (uc, a) => uc.updateField(a.id, a.key, a.value)],
  deleteLead: [z.object({ id }), (uc, a) => uc.deleteLead(a.id)],
  restoreLead: [z.object({ id }), (uc, a) => uc.restoreLead(a.id)],
  purgeLead: [z.object({ id }), (uc, a) => uc.purgeLead(a.id)],
  changeStatus: [z.object({ id, status: Status, reason: Reason.optional() }), (uc, a) => uc.changeStatus(a.id, a.status, a.reason)],
  setLostReason: [z.object({ id, reason: Reason }), (uc, a) => uc.setLostReason(a.id, a.reason)],
  saveAccount: [z.object({ id, account: AccountInput, before: AccountInput }), (uc, a) => uc.saveAccount(a.id, a.account, a.before)],
  closeWithoutReply: [z.object({ id }), (uc, a) => uc.closeWithoutReply(a.id)],
  setFollowUp: [z.object({ id, date: z.union([date, z.literal("")]).nullable() }), (uc, a) => uc.setFollowUp(a.id, a.date)],
  setNextStep: [z.object({ id, text: z.string().max(500) }), (uc, a) => uc.setNextStep(a.id, a.text)],
  logActivity: [z.object({ id, input: ActivityInput }), (uc, a) => uc.logActivity(a.id, a.input)],
  optOut: [z.object({ id, note: z.string().max(1000).optional() }), (uc, a) => uc.optOut(a.id, a.note)],
  clearOptOut: [z.object({ id }), (uc, a) => uc.clearOptOut(a.id)],
  saveTemplate: [z.object({ id: id.nullable(), input: z.object({ name: z.string().max(200), purpose: z.string().max(40), body: text }) }), (uc, a) => uc.saveTemplate(a.id, a.input)],
  deleteTemplate: [z.object({ id }), (uc, a) => uc.deleteTemplate(a.id)],
  saveIcp: [z.object({ icp: z.object({ fit: z.array(z.string().max(500)).max(50), noFit: z.array(z.string().max(500)).max(50), note: z.string().max(2000).optional() }) }), (uc, a) => uc.saveIcp(a.icp)],
  sendEmail: [Email, (uc, a) => uc.sendEmail(a.id, a)],
  // Records are normalized by the use case; the client sends at most IMPORT_CHUNK per call.
  importBackup: [z.object({ backup: z.object({ format: z.string(), data: z.record(z.string(), z.array(z.looseObject({ id })).max(IMPORT_CHUNK)) }).loose() }), (uc, a) => uc.importBackup(a.backup)],
};
