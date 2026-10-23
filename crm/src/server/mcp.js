import { z } from "zod";
import { notesOf } from "../domain/notes.js";
import { accountOf } from "../domain/account.js";
import { normalizeCustomer } from "../domain/customer.js";
import { ORDER_KINDS, RHYTHMS, HOSTING_CARE, ordersOf } from "../domain/orders.js";
import { LeadInput, Status, Reason, AccountInput, OrderChange, CallInput, MeetingInput } from "./commands.js";
import { STAGES, CHANNELS, LOST_REASONS, OPT_OUT_REASON, RESERVATION_TOOLS } from "../domain/constants.js";
import { isDue, takesFollowUp, addressOpen, isContact, KINDS } from "../domain/lead.js";
import { nextActionHint, byTimeline } from "../domain/activity.js";
import { fillTemplate } from "../domain/template.js";
import { ValidationError, ConflictError } from "../domain/errors.js";
import { searchLeads } from "../domain/search.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const INSTRUCTIONS = `bookete CRM: restaurants (leads) in Austria that bookete approaches about table reservations, and Kontakte.
Statuses: ${STAGES.map(([k, label]) => `${k} (${label})`).join(", ")}. Every write is recorded under the signed-in user.
currentTool is the reservation system they use: one of ${RESERVATION_TOOLS.join(" | ")} (any case), or the name of any other system, such as one new to us.
Rules the server enforces: disqualifiziert needs a reason (${LOST_REASONS.join(" | ")}) and has no follow-up; the reason "${OPT_OUT_REASON}" records an opt-out. Opted-out businesses (optOutAt) must not be contacted. Kontaktiert means someone spoke with them: a message from them, a visit (channel Vor Ort), or a call that got through. contactedAt is the day that first happened: null on neu, set on kontaktiert, qualifiziert and kunde, either on disqualifiziert. Setting it on a neu lead moves the lead to kontaktiert. Logging such a contact moves neu, or disqualifiziert without an opt-out, to kontaktiert. A mail, a DM or a call not answered is an attempt: it is logged, but moves no status and sets no follow-up on a neu or disqualifiziert lead. A neu lead has no follow-up date: set_follow_up refuses one, and update_lead drops it; plan it with a next step instead. A lead nobody has spoken with can go back to neu (change_status), which clears contactedAt, its follow-up and next step; one with a conversation logged, or with a contactedAt recorded for a conversation outside the CRM, cannot.
A customer's Kundenakte (lead.account: their systems, domain, DNS, website and hosting, e-mail, and who runs each; where logins are kept; other contacts such as agencies; the business's own person, email and phone are the lead's fields, not a contact here) is read with get_lead and written with update_account, which takes the Kundenakte as read and refuses the write if it changed since. It never holds passwords, only where logins are kept. A customer's care (lead.customer: the phase Onboarding, Live or Gek\xFCndigt, who looks after it, its own onboarding steps in their order (started from the standard steps of its package, which its Auftr\xE4ge give, below; each with a title, the day it is due and, once done or skipped, when and by whom; people add, remove and reorder them), the check-ins with how they went, and the next check-in day) is read with get_lead; agents cannot change it, except that an Auftrag written with update_order that adds or removes the website adds or removes its onboarding steps. So are a business's todos (lead.todos: text, due day, the day done), which agents cannot change either. What a Kunde agreed on (lead.orders, its Auftr\xE4ge: each with an id, a kind (${ORDER_KINDS.map(([k]) => k).join(" | ")}), a title, an amount in net EUR as a number ("" while open), a rhythm (${RHYTHMS.map(([k]) => k).join(" | ")}), signedAt the day of the contract, start the first day of its runtime, months its runtime ("" for open-ended), renews (true when it renews by itself), contract the https link to the contract, and one free line in note) is read with get_lead (none means nothing agreed yet; hosting is ${HOSTING_CARE.amount} EUR a year with a .com or normal local domain, no premium domains) and written with update_order, one Auftrag at a time. The kinds decide the customer's package: a website comes with bookete, so a website Auftrag makes beides, anything else bookete (a package picked before counts until the first Auftrag is written); a change that moves the package adds the standard onboarding steps of the group it adds, due from that day at the earliest, and removes the open ones of the group it drops. lead.notes is a list of notes, newest first, each with its day, who wrote it and its text; notes given as text to update_lead or create_lead are added as one new note, never replacing those there are.
A phone call is logged with log_call, which records its outcome and moves the lead on by it; a call never moves a kunde out of kunde. How an appointment went is recorded with meeting_outcome.
Mail to and from a lead's address, and replies in a thread the CRM sent, are logged from the users' Gmail by the CRM itself within minutes: do not log them with log_activity.
A Kontakt (kind "kontakt"; a lead without kind is a restaurant, a Betrieb) is a partner, an association or a person we talk to beside the restaurants, around bookete or Tischrunde: Blue Bomb for the partner programme, Skal for Styria. It is made with create_lead and kind "kontakt", which never changes, and has name (the organisation or the person), topic (its Thema, one line of at most 60 characters, such as "Skal Steiermark" or "Partnerprogramm"; reuse one the other Kontakte have), owner (who of the team looks after it, their email; create_lead makes the signed-in user the owner unless one is given; "" for nobody), city, person, email, phone, website, instagram, notes, todos, nextStep and followUp (any day, it shows in Heute when due), and the other people at it as contacts in its Kundenakte (update_account, contacts only: systems are refused). It has no status, contactedAt, opt-out, fit, type, currentTool or hook: those are refused, as are change_status, log_call and meeting_outcome. A conversation with a Kontakt (a call, a meeting) is logged with log_activity (channel Telefon or Vor Ort, direction out, what was said as text); logging changes nothing else on it: a message from them shows in Heute as a new answer until our next contact, and its next step stays what a person planned. Mail to its address is refused, as for a lead, where another business with an opt-out holds the address. A person who already lives on a record (a Betrieb's person, a contact in a Kundenakte) is not added again elsewhere.
Agents cannot send email: create_gmail_draft puts a draft into the user's Gmail for a person to review and send. The CRM adds the lead's unsubscribe link at the end, except for a Kunde or a Kontakt; do not write one yourself.`;

const id = z.string().describe("Lead id");
// Enough to choose a lead, and short, so a page of them stays small; get_lead reads one in full.
// hasEmail: mail to the lead would go out (sendEmail's and create_gmail_draft's rules, addressOpen); `closed`, the
// addresses the businesses with an opt-out hold.
const summary = (l, acts, today, closed) => ({
  id: l.id, name: l.name, ...(isContact(l) && { kind: l.kind, topic: l.topic, owner: l.owner }), city: l.city, status: l.status, fit: l.fit, followUp: l.followUp, due: isDue(l, today),
  next: (takesFollowUp(l) && nextActionHint(l, acts)) || undefined,
  hasEmail: addressOpen(l, closed), hasPhone: !!l.phone, optOut: !!l.optOutAt,
});

/** Tools: name → description, input schema, handler. Writes go through the same use cases as the web app. */
const TOOLS = {
  search_leads: ["Search leads by name, place, person, notes or history, best match first. Empty query lists all, by name. Filter by status, by kind (betrieb: the restaurants; kontakt: the Kontakte, whose summary has kind, topic and owner), or only those due for follow-up. Answers `total` and up to `limit` leads from `offset`, each a short summary; if more match, `nextOffset` is the offset of the next page. hasEmail is false where no mail may go (an opt-out, or another business with an opt-out holds the address). Read one lead in full, with its history, with get_lead.",
    z.object({ query: z.string().default(""), status: Status.optional(), kind: z.enum(KINDS).optional(), dueOnly: z.boolean().default(false), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(30) }),
    async ({ query, status, kind, dueOnly, offset, limit }, { store, clock }) => {
      const [stored, activities, closed] = await Promise.all([store.list("leads"), store.list("activities"), store.closedAddresses()]);
      // The store returns no set order; pages only line up if every call ranks the same leads the same way.
      const leads = stored.sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id));
      const today = clock.today();
      const hits = query.trim() ? searchLeads({ data: { leads, activities } }, query).map((r) => r.lead) : leads;
      const actsOf = (lid) => activities.filter((a) => a.leadId === lid);
      const found = hits.filter((l) => (!status || l.status === status) && (!kind || kind === (isContact(l) ? "kontakt" : "betrieb")) && (!dueOnly || isDue(l, today)));
      const end = offset + limit;
      return { total: found.length, leads: found.slice(offset, end).map((l) => summary(l, actsOf(l.id), today, closed)), nextOffset: end < found.length ? end : undefined };
    }],
  get_lead: ["One lead with every field and its full contact history.",
    z.object({ id }),
    async ({ id: leadId }, { store, clock }) => {
      const lead = await store.get("leads", leadId);
      if (!lead) throw new ValidationError("id", "Betrieb nicht gefunden");
      const acts = (await store.activitiesOf(leadId)).sort(byTimeline);
      // The notes as one list, the text of before as entries too (notesOf); the Kundenakte in today's shape, so it goes
      // back to update_account as `before` as read; the care in today's shape, its whole onboarding however it was stored;
      // the Aufträge, a Vereinbarung of before as one.
      const { noteEntries: _entries, deal: _deal, ...fields } = lead;
      const orders = ordersOf(lead);
      return { lead: { ...fields, notes: notesOf(lead), ...(lead.account && { account: accountOf(lead) }), ...(lead.customer && { customer: normalizeCustomer(lead.customer) }), ...(orders.length && { orders }) }, next: nextActionHint(lead, acts), due: isDue(lead, clock.today()), history: acts };
    }],
  create_lead: ["Add a new lead, or with kind \"kontakt\" a Kontakt. Only name is required.",
    LeadInput.required({ name: true }),
    async (input, { uc }) => ({ id: await uc.addLead(input) })],
  update_lead: ["Change fields of a lead. Only the given fields change, plus what the rules derive from them. notes as text adds it as one new note, never replacing the notes there are: send only the new note. contactedAt (YYYY-MM-DD, not after today) records the day someone first spoke with them outside the CRM and moves a neu lead to kontaktiert; it is cleared only by going back to neu.",
    z.object({ id, fields: LeadInput }),
    async ({ id: leadId, fields }, { uc }) => (await uc.updateLead(leadId, fields), { ok: true })],
  update_account: ["Change a lead's Kundenakte. `before` is lead.account exactly as get_lead returned it ({} if there is none); if the Kundenakte changed since, nothing is saved: read it again. Only the given parts change. contacts are the people besides the business's own (lead.person, email, phone), such as an agency or IT: a contact with the business's email or phone is refused. contacts replace the stored list: send the whole list, and each entry you keep keeps its `id` (an entry without one is new). systems, and each system, change field by field. domain, dns, website and email are each { what, by }: what it is (for the domain also whose it is and where it is registered; website includes the hosting), and `by`, the id of the contact in the same Kundenakte who runs it, or \"betrieb\" when the business runs it itself. access is where logins are kept, never a password. A write that leaves out a contact who runs a system is refused unless it also gives that system's `by`.",
    AccountInput.extend({ id, before: AccountInput.describe("lead.account as get_lead returned it") }),
    async ({ id: leadId, before, ...parts }, { uc }) => (await uc.saveAccount(leadId, parts, before), { ok: true })],
  update_order: ["Add, change or remove one Auftrag of a kunde. add: the new Auftrag's fields (kind required; rhythm einmalig if none given). order (an Auftrag's id from get_lead) with fields: only those change; \"\" clears one. order with remove: true: it goes. Dates are YYYY-MM-DD. Refused unless the lead is a kunde.",
    OrderChange,
    async ({ id: leadId, ...change }, { uc }) => (await uc.changeOrder(leadId, change), { ok: true })],
  change_status: [`Move a lead to another status. disqualifiziert needs a lostReason: ${LOST_REASONS.join(" | ")}. Any other status takes none. neu only from kontaktiert, or disqualifiziert with Nicht erreicht, while nobody has spoken with them; it clears contactedAt, the follow-up and the next step.`,
    z.object({ id, status: Status, lostReason: Reason.optional() }),
    async ({ id: leadId, status, lostReason }, { uc }) => {
      await uc.changeStatus(leadId, status, lostReason);
      return { ok: true };
    }],
  log_activity: ["Record a contact: direction out (we wrote or visited) or in (they answered). A message from them or a visit (channel Vor Ort) makes a neu lead kontaktiert; a message of ours to a neu lead changes nothing but the history. Updates status and follow-up date. An outgoing E-Mail is also refused if, unless the lead is a Kunde, another lead with an opt-out has the same address (also one in the Papierkorb).",
    z.object({ id, direction: z.enum(["out", "in"]), channel: z.enum(CHANNELS), text: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    async ({ id: leadId, ...input }, { uc }) => uc.logActivity(leadId, input)],
  log_call: [`Record a phone call and how it ended: made today, or one on an earlier day entered later (day: YYYY-MM-DD, not after today). nicht-erreicht: no answer, call again in 2 days, unless a follow-up date ahead was not set by the sequence (status other than kontaktiert, or a next step); a neu lead stays neu, with no date, and the 5th day it was called without getting through closes it (Nicht erreicht); a kontaktiert lead never spoken with closes on the 5th attempt of any kind. rueckruf: they asked to be called back, date (YYYY-MM-DD, from today) required, time (HH:MM) optional. termin: an appointment, date required, time optional; the lead becomes qualifiziert. kein-interesse: reason required; the lead becomes disqualifiziert. A kunde stays kunde whatever the outcome; the reason "${OPT_OUT_REASON}" still records an opt-out. Optional note.`,
    CallInput.extend({ id }),
    async ({ id: leadId, ...call }, { uc }) => uc.logCall(leadId, call)],
  meeting_outcome: ["Record how an appointment went, on a qualifiziert lead. kunde: they became a customer. kein-abschluss: no deal, reason required; the lead becomes disqualifiziert. neuer-termin: a new appointment, date (YYYY-MM-DD, from today) required, time (HH:MM) optional.",
    MeetingInput,
    async ({ id: leadId, ...meeting }, { uc }) => (await uc.meetingOutcome(leadId, meeting), { ok: true })],
  set_follow_up: ["Set or clear the follow-up date (YYYY-MM-DD or null) and optionally the next step. A neu or disqualifiziert lead takes no date.",
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
  create_gmail_draft: ["Create a Gmail draft to the lead's email address in the signed-in user's mailbox. Nothing is sent or logged; a person reviews and sends it. The draft ends with the user's Gmail signature when Gmail has one, so do not sign the text, and with the lead's unsubscribe link, unless the lead is a Kunde. Refused if the lead has an opt-out, or, unless the lead is a Kunde, any lead with the same address (also one in the Papierkorb).",
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
