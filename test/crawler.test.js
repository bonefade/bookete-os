import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  findReservationSubpages,
  safeFetchHtml,
  crawlRestaurant
} from "../src/crawler.js";

describe("Web Crawler and Subpage Discovery", () => {
  describe("findReservationSubpages", () => {
    const baseUrl = "https://www.gasthaus-schmidt.de/";

    it("discovers relative reservation subpages", () => {
      const html = `
        <nav>
          <a href="/">Home</a>
          <a href="/speisekarte">Speisekarte</a>
          <a href="/reservierung">Tisch Reservieren</a>
          <a href="/kontakt">Kontakt</a>
        </nav>
      `;
      const subpages = findReservationSubpages(html, baseUrl);
      assert.deepEqual(subpages, ["https://www.gasthaus-schmidt.de/reservierung"]);
    });

    it("discovers alternative German and English reservation keywords", () => {
      const html = `
        <div>
          <a href="/tischreservierung">Online Tisch</a>
          <a href="/online-booking">Booking</a>
        </div>
      `;
      const subpages = findReservationSubpages(html, baseUrl);
      assert.equal(subpages.length, 2);
      assert.ok(subpages.includes("https://www.gasthaus-schmidt.de/tischreservierung"));
      assert.ok(subpages.includes("https://www.gasthaus-schmidt.de/online-booking"));
    });

    it("ignores anchor jumps, javascript links, and binary files", () => {
      const html = `
        <div>
          <a href="#reservieren">Jump to Section</a>
          <a href="javascript:openBooking()">Script</a>
          <a href="/reservierung-formular.pdf">Download PDF</a>
          <a href="/tisch.jpg">Photo</a>
        </div>
      `;
      const subpages = findReservationSubpages(html, baseUrl);
      assert.deepEqual(subpages, []);
    });

    it("ignores external origins", () => {
      const html = `
        <div>
          <a href="https://external-service.com/reservierung">External</a>
        </div>
      `;
      const subpages = findReservationSubpages(html, baseUrl);
      assert.deepEqual(subpages, []);
    });

    it("limits subpages to maximum 3 candidates", () => {
      const html = `
        <div>
          <a href="/reservierung">1</a>
          <a href="/booking">2</a>
          <a href="/tisch">3</a>
          <a href="/reserve">4</a>
          <a href="/buchen">5</a>
        </div>
      `;
      const subpages = findReservationSubpages(html, baseUrl);
      assert.equal(subpages.length, 3);
    });
  });

  describe("Real HTTP Server Integration", () => {
    let server;
    let serverPort;
    let serverOrigin;

    before(async () => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${serverPort}`);

        if (url.pathname === "/site1") {
          // Homepage with direct Quandoo widget
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h1>Site 1</h1>
                <script src="https://booking-widget.quandoo.com/index.js"></script>
              </body>
            </html>
          `);
        } else if (url.pathname === "/site2") {
          // Homepage with no widget, links to reservation subpage
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h1>Site 2</h1>
                <a href="/site2/reservierung">Hier reservieren</a>
              </body>
            </html>
          `);
        } else if (url.pathname === "/site2/reservierung") {
          // Subpage containing OpenTable widget
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h2>Reservierung</h2>
                <script src="https://www.opentable.de/widget/reservation/loader?rid=999"></script>
              </body>
            </html>
          `);
        } else if (url.pathname === "/site3") {
          // Site with no widgets anywhere
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h1>Site 3</h1>
                <a href="/site3/reservierung">Anrufen: 089 12345</a>
              </body>
            </html>
          `);
        } else if (url.pathname === "/site3/reservierung") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><p>Nur telefonisch reservieren.</p></body></html>`);
        } else if (url.pathname === "/pdf-only") {
          res.writeHead(200, { "Content-Type": "application/pdf" });
          res.end("%PDF-1.4 ...");
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
      });

      await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          serverPort = server.address().port;
          serverOrigin = `http://127.0.0.1:${serverPort}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("detects competitor directly on homepage (Stage 1)", async () => {
      const result = await crawlRestaurant(`${serverOrigin}/site1`);
      assert.equal(result.status, "matched");
      assert.equal(result.detected_competitor, "Quandoo");
      assert.equal(result.competitor_widget_url, "https://booking-widget.quandoo.com/index.js");
    });

    it("detects competitor on discovered subpage (Stage 2)", async () => {
      const result = await crawlRestaurant(`${serverOrigin}/site2`);
      assert.equal(result.status, "matched");
      assert.equal(result.detected_competitor, "OpenTable");
      assert.match(result.competitor_widget_url, /opentable\.de\/widget\/reservation\/loader/);
    });

    it("reports no_widget when no competitors are found on homepage or subpage", async () => {
      const result = await crawlRestaurant(`${serverOrigin}/site3`);
      assert.equal(result.status, "no_widget");
      assert.equal(result.detected_competitor, "None");
      assert.equal(result.competitor_widget_url, "");
    });

    it("reports unreachable on 404 or connection failures", async () => {
      const result = await crawlRestaurant(`${serverOrigin}/nonexistent-page`);
      assert.equal(result.status, "unreachable");
    });

    it("rejects non-HTML responses", async () => {
      const res = await safeFetchHtml(`${serverOrigin}/pdf-only`);
      assert.equal(res.ok, false);
    });
  });
});
