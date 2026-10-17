import { z } from "zod";
import { LeadInput, Status, Reason, AccountInput, CallInput } from "./commands.js";
import { STAGES, CHANNELS, LOST_REASONS, OPT_OUT_REASON } from "../domain/constants.js";
import { isDue, takesFollowUp } from "../domain/lead.js";
import { nextActionHint, byTimeline } from "../domain/activity.js";
import { fillTemplate } from "../domain/template.js";
import { regionOf } from "../domain/region.js";
import { ValidationError, ConflictError } from "../domain/errors.js";
import { searchLeads } from "../web/search.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const INSTRUCTIONS = `bookete CRM: restaurants (leads) in Austria that bookete approaches about table reservations.
Statuses: ${STAGES.map(([k, label]) => `${k} (${label})`).join(", ")}. Every write is recorded under the signed-in user.
Rules the server enforces: disqualifiziert needs a reason (${LOST_REASONS.join(" | ")}) and has no follow-up; the reason "${OPT_OUT_REASON}" records an opt-out. Opted-out businesses (optOutAt) must not be contacted. contactedAt is the date of first contact: null on neu, set on kontaktiert, qualifiziert and kunde, either on disqualifiziert. Setting it on a neu lead moves the lead to kontaktiert. Logging any contact moves neu, or disqualifiziert without an opt-out, to kontaktiert; an outgoing message moves the follow-up date by the sequence policy.
A customer's Kundenakte (lead.account: services we deliver, their systems such as domain and DNS and who runs them, contacts including agencies) is read with get_lead and written with update_account, which takes the Kundenakte as read and refuses the write if it changed since. It never holds passwords, only where logins are kept.
A phone call is logged with log_call, which records its outcome and moves the lead on by it; a call never moves a kunde out of kunde.
Agents cannot send email: create_gmail_draft puts a draft into the user's Gmail for a person to review and send. The CRM adds the lead's unsubscribe link at the end, except for a Kunde; do not write one yourself.`;

const id = z.string().describe("Lead id");
const summary = (l, acts, today) => ({
  id: l.id, name: l.name, city: l.city, region: regionOf(l), status: l.status, fit: l.fit, email: l.email || undefined,
  followUp: l.followUp, contactedAt: l.contactedAt, due: isDue(l, today), optOut: !!l.optOutAt, next: takesFollowUp(l) ? nextActionHint(l, acts) : undefined,
});

/** Tools: name → description, input schema, handler. Writes go through the same use cases as the web app. */
const TOOLS = {
  search_leads: ["Search leads by name, place, person, notes or history. Empty query lists all. Filter by status, or only those due for follow-up.",
    z.object({ query: z.string().default(""), status: Status.optional(), dueOnly: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(30) }),
    async ({ query, status, dueOnly, limit }, { store, clock }) => {
      const [leads, activities] = await Promise.all([store.list("leads"), store.list("activities")]);
      const today = clock.today();
      const hits = query.trim() ? searchLeads({ data: { leads, activities } }, query).map((r) => r.lead) : leads;
      const actsOf = (lid) => activities.filter((a) => a.leadId === lid);
      const found = hits.filter((l) => (!status || l.status === status) && (!dueOnly || isDue(l, today)));
      return { total: found.length, leads: found.slice(0, limit).map((l) => summary(l, actsOf(l.id), today)) };
    }],
  get_lead: ["One lead with every field and its full contact history.",
    z.object({ id }),
    async ({ id: leadId }, { store, clock }) => {
      const lead = await store.get("leads", leadId);
      if (!lead) throw new ValidationError("id", "Betrieb nicht gefunden");
      const acts = (await store.activitiesOf(leadId)).sort(byTimeline);
      return { lead, next: nextActionHint(lead, acts), due: isDue(lead, clock.today()), history: acts };
    }],
  create_lead: ["Add a new lead. Only name is required.",
    LeadInput.required({ name: true }),
    async (input, { uc }) => ({ id: await uc.addLead(input) })],
  update_lead: ["Change fields of a lead. Only the given fields change, plus what the rules derive from them. contactedAt (YYYY-MM-DD, not after today) records a first contact made outside the CRM and moves a neu lead to kontaktiert; it cannot be cleared.",
    z.object({ id, fields: LeadInput }),
    async ({ id: leadId, fields }, { uc }) => (await uc.updateLead(leadId, fields), { ok: true })],
  update_account: ["Change a lead's Kundenakte. `before` is lead.account exactly as get_lead returned it ({} if there is none); if the Kundenakte changed since, nothing is saved: read it again. Only the given parts change. services and contacts replace the stored list: send the whole list, and each entry you keep keeps its `id` (an entry without one is new). systems, and each system, change field by field. domain, dns, hosting, email, website and pos are each { what, by }: what it is, and `by`, the id of the contact in the same Kundenakte who runs it. A write that leaves out a contact who runs a system is refused unless it also gives that system's `by`.",
    AccountInput.extend({ id, before: AccountInput.describe("lead.account as get_lead returned it") }),
    async ({ id: leadId, before, ...parts }, { uc }) => (await uc.saveAccount(leadId, parts, before), { ok: true })],
  change_status: [`Move a lead to another status. disqualifiziert needs a lostReason: ${LOST_REASONS.join(" | ")}. Any other status takes none.`,
    z.object({ id, status: Status, lostReason: Reason.optional() }),
    async ({ id: leadId, status, lostReason }, { uc }) => {
      await uc.changeStatus(leadId, status, lostReason);
      return { ok: true };
    }],
  log_activity: ["Record a contact: direction out (we wrote) or in (they answered). Updates status and follow-up date.",
    z.object({ id, direction: z.enum(["out", "in"]), channel: z.enum(CHANNELS), text: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    async ({ id: leadId, ...input }, { uc }) => uc.logActivity(leadId, input)],
  log_call: [`Record a phone call made today and how it ended. nicht-erreicht: no answer, call again in 2 days, unless a follow-up date ahead was not set by the sequence (status other than kontaktiert, or a next step); the 5th attempt without ever getting through closes the lead (Nicht erreicht). rueckruf: they asked to be called back, date (YYYY-MM-DD, from today) required, time (HH:MM) optional. termin: an appointment, date required, time optional; the lead becomes qualifiziert. kein-interesse: reason required; the lead becomes disqualifiziert. A kunde stays kunde whatever the outcome; the reason "${OPT_OUT_REASON}" still records an opt-out. Optional note.`,
    CallInput.extend({ id }),
    async ({ id: leadId, ...call }, { uc }) => uc.logCall(leadId, call)],
  set_follow_up: ["Set or clear the follow-up date (YYYY-MM-DD or null) and optionally the next step.",
    z.object({ id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), nextStep: z.string().max(500).optional() }),
    async ({ id: leadId, date, nextStep }, { uc }) => {
      await uc.setFollowUp(leadId, date);
      if (nextStep !== undefined) await uc.setNextStep(leadId, nextStep);
      return { ok: true };
    }],
  list_templates: ["Message templates with placeholders {Betrieb} {Ort} {Aufhänger} {Person}, and the ideal customer profile. A template with purpose \"leitfaden\" is a call script: never use it for a message.",
    z.object({}),
    async (_, { store }) => ({ templates: await store.list("templates"), icp: await store.get("settings", "icp") })],
  render_template: ["Fill a template for a lead. Returns the text and any placeholders the lead has no value for.",
    z.object({ id, templateId: z.string() }),
    async ({ id: leadId, templateId }, { store }) => {
      const [lead, template] = await Promise.all([store.get("leads", leadId), store.get("templates", templateId)]);
      if (!lead || !template) throw new ValidationError("id", "Betrieb oder Vorlage nicht gefunden");
      if (template.purpose === "leitfaden") throw new ValidationError("templateId", "Ein Gespr\xE4chsleitfaden ist keine Nachricht");
      return fillTemplate(template.body, lead);
    }],
  create_gmail_draft: ["Create a Gmail draft to the lead's email address in the signed-in user's mailbox. Nothing is sent or logged; a person reviews and sends it. The draft ends with the lead's unsubscribe link, unless the lead is a Kunde.",
    z.object({ id, subject: z.string().min(1).max(300), text: z.string().min(1).max(20000) }),
    async ({ id: leadId, ...msg }, { uc }) => uc.draftEmail(leadId, msg)],
};

const reply = (rpcId, result) => Response.json({ jsonrpc: "2.0", id: rpcId, result });
const fail = (rpcId, code, message) => Response.json({ jsonrpc: "2.0", id: rpcId ?? null, error: { code, message } });

/** Stateless MCP over Streamable HTTP: one JSON-RPC request per POST, one JSON response. */
export async function handleMcp(request, context) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  let msg;
  try {
    msg = await request.json();
  } catch {
    return fail(null, -32700, "Parse error");
  }
  if (msg?.id === undefined) return new Response(null, { status: 202 }); // notification
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "bookete-crm", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: Object.entries(TOOLS).map(([name, [description, schema]]) => ({ name, description, inputSchema: z.toJSONSchema(schema, { io: "input" }) })) });
    case "tools/call": {
      const tool = Object.hasOwn(TOOLS, msg.params?.name) && TOOLS[msg.params.name];
      if (!tool) return fail(msg.id, -32602, "Unknown tool");
      const args = tool[1].safeParse(msg.params.arguments ?? {});
      const text = (value, isError = false) => reply(msg.id, { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError });
      if (!args.success) return text(z.prettifyError(args.error), true);
      try {
        return text(await tool[2](args.data, context));
      } catch (e) {
        if (e instanceof ValidationError || e instanceof ConflictError) return text(e.message, true);
        throw e;
      }
    }
    default:
      return fail(msg.id, -32601, "Method not found");
  }
}
