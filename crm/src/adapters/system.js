// Calendar day in Vienna, so "today" is the same for the browser and the Worker (which runs in UTC).
const viennaDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" });

export const systemClock = { today: () => viennaDay.format(new Date()), now: () => new Date().toISOString() };
export const uuidIds = { newId: () => crypto.randomUUID() };
