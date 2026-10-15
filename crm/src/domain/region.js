export const REGIONS = ["Vorarlberg", "Tirol", "Salzburg", "Ober\xF6sterreich", "K\xE4rnten", "Steiermark", "Nieder\xF6sterreich", "Wien", "Burgenland"];
export const OTHER_REGION = "Sonstige";
export const CITY_REGION = {
  Vorarlberg: ["bregenz", "lochau", "lauterach", "b\xFCrserberg", "buerserberg", "dornbirn", "feldkirch", "bludenz", "hard", "hohenems", "g\xF6tzis", "lustenau", "rankweil", "wolfurt", "kennelbach", "h\xF6chst", "fu\xDFach", "lech", "schruns", "bezau", "egg", "h\xF6rbranz"],
  Tirol: ["innsbruck", "kufstein", "kitzb\xFChel", "w\xF6rgl", "schwaz", "hall in tirol", "lienz", "imst", "landeck", "seefeld", "mayrhofen", "telfs", "st. anton", "s\xF6lden", "ischgl", "reutte", "zell am ziller", "s\xF6ll", "ellmau", "alpbach"],
  Salzburg: ["salzburg", "gr\xF6dig", "anif", "gro\xDFgmain", "wals", "fuschl", "hallein", "zell am see", "saalfelden", "bischofshofen", "st. johann im pongau", "bad gastein", "seekirchen", "eugendorf", "elixhausen"],
  Steiermark: ["graz", "seiersberg", "feldkirchen bei graz", "kitzeck", "leibnitz", "seggauberg", "gleisdorf", "weiz", "leoben", "bruck an der mur", "kapfenberg", "schladming", "gratkorn", "hart bei graz"],
  Wien: ["wien", "vienna"],
  Ober\u00F6sterreich: ["linz", "wels", "steyr", "gmunden", "bad ischl", "leonding", "traun"],
  Nieder\u00F6sterreich: ["st. p\xF6lten", "sankt p\xF6lten", "wiener neustadt", "baden", "krems", "m\xF6dling", "tulln"],
  K\u00E4rnten: ["klagenfurt", "villach", "wolfsberg", "spittal", "velden", "st. veit an der glan"],
  Burgenland: ["eisenstadt", "neusiedl", "oberwart", "mattersburg", "rust"]
};
export function inferRegion(city) {
  const c = String(city || "").toLowerCase();
  if (!c) return OTHER_REGION;
  for (const r of REGIONS) if (c.includes("(" + r.toLowerCase() + ")") || c === r.toLowerCase() && r !== "Salzburg" && r !== "Wien") return r;
  for (const [r, cities] of Object.entries(CITY_REGION)) if (cities.some((x) => c === x || c.startsWith(x + " ") || c.startsWith(x + "-") || c.startsWith(x + " ("))) return r;
  if (c.includes("styria")) return "Steiermark";
  return OTHER_REGION;
}
export const regionOf = (lead) => REGIONS.includes(lead.region) ? lead.region : inferRegion(lead.city);
