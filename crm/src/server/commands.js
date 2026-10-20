import { z } from "zod";
import { LEAD_FIELDS } from "../domain/lead.js";
import { IMPORT_CHUNK } from "../domain/backup.js";
import { STAGES, LOST_REASONS, SPOKEN_REASONS, CALL_OUTCOMES } from "../domain/constants.js";
import { SYSTEMS, ACCOUNT_LIMIT } from "../domain/account.js";
import { ONBOARDING, PACKAGES, PHASES, CANCEL_REASONS, CHECK_IN_RESULTS } from "../domain/customer.js";
import { HOSTING } from "../domain/deal.js";
import { NOTE_MAX } from "../domain/notes.js";

const id = z.string().min(1).max(100);
const text = z.string().max(20000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Status = z.enum(STAGES.map(([k]) => k));
export const Reason = z.enum(LOST_REASONS);
// lostReason takes "" from the form's empty option; normalizeLead then asks for a reason where one is needed.
const FIELD = { fit: z.coerce.number().int().min(1).max(3), followUp: date.nullable(), contactedAt: date.nullable(), status: Status, lostReason: z.union([Reason, z.literal("")]).nullable() };
// optOutAt is not writable here: it is set by optOut or by picking the opt-out reason, and cleared only by clearOptOut.
export const LeadInput = z.object(Object.fromEntries(Object.keys(LEAD_FIELDS).filter((k) => k !== "optOutAt" && k !== "wonAt").map((k) => [k, FIELD[k] ?? text.nullable()]))).partial().strict();
// The Kundenakte, part by part; normalizeAccount checks values. Strict, so no field for a password can be added.
const str = (max) => z.string().max(max).nullish();
const System = z.object({ what: str(200), by: str(100) }).strict();
export const AccountInput = z.object({
  systems: z.object({ ...Object.fromEntries(SYSTEMS.map(([k]) => [k, System])), access: str(500) }).strict().partial(),
  contacts: z.array(z.object({ id: str(100), name: z.string().max(200), company: str(200), role: str(200), handles: str(500), email: str(200), phone: str(100), note: str(2000) }).strict()).max(ACCOUNT_LIMIT),
}).partial().strict();
// What a customer agreed on, field by field; normalizeDeal checks values. "" clears a field.
export const DealInput = z.object({
  price: str(200),
  hosting: z.union([z.enum(HOSTING.map(([k]) => k)), z.literal("")]).nullish(),
  signedAt: z.union([date, z.literal("")]).nullish(),
  note: str(500),
}).partial().strict();
const ActivityInput = z.object({ direction: z.enum(["out", "in"]), channel: z.string().max(40), date: z.union([date, z.literal("")]).optional(), text, templateId: z.string().max(100).nullish() });
// One call, or one appointment, and how it ended; callActivity and meetingPatch refuse a field the outcome does not take.
const time = z.string().regex(/^\d{2}:\d{2}$/);
const SpokenReason = z.enum(SPOKEN_REASONS);
export const CallInput = z.object({ outcome: z.enum(CALL_OUTCOMES.map(([k]) => k)), day: date.optional(), date: date.optional(), time: time.optional(), reason: SpokenReason.optional(), note: z.string().max(2000).optional() }).strict();
export const MeetingInput = z.object({ id, result: z.enum(["kunde", "kein-abschluss", "neuer-termin"]), reason: SpokenReason.optional(), date: date.optional(), time: time.optional() }).strict();
// One change to a customer's care: a step done, open again or skipped; the package; the owner ("" for none); the phase; or a check-in.
const CustomerChange = z.union([
  z.object({ id, step: z.enum(ONBOARDING.map(([k]) => k)), done: z.boolean().optional(), skip: z.string().max(200).optional() }).strict(),
  z.object({ id, package: z.enum(PACKAGES.map(([k]) => k)) }).strict(),
  z.object({ id, owner: z.union([z.email().max(200), z.literal("")]) }).strict(),
  z.object({ id, phase: z.enum(PHASES.map(([k]) => k)), reason: z.enum(CANCEL_REASONS).optional() }).strict(),
  z.object({ id, checkIn: z.enum(CHECK_IN_RESULTS.map(([k]) => k)), note: z.string().max(500).optional(), next: date.optional() }).strict(),
]);
// One change to a business's todos: a new one with an optional due day, one done or open again, its text or due day, or gone.
const dueDay = z.union([date, z.literal("")]);
const TodoChange = z.union([
  z.object({ id, add: z.string().min(1).max(300), due: dueDay.optional() }).strict(),
  z.object({ id, todo: id, done: z.boolean() }).strict(),
  z.object({ id, todo: id, text: z.string().min(1).max(300).optional(), due: dueDay.optional() }).strict().refine((c) => "text" in c || "due" in c, "Text oder Datum"),
  z.object({ id, todo: id, remove: z.literal(true) }).strict(),
]);
// One change to a business's notes: a new one, its text, or gone.
const NoteChange = z.union([
  z.object({ id, add: z.string().min(1).max(NOTE_MAX) }).strict(),
  z.object({ id, note: id, text: z.string().min(1).max(NOTE_MAX) }).strict(),
  z.object({ id, note: id, remove: z.literal(true) }).strict(),
]);
const Email = z.object({ id, subject: z.string().min(1).max(300), text: text.min(1), templateId: z.string().max(100).nullish(), replyTo: id.nullish(), signed: z.boolean().optional() });

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
  logCall: [CallInput.extend({ id }), (uc, { id: leadId, ...call }) => uc.logCall(leadId, call)],
  undoCall: [z.object({ activityId: id }), (uc, a) => uc.undoCall(a.activityId)],
  meetingOutcome: [MeetingInput, (uc, { id: leadId, ...meeting }) => uc.meetingOutcome(leadId, meeting)],
  changeTodo: [TodoChange, (uc, { id: leadId, ...change }) => uc.changeTodo(leadId, change)],
  changeCustomer: [CustomerChange, (uc, { id: leadId, ...change }) => uc.changeCustomer(leadId, change)],
  changeDeal: [DealInput.extend({ id }), (uc, { id: leadId, ...change }) => uc.changeDeal(leadId, change)],
  scheduleMeeting: [z.object({ id, date, time: time.optional() }).strict(), (uc, { id: leadId, ...meeting }) => uc.scheduleMeeting(leadId, meeting)],
  closeWithoutReply: [z.object({ id }), (uc, a) => uc.closeWithoutReply(a.id)],
  setFollowUp: [z.object({ id, date: z.union([date, z.literal("")]).nullable() }), (uc, a) => uc.setFollowUp(a.id, a.date)],
  setNextStep: [z.object({ id, text: z.string().max(500) }), (uc, a) => uc.setNextStep(a.id, a.text)],
  changeNote: [NoteChange, (uc, { id: leadId, ...change }) => uc.changeNote(leadId, change)],
  // A page of 1.24.0 still open adds a note so; one more note, as changeNote's add.
  addNote: [z.object({ id, text: z.string().min(1).max(NOTE_MAX) }).strict(), (uc, a) => uc.changeNote(a.id, { add: a.text })],
  logActivity: [z.object({ id, input: ActivityInput }), (uc, a) => uc.logActivity(a.id, a.input)],
  optOut: [z.object({ id, note: z.string().max(1000).optional() }), (uc, a) => uc.optOut(a.id, a.note)],
  clearOptOut: [z.object({ id }), (uc, a) => uc.clearOptOut(a.id)],
  saveTemplate: [z.object({ id: id.nullable(), input: z.object({ name: z.string().max(200), purpose: z.string().max(40), body: text }) }), (uc, a) => uc.saveTemplate(a.id, a.input)],
  deleteTemplate: [z.object({ id }), (uc, a) => uc.deleteTemplate(a.id)],
  saveIcp: [z.object({ icp: z.object({ fit: z.array(z.string().max(500)).max(50), noFit: z.array(z.string().max(500)).max(50), note: z.string().max(2000).optional() }) }), (uc, a) => uc.saveIcp(a.icp)],
  sendEmail: [Email, (uc, a) => uc.sendEmail(a.id, a)],
  signature: [z.object({}), (uc) => uc.signature()],
  // Records are normalized by the use case. At most IMPORT_CHUNK per call, all collections together, so no request
  // costs more queries than a full chunk of activities; the client sends one collection at a time (chunkBackup).
  importBackup: [z.object({ backup: z.object({ format: z.string(), data: z.record(z.string(), z.array(z.looseObject({ id }))).refine((data) => Object.values(data).flat().length <= IMPORT_CHUNK, `At most ${IMPORT_CHUNK} records per call`) }).loose() }), (uc, a) => uc.importBackup(a.backup)],
};
