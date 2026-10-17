export const SCHEMA_VERSION = 3;
export const STAGES = [
  ["neu", "Neu"],
  ["kontaktiert", "Kontaktiert"],
  ["qualifiziert", "Qualifiziert"],
  ["kunde", "Kunde"],
  ["disqualifiziert", "Disqualifiziert"]
];
export const STAGE_LABEL = Object.fromEntries(STAGES);
export const STATUSES = new Set(STAGES.map(([k]) => k));
/** Still being worked towards a deal. */
export const PIPELINE_STATUSES = new Set(["neu", "kontaktiert", "qualifiziert"]);
export const OPT_OUT_REASON = "Keine Kontaktaufnahme gew\xFCnscht";
/** Why a lead is disqualifiziert; one is required. Which system they use is a fact (currentTool), not a reason. */
export const LOST_REASONS = ["Zufrieden mit aktueller L\xF6sung", "Kein Bedarf", "Zu klein", "Nicht unsere Zielgruppe", "Geschlossen / existiert nicht", "Nicht erreicht", OPT_OUT_REASON];
export const BUSINESS_TYPES = ["Gasthaus", "Restaurant", "Caf\xE9", "Bar", "Heuriger / Buschenschank", "Hotel-Restaurant", "Sonstiges"];
export const RESERVATION_TOOLS = ["unbekannt", "nur Telefon", "Telefon + E-Mail", "Quandoo", "OpenTable", "TheFork", "resmio", "Teburio", "Molzait", "aleno", "Zenchef", "DISH", "anderes Tool", "keine Reservierungen"];
export const CHANNELS = ["Instagram", "E-Mail", "WhatsApp", "Telefon", "Vor Ort", "LinkedIn"];
export const DIRECTIONS = new Set(["out", "in"]);
export const TEMPLATE_PURPOSES = [
  ["erstkontakt", "Erstkontakt"],
  ["followup1", "Follow-up 1"],
  ["followup2", "Follow-up 2 und weitere"],
  ["antwort", "Auf Antwort"],
  ["sonstiges", "Sonstiges"]
];
export const PURPOSE_LABEL = Object.fromEntries(TEMPLATE_PURPOSES);
export const PLACEHOLDERS = ["Betrieb", "Ort", "Aufh\xE4nger", "Person"];
export const SEQUENCE_POLICY = { cadence: [3, 7], maxTouches: 5, defaultFollowUpDays: 4 };
export const COLLECTIONS = ["leads", "activities", "templates", "settings"];
/** How many deleted leads the Papierkorb lists, newest first. */
export const TRASH_SHOWN = 50;
