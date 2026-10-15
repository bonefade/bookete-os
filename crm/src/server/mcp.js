import { z } from "zod";
import { LeadInput } from "./commands.js";
import { STAGES, CHANNELS, LOST_REASONS } from "../domain/constants.js";
import { isDue, isOpen } from "../domain/lead.js";
import { nextActionHint, byTimeline } from "../domain/activity.js";
import { fillTemplate } from "../domain/template.js";
import { regionOf } from "../domain/region.js";
import { ValidationError } from "../domain/errors.js";
import { searchLeads } from "../web/search.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const INSTRUCTIONS = `bookete CRM: restaurants (leads) in Austria that bookete approaches about table reservations.
Statuses: ${STAGES.map(([k]) => k).join(", ")}. Every write is recorded under the signed-in user.
Rules the server enforces: opted-out businesses (optOutAt) must not be contacted; logging an outgoing message moves the follow-up date by the sequence policy.
Agents cannot send email: create_gmail_draft puts a draft into the user's Gmail for a person to review and send.`;

const id = z.string().describe("Lead id");
const summary = (l, acts, today) => ({
  id: l.id, name: l.name, city: l.city, region: regionOf(l), status: l.status, fit: l.fit, email: l.email || undefined,
  followUp: l.followUp, due: isDue(l, today), optOut: !!l.optOutAt, next: isOpen(l) ? nextActionHint(l, acts) : undefined,
});

/** Tools: name → description, input schema, handler. Writes go through the same use cases as the web app. */
const TOOLS = {
  search_leads: ["Search leads by name, place, person, notes or history. Empty query lists all. Filter by status, or only those due for follow-up.",
    z.object({ query: z.string().default(""), status: z.enum(STAGES.map(([k]) => k)).optional(), dueOnly: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(30) }),
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
  update_lead: ["Change fields of a lead. Only the given fields change.",
    z.object({ id, fields: LeadInput }),
    async ({ id: leadId, fields }, { uc }) => (await uc.updateLead(leadId, fields), { ok: true })],
  change_status: [`Move a lead to another status. For kein-interesse give a lostReason: ${LOST_REASONS.join(" | ")}.`,
    z.object({ id, status: z.enum(STAGES.map(([k]) => k)), lostReason: z.enum(LOST_REASONS).optional() }),
    async ({ id: leadId, status, lostReason }, { uc }) => {
      await uc.changeStatus(leadId, status);
      if (lostReason) await uc.setLostReason(leadId, lostReason);
      return { ok: true };
    }],
  log_activity: ["Record a contact: direction out (we wrote) or in (they answered). Updates status and follow-up date.",
    z.object({ id, direction: z.enum(["out", "in"]), channel: z.enum(CHANNELS), text: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    async ({ id: leadId, ...input }, { uc }) => uc.logActivity(leadId, input)],
  set_follow_up: ["Set or clear the follow-up date (YYYY-MM-DD or null) and optionally the next step.",
    z.object({ id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), nextStep: z.string().max(500).optional() }),
    async ({ id: leadId, date, nextStep }, { uc }) => {
      await uc.setFollowUp(leadId, date);
      if (nextStep !== undefined) await uc.setNextStep(leadId, nextStep);
      return { ok: true };
    }],
  list_templates: ["Message templates with placeholders {Betrieb} {Ort} {Aufhänger} {Person}, and the ideal customer profile.",
    z.object({}),
    async (_, { store }) => ({ templates: await store.list("templates"), icp: await store.get("settings", "icp") })],
  render_template: ["Fill a template for a lead. Returns the text and any placeholders the lead has no value for.",
    z.object({ id, templateId: z.string() }),
    async ({ id: leadId, templateId }, { store }) => {
      const [lead, template] = await Promise.all([store.get("leads", leadId), store.get("templates", templateId)]);
      if (!lead || !template) throw new ValidationError("id", "Betrieb oder Vorlage nicht gefunden");
      return fillTemplate(template.body, lead);
    }],
  create_gmail_draft: ["Create a Gmail draft to the lead's email address in the signed-in user's mailbox. Nothing is sent or logged; a person reviews and sends it.",
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
      const tool = TOOLS[msg.params?.name];
      if (!tool) return fail(msg.id, -32602, "Unknown tool");
      const args = tool[1].safeParse(msg.params.arguments ?? {});
      const text = (value, isError = false) => reply(msg.id, { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError });
      if (!args.success) return text(z.prettifyError(args.error), true);
      try {
        return text(await tool[2](args.data, context));
      } catch (e) {
        if (e instanceof ValidationError) return text(e.message, true);
        throw e;
      }
    }
    default:
      return fail(msg.id, -32601, "Method not found");
  }
}
