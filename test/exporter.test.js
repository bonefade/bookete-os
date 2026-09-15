import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  escapeCsvField,
  formatLeadsCsv,
  writeLeadsToCsv,
  CSV_COLUMNS
} from "../src/exporter.js";

describe("RFC 4180 CSV Exporter", () => {
  describe("escapeCsvField", () => {
    it("leaves simple values unquoted", () => {
      assert.equal(escapeCsvField("Brauhaus"), "Brauhaus");
      assert.equal(escapeCsvField("Berlin"), "Berlin");
      assert.equal(escapeCsvField(123), "123");
    });

    it("encloses values containing commas in double quotes", () => {
      assert.equal(escapeCsvField("Schmidt, Peter & Co."), '"Schmidt, Peter & Co."');
    });

    it("doubles existing double quotes and encloses in double quotes", () => {
      assert.equal(escapeCsvField('Restaurant "Zur Linde"'), '"Restaurant ""Zur Linde"""');
    });

    it("encloses values containing newlines in double quotes", () => {
      assert.equal(escapeCsvField("Line 1\nLine 2"), '"Line 1\nLine 2"');
      assert.equal(escapeCsvField("Line 1\r\nLine 2"), '"Line 1\r\nLine 2"');
    });

    it("handles null and undefined as empty strings", () => {
      assert.equal(escapeCsvField(null), "");
      assert.equal(escapeCsvField(undefined), "");
    });
  });

  describe("formatLeadsCsv", () => {
    it("produces exact 9-column RFC 4180 header", () => {
      const expectedHeader = "name,city,website,phone,detected_competitor,competitor_widget_url,status,timestamp,osm_id";
      assert.equal(CSV_COLUMNS.join(","), expectedHeader);

      const csv = formatLeadsCsv([]);
      assert.equal(csv.trim(), expectedHeader);
    });

    it("correctly formats lead rows with escaping", () => {
      const sampleLeads = [
        {
          name: 'Gasthof "Zum Bären", Alt-Berlin',
          city: "Berlin",
          website: "https://zum-baeren.de",
          phone: "+49 30 123456",
          detected_competitor: "Quandoo",
          competitor_widget_url: "https://booking-widget.quandoo.com/index.js",
          status: "matched",
          timestamp: "2026-09-15T21:00:00.000Z",
          osm_id: "node/12345678"
        },
        {
          name: "Cafe Wien",
          city: "Wien",
          website: "https://cafe-wien.at",
          phone: "",
          detected_competitor: "None",
          competitor_widget_url: "",
          status: "no_widget",
          timestamp: "2026-09-15T21:00:00.000Z",
          osm_id: "way/87654321"
        }
      ];

      const csv = formatLeadsCsv(sampleLeads);
      const lines = csv.trim().split("\n");

      assert.equal(lines.length, 3);
      assert.equal(lines[0], "name,city,website,phone,detected_competitor,competitor_widget_url,status,timestamp,osm_id");

      // Row 1 checks
      assert.ok(lines[1].startsWith('"Gasthof ""Zum Bären"", Alt-Berlin",Berlin,https://zum-baeren.de'));
      assert.ok(lines[1].includes("Quandoo"));
      assert.ok(lines[1].endsWith("node/12345678"));

      // Row 2 checks
      assert.equal(
        lines[2],
        "Cafe Wien,Wien,https://cafe-wien.at,,None,,no_widget,2026-09-15T21:00:00.000Z,way/87654321"
      );
    });
  });

  describe("writeLeadsToCsv", () => {
    it("writes CSV file to disk and ensures parent directory exists", () => {
      const tempDir = path.join(os.tmpdir(), `scraper-test-${Date.now()}`);
      const targetFile = path.join(tempDir, "subfolder", "test_leads.csv");

      try {
        const lead = {
          name: "Test Ristorante",
          city: "München",
          website: "https://test-ristorante.de",
          phone: "+49 89 998877",
          detected_competitor: "OpenTable",
          competitor_widget_url: "https://widgets.opentable.de/loader.js",
          status: "matched",
          timestamp: "2026-09-15T21:00:00.000Z",
          osm_id: "node/998877"
        };

        const writtenPath = writeLeadsToCsv([lead], targetFile);
        assert.equal(writtenPath, targetFile);
        assert.ok(fs.existsSync(targetFile));

        const content = fs.readFileSync(targetFile, "utf8");
        assert.match(content, /^name,city,website,phone/);
        assert.match(content, /Test Ristorante,München/);
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });
  });
});
