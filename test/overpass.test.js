import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOverpassQuery,
  normalizeWebsiteUrl,
  parseOverpassElements,
  fetchRestaurantsFromOverpass,
  DACH_CITY_COORDINATES
} from "../src/overpass.js";

describe("Overpass API Client", () => {
  describe("buildOverpassQuery", () => {
    it("generates radial coordinate query for known DACH cities", () => {
      const queryBerlin = buildOverpassQuery("Berlin");
      assert.match(queryBerlin, /around:10000,52.52,13.405/);
      assert.match(queryBerlin, /amenity"="restaurant/);
      assert.match(queryBerlin, /out center tags;/);

      const queryMunich = buildOverpassQuery("München");
      assert.match(queryMunich, /around:10000,48.1371,11.5761/);

      const queryVienna = buildOverpassQuery("Wien");
      assert.match(queryVienna, /around:10000,48.2082,16.3738/);

      const queryZurich = buildOverpassQuery("Zürich");
      assert.match(queryZurich, /around:8000,47.3769,8.5417/);
    });

    it("generates radial query for explicit lat,lon coordinates", () => {
      const query = buildOverpassQuery("50.1109, 8.6821, 5000");
      assert.match(query, /around:5000,50.1109,8.6821/);
    });

    it("generates administrative area query for unknown cities", () => {
      const query = buildOverpassQuery("Potsdam");
      assert.match(query, /area\["name"~"\^\(Potsdam\)/);
      assert.match(query, /admin_level/);
    });
  });

  describe("normalizeWebsiteUrl", () => {
    it("prepends https:// to bare domain names", () => {
      assert.equal(normalizeWebsiteUrl("example-restaurant.de"), "https://example-restaurant.de");
      assert.equal(normalizeWebsiteUrl("www.ristorante.at"), "https://www.ristorante.at");
    });

    it("preserves existing https:// and http:// protocols", () => {
      assert.equal(normalizeWebsiteUrl("https://gourmet.ch"), "https://gourmet.ch");
      assert.equal(normalizeWebsiteUrl("http://old-inn.de"), "http://old-inn.de");
    });

    it("handles empty or non-string inputs safely", () => {
      assert.equal(normalizeWebsiteUrl(""), "");
      assert.equal(normalizeWebsiteUrl(null), "");
      assert.equal(normalizeWebsiteUrl(undefined), "");
    });
  });

  describe("parseOverpassElements", () => {
    it("parses elements, falls back to localized names, and removes duplicates", () => {
      const rawData = {
        elements: [
          {
            type: "node",
            id: 101,
            tags: {
              name: "Brauhaus Mitte",
              website: "https://brauhaus-mitte.de",
              phone: "+49 30 112233",
              "addr:city": "Berlin"
            }
          },
          {
            type: "way",
            id: 202,
            tags: {
              "name:de": "Trattoria Romana",
              "contact:website": "http://trattoria-romana.de",
              "contact:phone": "+49 30 445566"
            }
          },
          {
            // Duplicate website
            type: "node",
            id: 303,
            tags: {
              name: "Duplicate Brauhaus",
              website: "https://brauhaus-mitte.de"
            }
          },
          {
            // Missing website - should be skipped
            type: "node",
            id: 404,
            tags: {
              name: "No Web Cafe"
            }
          }
        ]
      };

      const parsed = parseOverpassElements(rawData, "Berlin");
      assert.equal(parsed.length, 2);

      assert.deepEqual(parsed[0], {
        osmId: "node/101",
        name: "Brauhaus Mitte",
        city: "Berlin",
        website: "https://brauhaus-mitte.de",
        phone: "+49 30 112233"
      });

      assert.deepEqual(parsed[1], {
        osmId: "way/202",
        name: "Trattoria Romana",
        city: "Berlin", // fallback city used
        website: "http://trattoria-romana.de",
        phone: "+49 30 445566"
      });
    });

    it("handles null or empty elements safely", () => {
      assert.deepEqual(parseOverpassElements(null), []);
      assert.deepEqual(parseOverpassElements({}), []);
      assert.deepEqual(parseOverpassElements({ elements: [] }), []);
    });
  });

  describe("fetchRestaurantsFromOverpass failover logic", () => {
    it("tries next mirror when the first mirror fails", async () => {
      let callCount = 0;
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async (url) => {
        callCount++;
        if (url.includes("mirror1")) {
          return new Response("Overloaded", { status: 429 });
        }
        return new Response(
          JSON.stringify({
            elements: [
              {
                type: "node",
                id: 555,
                tags: {
                  name: "Pizzeria Napoli",
                  website: "https://napoli-berlin.de"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        const results = await fetchRestaurantsFromOverpass("Berlin", {
          mirrors: ["https://mirror1.test/api", "https://mirror2.test/api"],
          maxRetries: 0,
          backoffBaseMs: 0
        });

        assert.equal(results.length, 1);
        assert.equal(results[0].name, "Pizzeria Napoli");
        assert.ok(callCount >= 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
