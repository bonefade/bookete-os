export const SCHEMA_VERSION = 2;
export const STAGES = [
  ["recherchiert", "Recherchiert"],
  ["kontaktiert", "Kontaktiert"],
  ["antwort", "Antwort"],
  ["demo", "Gespr\xE4ch/Demo"],
  ["onboarding", "Onboarding"],
  ["kunde", "Kunde"],
  ["kein-interesse", "Kein Interesse"]
];
export const STAGE_LABEL = Object.fromEntries(STAGES);
export const STATUSES = new Set(STAGES.map(([k]) => k));
export const OPEN_STATUSES = new Set(["recherchiert", "kontaktiert", "antwort", "demo", "onboarding"]);
export const OPT_OUT_REASON = "Keine Kontaktaufnahme gew\xFCnscht";
export const LOST_REASONS = ["Hat schon ein Tool", OPT_OUT_REASON, "Telefon reicht ihnen", "Keine Antwort", "Zu wenig Reservierungen", "Sp\xE4ter nochmal", "Sonstiges"];
export const BUSINESS_TYPES = ["Gasthaus", "Restaurant", "Caf\xE9", "Bar", "Heuriger / Buschenschank", "Hotel-Restaurant", "Sonstiges"];
export const RESERVATION_TOOLS = ["unbekannt", "nur Telefon", "Telefon + E-Mail", "Quandoo", "OpenTable", "TheFork", "resmio", "Teburio", "Molzait", "aleno", "Zenchef", "DISH", "anderes Tool", "keine Reservierungen"];
export const CHANNELS = ["Instagram", "E-Mail", "WhatsApp", "Telefon", "Vor Ort", "LinkedIn"];
export const DIRECTIONS = new Set(["out", "in"]);
export const TEMPLATE_PURPOSES = [
  ["erstkontakt", "Erstkontakt"],
  ["followup1", "Follow-up 1"],
  ["followup2", "Follow-up 2 (letztes)"],
  ["antwort", "Auf Antwort"],
  ["sonstiges", "Sonstiges"]
];
export const PURPOSE_LABEL = Object.fromEntries(TEMPLATE_PURPOSES);
export const PLACEHOLDERS = ["Betrieb", "Ort", "Aufh\xE4nger", "Person"];
export const SEQUENCE_POLICY = { cadence: [3, 7], maxTouches: 3, defaultFollowUpDays: 4 };
export const COLLECTIONS = ["leads", "activities", "templates", "settings"];
/** How many deleted leads the Papierkorb lists, newest first. */
export const TRASH_SHOWN = 50;
