/**
 * RFC 4180 compliant CSV export generator.
 * Produces exactly the 9 required columns:
 * name,city,website,phone,detected_competitor,competitor_widget_url,status,timestamp,osm_id
 */

import fs from "node:fs";
import path from "node:path";

export const CSV_COLUMNS = [
  "name",
  "city",
  "website",
  "phone",
  "detected_competitor",
  "competitor_widget_url",
  "status",
  "timestamp",
  "osm_id"
];

/**
 * Escapes a single CSV field value according to RFC 4180.
 *
 * @param {any} val - Field value
 * @returns {string} Escaped string
 */
export function escapeCsvField(val) {
  if (val === null || val === undefined) {
    return "";
  }
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formats an array of lead objects into an RFC 4180 CSV string.
 *
 * @param {Array<object>} leads - Array of lead records
 * @returns {string} CSV formatted string
 */
export function formatLeadsCsv(leads) {
  const lines = [CSV_COLUMNS.join(",")];

  for (const lead of leads) {
    const row = [
      escapeCsvField(lead.name || ""),
      escapeCsvField(lead.city || ""),
      escapeCsvField(lead.website || ""),
      escapeCsvField(lead.phone || ""),
      escapeCsvField(lead.detected_competitor || "None"),
      escapeCsvField(lead.competitor_widget_url || ""),
      escapeCsvField(lead.status || "no_widget"),
      escapeCsvField(lead.timestamp || new Date().toISOString()),
      escapeCsvField(lead.osm_id || "")
    ];
    lines.push(row.join(","));
  }

  return lines.join("\n") + "\n";
}

/**
 * Writes lead records to a CSV file at outputPath.
 *
 * @param {Array<object>} leads - Array of lead records
 * @param {string} outputPath - Destination file path
 * @returns {string} Absolute path of the written file
 */
export function writeLeadsToCsv(leads, outputPath) {
  const resolvedPath = path.resolve(outputPath);
  const dir = path.dirname(resolvedPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const csvContent = formatLeadsCsv(leads);
  fs.writeFileSync(resolvedPath, csvContent, "utf8");

  return resolvedPath;
}
