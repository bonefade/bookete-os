export const SCHEMA_VERSION = 3;
export const STAGES = [
  ["neu", "Neu"],
  ["kontaktiert", "Kontaktiert"],
  ["qualifiziert", "Qualifiziert"],
  ["kunde", "Kunde"],
  ["disqualifiziert", "Disqualifiziert"]
];
export const STAGE_LABEL = Object.fromEntries(STAGES);
/** How the app names a lead's fields: in forms, on the lead page, in list headers and filters, search and the Änderungen list. */
export const FIELD_LABEL = { name: "Name", city: "Ort", type: "Art", region: "Region", status: "Status", fit: "ICP-Fit", instagram: "Instagram", phone: "Telefon", email: "E-Mail", website: "Website", person: "Ansprechperson", currentTool: "Reserviert aktuell \xFCber", hook: "Aufh\xE4nger", notes: "Notizen", nextStep: "N\xE4chster Schritt", followUp: "Nachfassen am", lostReason: "Grund", optOutAt: "Opt-out seit", contactedAt: "Erstkontakt", account: "Kundenakte", customer: "Betreuung", todos: "Todos" };
export const STATUSES = new Set(STAGES.map(([k]) => k));
/** Still being worked towards a deal. */
export const PIPELINE_STATUSES = new Set(["neu", "kontaktiert", "qualifiziert"]);
export const OPT_OUT_REASON = "Keine Kontaktaufnahme gew\xFCnscht";
/** Why a lead is disqualifiziert; one is required. Which system they use is a fact (currentTool), not a reason. */
export const LOST_REASONS = ["Zufrieden mit aktueller L\xF6sung", "Kein Bedarf", "Zu klein", "Nicht unsere Zielgruppe", "Geschlossen / existiert nicht", "Nicht erreicht", OPT_OUT_REASON];
// After a conversation with them, "Nicht erreicht" is no reason.
export const SPOKEN_REASONS = LOST_REASONS.filter((r) => r !== "Nicht erreicht");
export const BUSINESS_TYPES = ["Gasthaus", "Restaurant", "Caf\xE9", "Bar", "Heuriger / Buschenschank", "Hotel-Restaurant", "Sonstiges"];
export const RESERVATION_TOOLS = ["unbekannt", "nur Telefon", "Telefon + E-Mail", "Quandoo", "OpenTable", "TheFork", "resmio", "Teburio", "Molzait", "aleno", "Zenchef", "DISH", "anderes Tool", "keine Reservierungen"];
export const CHANNELS = ["Instagram", "E-Mail", "WhatsApp", "Telefon", "Vor Ort", "LinkedIn"];
export const DIRECTIONS = new Set(["out", "in"]);
export const TEMPLATE_PURPOSES = [
  ["erstkontakt", "Erstkontakt"],
  ["followup1", "Follow-up 1"],
  ["followup2", "Follow-up 2 und weitere"],
  ["antwort", "Auf Antwort"],
  ["leitfaden", "Gespr\xE4chsleitfaden"],
  ["sonstiges", "Sonstiges"]
];
export const PURPOSE_LABEL = Object.fromEntries(TEMPLATE_PURPOSES);
export const PLACEHOLDERS = ["Betrieb", "Ort", "Aufh\xE4nger", "Person"];
export const SEQUENCE_POLICY = { cadence: [3, 7], maxTouches: 5, defaultFollowUpDays: 4, callRetryDays: 2 };
/** How a phone call ended. Every outcome but nicht-erreicht means we spoke to them. */
export const CALL_OUTCOMES = [["nicht-erreicht", "Nicht erreicht"], ["rueckruf", "R\xFCckruf"], ["termin", "Termin vereinbart"], ["kein-interesse", "Kein Interesse"]];
export const OUTCOME_LABEL = Object.fromEntries(CALL_OUTCOMES);
export const COLLECTIONS = ["leads", "activities", "templates", "settings"];
/** How many deleted leads the Papierkorb lists per page, newest first. */
export const TRASH_SHOWN = 50;
