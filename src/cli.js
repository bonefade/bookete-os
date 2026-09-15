#!/usr/bin/env node

/**
 * CLI runner for Bookete Lead Generation Scraper.
 *
 * Usage:
 *   node src/cli.js --city <name> [--limit <number>] [--output <filepath>]
 *
 * Example:
 *   node src/cli.js --city Berlin --limit 10 --output leads.csv
 */

import { parseArgs } from "node:util";
import { fetchRestaurantsFromOverpass } from "./overpass.js";
import { crawlRestaurant } from "./crawler.js";
import { writeLeadsToCsv } from "./exporter.js";

const HELP_TEXT = `
Bookete Lead Generation Scraper (DACH Restaurants)

Usage:
  node src/cli.js --city <name> [options]

Required:
  --city, -c <name>        Target DACH city (e.g. Berlin, München, Wien, Zürich)
                           or coordinates (lat,lon[,radius])

Options:
  --limit, -l <number>     Maximum number of restaurants to scan (default: all)
  --output, -o <filepath>  Destination CSV file path (default: leads.csv)
  --concurrency <number>   Concurrent HTTP crawler workers (default: 5)
  --only-matches           Export only matched competitor leads
  --help, -h               Show this help message
`;

/**
 * Asynchronous worker pool for bounded concurrency.
 *
 * @template T, R
 * @param {Array<T>} items - Items to process
 * @param {number} concurrency - Max concurrent workers
 * @param {(item: T, index: number) => Promise<R>} workerFn - Worker function
 * @returns {Promise<Array<R>>} Results in original order
 */
export async function runPool(items, concurrency, workerFn) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      const item = items[index];
      try {
        results[index] = await workerFn(item, index);
      } catch (err) {
        results[index] = { error: err.message };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function main(args = process.argv.slice(2)) {
  const optionsConfig = {
    city: { type: "string", short: "c" },
    limit: { type: "string", short: "l" },
    output: { type: "string", short: "o" },
    out: { type: "string" },
    concurrency: { type: "string", default: "5" },
    "only-matches": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false }
  };

  let parsed;
  try {
    parsed = parseArgs({ args, options: optionsConfig, allowPositionals: false });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.log(HELP_TEXT);
    process.exit(1);
  }

  if (parsed.values.help) {
    console.log(HELP_TEXT);
    return;
  }

  const city = parsed.values.city;
  if (!city) {
    console.error("Error: --city argument is required.");
    console.log(HELP_TEXT);
    process.exit(1);
  }

  const limit = parsed.values.limit ? parseInt(parsed.values.limit, 10) : Infinity;
  const outputPath = parsed.values.output || parsed.values.out || "leads.csv";
  const concurrency = parseInt(parsed.values.concurrency || "5", 10);
  const onlyMatches = Boolean(parsed.values["only-matches"]);

  console.log("=================================================");
  console.log(" Bookete DACH Lead Generation Scraper");
  console.log("=================================================");
  console.log(`Target City:  ${city}`);
  console.log(`Scan Limit:   ${limit === Infinity ? "All" : limit}`);
  console.log(`Output File:  ${outputPath}`);
  console.log(`Concurrency:  ${concurrency}`);
  console.log(`Only Matches: ${onlyMatches}`);
  console.log("-------------------------------------------------");

  // 1. Discover restaurants via Overpass API
  console.log(`[1/3] Querying OpenStreetMap Overpass API for restaurants in ${city}...`);
  let restaurants;
  try {
    restaurants = await fetchRestaurantsFromOverpass(city);
  } catch (err) {
    console.error(`[Overpass Error] Failed to retrieve restaurants: ${err.message}`);
    process.exit(1);
  }

  console.log(`[1/3] Discovered ${restaurants.length} restaurants with website tags.`);

  if (restaurants.length === 0) {
    console.log("No restaurants found. Exiting.");
    return;
  }

  // Slice to limit
  const targetBatch = limit < restaurants.length ? restaurants.slice(0, limit) : restaurants;
  console.log(`[2/3] Scanning ${targetBatch.length} restaurant websites for competitor widgets...`);

  let scannedCount = 0;
  let matchCount = 0;

  const leads = await runPool(targetBatch, concurrency, async (restaurant, index) => {
    const startTime = Date.now();
    const crawlResult = await crawlRestaurant(restaurant.website, { timeoutMs: 10000 });
    scannedCount++;

    const isMatch = crawlResult.status === "matched";
    if (isMatch) matchCount++;

    const indicator = isMatch ? `[MATCH: ${crawlResult.detected_competitor}]` : `[${crawlResult.status}]`;
    console.log(
      `  (${scannedCount}/${targetBatch.length}) ${indicator} ${restaurant.name} (${restaurant.website}) - ${Date.now() - startTime}ms`
    );

    return {
      name: restaurant.name,
      city: restaurant.city || city,
      website: restaurant.website,
      phone: restaurant.phone,
      detected_competitor: crawlResult.detected_competitor || "None",
      competitor_widget_url: crawlResult.competitor_widget_url || "",
      status: crawlResult.status,
      timestamp: new Date().toISOString(),
      osm_id: restaurant.osmId
    };
  });

  // Filter if onlyMatches was requested
  const exportLeads = onlyMatches ? leads.filter((l) => l.status === "matched") : leads;

  // 3. Export to CSV
  console.log(`[3/3] Exporting ${exportLeads.length} leads to ${outputPath}...`);
  const finalPath = writeLeadsToCsv(exportLeads, outputPath);

  console.log("-------------------------------------------------");
  console.log(" Scan Summary:");
  console.log(`  Total Discovered: ${restaurants.length}`);
  console.log(`  Websites Scanned: ${targetBatch.length}`);
  console.log(`  Competitors Found: ${matchCount}`);
  console.log(`  Output Exported:  ${finalPath}`);
  console.log("=================================================");
}

// Execute if run directly from CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((err) => {
    console.error("Fatal Error:", err);
    process.exit(1);
  });
}
