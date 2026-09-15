/**
 * OpenStreetMap Overpass API client with multi-mirror failover and backoff.
 * Queries restaurants in target DACH cities with website tags.
 */

export const OVERPASS_MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];

export const DACH_CITY_COORDINATES = {
  berlin: { lat: 52.5200, lon: 13.4050, radius: 10000 },
  münchen: { lat: 48.1371, lon: 11.5761, radius: 10000 },
  munich: { lat: 48.1371, lon: 11.5761, radius: 10000 },
  wien: { lat: 48.2082, lon: 16.3738, radius: 10000 },
  vienna: { lat: 48.2082, lon: 16.3738, radius: 10000 },
  zürich: { lat: 47.3769, lon: 8.5417, radius: 8000 },
  zurich: { lat: 47.3769, lon: 8.5417, radius: 8000 },
  hamburg: { lat: 53.5511, lon: 9.9937, radius: 10000 },
  frankfurt: { lat: 50.1109, lon: 8.6821, radius: 8000 },
  köln: { lat: 50.9375, lon: 6.9603, radius: 8000 },
  cologne: { lat: 50.9375, lon: 6.9603, radius: 8000 },
  stuttgart: { lat: 48.7758, lon: 9.1829, radius: 8000 },
  düsseldorf: { lat: 51.2277, lon: 6.7735, radius: 8000 },
  dusseldorf: { lat: 51.2277, lon: 6.7735, radius: 8000 },
  leipzig: { lat: 51.3397, lon: 12.3731, radius: 8000 },
  salzburg: { lat: 47.8095, lon: 13.0550, radius: 6000 },
  graz: { lat: 47.0707, lon: 15.4395, radius: 6000 },
  innsbruck: { lat: 47.2692, lon: 11.4041, radius: 6000 },
  basel: { lat: 47.5596, lon: 7.5886, radius: 6000 },
  bern: { lat: 46.9480, lon: 7.4474, radius: 6000 },
  geneva: { lat: 46.2044, lon: 6.1432, radius: 6000 },
  genf: { lat: 46.2044, lon: 6.1432, radius: 6000 }
};

/**
 * Builds an Overpass QL query string for a given city or coordinate specification.
 *
 * @param {string} cityOrTarget - City name (e.g. "Berlin", "München") or bbox/coords
 * @param {object} [options={}] - Query options (timeout, radius)
 * @returns {string} Overpass QL query
 */
export function buildOverpassQuery(cityOrTarget, options = {}) {
  const timeout = options.timeout || 25;
  const normalized = String(cityOrTarget).trim().toLowerCase();

  // 1. Check if matching predefined DACH city coordinates
  const predefined = DACH_CITY_COORDINATES[normalized];
  if (predefined) {
    const radius = options.radius || predefined.radius;
    return `[out:json][timeout:${timeout}];
(
  node["amenity"="restaurant"]["website"](around:${radius},${predefined.lat},${predefined.lon});
  way["amenity"="restaurant"]["website"](around:${radius},${predefined.lat},${predefined.lon});
  node["amenity"="restaurant"]["contact:website"](around:${radius},${predefined.lat},${predefined.lon});
  way["amenity"="restaurant"]["contact:website"](around:${radius},${predefined.lat},${predefined.lon});
);
out center tags;`;
  }

  // 2. Check if comma-separated coordinates: lat,lon[,radius]
  const coordParts = cityOrTarget.split(",").map((p) => p.trim());
  if (coordParts.length >= 2 && !isNaN(Number(coordParts[0])) && !isNaN(Number(coordParts[1]))) {
    const lat = Number(coordParts[0]);
    const lon = Number(coordParts[1]);
    const radius = coordParts.length >= 3 && !isNaN(Number(coordParts[2])) ? Number(coordParts[2]) : 8000;
    return `[out:json][timeout:${timeout}];
(
  node["amenity"="restaurant"]["website"](around:${radius},${lat},${lon});
  way["amenity"="restaurant"]["website"](around:${radius},${lat},${lon});
  node["amenity"="restaurant"]["contact:website"](around:${radius},${lat},${lon});
  way["amenity"="restaurant"]["contact:website"](around:${radius},${lat},${lon});
);
out center tags;`;
  }

  // 3. Fallback to administrative area query
  // Escapes special characters for regex safety
  const safeCity = cityOrTarget.replace(/["\\]/g, "");
  return `[out:json][timeout:${timeout}];
area["name"~"^(${safeCity})$",i]["admin_level"~"^(4|6|8)$"]->.searchArea;
(
  node["amenity"="restaurant"]["website"](area.searchArea);
  way["amenity"="restaurant"]["website"](area.searchArea);
  node["amenity"="restaurant"]["contact:website"](area.searchArea);
  way["amenity"="restaurant"]["contact:website"](area.searchArea);
);
out center tags;`;
}

/**
 * Normalizes restaurant website URL ensuring protocol is present.
 *
 * @param {string} raw - Raw website URL from OSM
 * @returns {string} Normalized URL
 */
export function normalizeWebsiteUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  let url = raw.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  return url;
}

/**
 * Parses raw Overpass JSON response into normalized restaurant objects.
 *
 * @param {object} data - Overpass JSON response
 * @param {string} fallbackCity - City name to use if addr:city is not set
 * @returns {Array<{ osmId: string, name: string, city: string, website: string, phone: string }>}
 */
export function parseOverpassElements(data, fallbackCity = "") {
  if (!data || !Array.isArray(data.elements)) {
    return [];
  }

  const results = [];
  const seenWebsites = new Set();

  for (const el of data.elements) {
    const tags = el.tags || {};
    const rawWebsite = tags.website || tags["contact:website"];
    if (!rawWebsite) continue;

    const website = normalizeWebsiteUrl(rawWebsite);
    if (!website || seenWebsites.has(website.toLowerCase())) {
      continue;
    }
    seenWebsites.add(website.toLowerCase());

    const name = tags.name || tags["name:de"] || tags["name:en"] || "Unknown";
    const phone = tags.phone || tags["contact:phone"] || "";
    const city = tags["addr:city"] || fallbackCity || "";

    results.push({
      osmId: `${el.type || "node"}/${el.id}`,
      name: name.trim(),
      city: city.trim(),
      website: website,
      phone: phone.trim()
    });
  }

  return results;
}

/**
 * Sleep helper for backoff delays.
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches restaurant records from Overpass API using multiple mirrors with exponential backoff.
 *
 * @param {string} city - Target city name or coordinates
 * @param {object} [options={}] - Options (mirrors, maxRetries, timeout)
 * @returns {Promise<Array<{ osmId: string, name: string, city: string, website: string, phone: string }>>}
 */
export async function fetchRestaurantsFromOverpass(city, options = {}) {
  const mirrors = options.mirrors || OVERPASS_MIRRORS;
  const maxRetriesPerMirror = options.maxRetries || 2;
  const timeoutMs = options.timeoutMs || 30000;
  const backoffBaseMs = options.backoffBaseMs !== undefined ? options.backoffBaseMs : 1000;
  const query = buildOverpassQuery(city, options);

  const errors = [];

  for (const mirror of mirrors) {
    for (let attempt = 0; attempt <= maxRetriesPerMirror; attempt++) {
      if (attempt > 0 && backoffBaseMs > 0) {
        const delay = Math.min(backoffBaseMs * Math.pow(2, attempt) + Math.random() * 200, 8000);
        await sleep(delay);
      }

      try {
        const response = await fetch(mirror, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json, */*",
            "User-Agent": "BooketeLeadScraper/1.0 (leads@bookete.com)"
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(timeoutMs)
        });

        if (response.status === 429 || response.status === 504 || response.status === 502) {
          // Rate limited or overloaded, retry with backoff
          continue;
        }

        if (!response.ok) {
          errors.push(`${mirror} returned HTTP ${response.status}`);
          break; // Break inner loop to try next mirror
        }

        const text = await response.text();
        // Check for embedded runtime errors
        if (text.includes("<error>") || text.includes("runtime error") || text.includes("rate_limited")) {
          errors.push(`${mirror} returned runtime error`);
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (jsonErr) {
          errors.push(`${mirror} returned invalid JSON: ${jsonErr.message}`);
          continue;
        }

        const restaurants = parseOverpassElements(parsed, city);
        if (restaurants.length > 0 || Array.isArray(parsed.elements)) {
          return restaurants;
        }
      } catch (err) {
        errors.push(`${mirror} attempt ${attempt + 1}: ${err.message}`);
      }
    }
  }

  throw new Error(`All Overpass API mirrors failed for ${city}. Errors: ${errors.join("; ")}`);
}
