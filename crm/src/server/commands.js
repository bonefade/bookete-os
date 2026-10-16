import { z } from "zod";
import { LEAD_FIELDS } from "../domain/lead.js";
import { IMPORT_CHUNK } from "../domain/backup.js";

const id = z.string().min(1).max(100);
const text = z.string().max(20000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// optOutAt is not writable here: only optOut / clearOptOut may set it.
export const LeadInput = z.object(Object.fromEntries(Object.keys(LEAD_FIELDS).filter((k) => k !== "optOutAt").map((k) =>
  [k, k === "fit" ? z.coerce.number().int().min(1).max(3) : k === "followUp" ? date.nullable() : text.nullable()]
))).partial().strict();
const ActivityInput = z.object({ direction: z.enum(["out", "in"]), channel: z.string().max(40), date: z.union([date, z.literal("")]).optional(), text, templateId: z.string().max(100).nullish() });
const Email = z.object({ id, subject: z.string().min(1).max(300), text: text.min(1), templateId: z.string().max(100).nullish() });

/** Web-app commands: name → input schema and the use case it runs. */
export const COMMANDS = {
  addLead: [z.object({ input: LeadInput }), (uc, a) => uc.addLead(a.input)],
  updateLead: [z.object({ id, input: LeadInput }), (uc, a) => uc.updateLead(a.id, a.input)],
  updateField: [z.object({ id, key: LeadInput.keyof(), value: z.union([text, z.number()]).nullable() }), (uc, a) => uc.updateField(a.id, a.key, a.value)],
  deleteLead: [z.object({ id }), (uc, a) => uc.deleteLead(a.id)],
  restoreLead: [z.object({ id }), (uc, a) => uc.restoreLead(a.id)],
  purgeLead: [z.object({ id }), (uc, a) => uc.purgeLead(a.id)],
  changeStatus: [z.object({ id, status: z.string() }), (uc, a) => uc.changeStatus(a.id, a.status)],
  setLostReason: [z.object({ id, reason: z.string() }), (uc, a) => uc.setLostReason(a.id, a.reason)],
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
