import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectWidget,
  extractTagAttributes,
  COMPETITORS
} from "../src/detector.js";

describe("Competitor Widget Detector", () => {
  describe("extractTagAttributes", () => {
    it("extracts double-quoted attribute values", () => {
      const html = '<script src="https://example.com/widget.js"></script>';
      const srcs = extractTagAttributes(html, "script", "src");
      assert.deepEqual(srcs, ["https://example.com/widget.js"]);
    });

    it("extracts single-quoted attribute values", () => {
      const html = "<iframe src='https://example.com/embed'></iframe>";
      const srcs = extractTagAttributes(html, "iframe", "src");
      assert.deepEqual(srcs, ["https://example.com/embed"]);
    });

    it("extracts multiple links from complex HTML", () => {
      const html = `
        <div>
          <a href="/about">About</a>
          <a href="https://quandoo.de/place/123">Reserve</a>
          <a href="/contact">Contact</a>
        </div>
      `;
      const hrefs = extractTagAttributes(html, "a", "href");
      assert.deepEqual(hrefs, ["/about", "https://quandoo.de/place/123", "/contact"]);
    });
  });

  describe("Quandoo Signatures", () => {
    it("detects Quandoo widget script", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Restaurant</title></head>
          <body>
            <script src="https://booking-widget.quandoo.com/index.js"></script>
          </body>
        </html>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.QUANDOO);
      assert.equal(result.widgetUrl, "https://booking-widget.quandoo.com/index.js");
    });

    it("detects Quandoo iframe widget", () => {
      const html = `
        <div class="reservation">
          <iframe src="https://booking-widget.quandoo.de/?merchantId=12345"></iframe>
        </div>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.QUANDOO);
      assert.match(result.widgetUrl, /quandoo\.de/);
    });

    it("detects Quandoo direct booking link", () => {
      const html = `
        <p>Buchen Sie einen Tisch: <a href="https://www.quandoo.de/place/trattoria-berlin-99">Tisch reservieren</a></p>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.QUANDOO);
      assert.equal(result.widgetUrl, "https://www.quandoo.de/place/trattoria-berlin-99");
    });

    it("detects Quandoo DOM container element", () => {
      const html = `
        <div id="quandoo-booking-widget" data-merchant-id="98765"></div>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.QUANDOO);
    });
  });

  describe("OpenTable Signatures", () => {
    it("detects OpenTable widget loader script", () => {
      const html = `
        <script type="text/javascript" src="https://www.opentable.de/widget/reservation/loader?rid=12345"></script>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.OPENTABLE);
      assert.match(result.widgetUrl, /opentable\.de\/widget\/reservation\/loader/);
    });

    it("detects OpenTable restref iframe", () => {
      const html = `
        <iframe src="https://www.opentable.de/restref/client/?restref=887766"></iframe>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.OPENTABLE);
      assert.match(result.widgetUrl, /opentable\.de\/restref\/client/);
    });

    it("detects OpenTable direct profile link", () => {
      const html = `
        <a href="https://www.opentable.de/r/cafe-am-park-berlin">Online Reservierung</a>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.OPENTABLE);
      assert.equal(result.widgetUrl, "https://www.opentable.de/r/cafe-am-park-berlin");
    });

    it("detects OpenTable custom web component", () => {
      const html = `
        <ot-widget rid="54321" theme="standard"></ot-widget>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.OPENTABLE);
    });
  });

  describe("TheFork Signatures", () => {
    it("detects TheFork / La Fourchette module script", () => {
      const html = `
        <script src="https://module.lafourchette.com/de_DE/module/123-456"></script>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.THEFORK);
      assert.match(result.widgetUrl, /module\.lafourchette\.com/);
    });

    it("detects TheFork widget iframe", () => {
      const html = `
        <iframe src="https://widget.thefork.com/de/restaurant-id-123" width="100%"></iframe>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.THEFORK);
      assert.match(result.widgetUrl, /widget\.thefork\.com/);
    });

    it("detects TheFork direct booking anchor", () => {
      const html = `
        <a href="https://www.thefork.de/restaurant/le-bistro-r54321">Tisch buchen</a>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.THEFORK);
      assert.match(result.widgetUrl, /thefork\.de\/restaurant/);
    });

    it("detects TheFork DOM container element", () => {
      const html = `
        <div id="lafourchette_module"></div>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.THEFORK);
    });
  });

  describe("Resmio Signatures", () => {
    it("detects Resmio button script", () => {
      const html = `
        <script src="https://static.resmio.com/static/de/button.js"></script>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.RESMIO);
      assert.match(result.widgetUrl, /static\.resmio\.com/);
    });

    it("detects Resmio widget iframe", () => {
      const html = `
        <iframe src="https://app.resmio.com/sample-cafe/widget"></iframe>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.RESMIO);
      assert.match(result.widgetUrl, /app\.resmio\.com/);
    });

    it("detects Resmio DOM button attribute", () => {
      const html = `
        <button data-resmio-button="sample-cafe">Reservieren</button>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, COMPETITORS.RESMIO);
    });
  });

  describe("Negative and Edge Cases", () => {
    it("returns None for clean HTML without widgets", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <h1>Willkommen im Gasthaus</h1>
            <p>Rufen Sie uns an: 030 123456</p>
          </body>
        </html>
      `;
      const result = detectWidget(html);
      assert.equal(result.detected, "None");
      assert.equal(result.widgetUrl, "");
    });

    it("handles null and empty input safely", () => {
      assert.deepEqual(detectWidget(""), { detected: "None", widgetUrl: "" });
      assert.deepEqual(detectWidget(null), { detected: "None", widgetUrl: "" });
      assert.deepEqual(detectWidget(undefined), { detected: "None", widgetUrl: "" });
    });
  });
});
