// Calendar day in Vienna, so "today" is the same for the browser and the Worker (which runs in UTC).
const viennaDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" });

export const systemClock = { today: () => viennaDay.format(new Date()), now: () => new Date().toISOString() };
export const uuidIds = { newId: () => crypto.randomUUID() };
// Before a write runs again after a conflict: a random wait of up to RETRY_PAUSE_MS times the attempt,
// so writers that collided spread out instead of colliding again.
const RETRY_PAUSE_MS = 100;
export const retryPause = (attempt) => new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_PAUSE_MS * attempt));
