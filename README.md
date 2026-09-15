# Bookete Lead Generation Scraper (DACH)

Standalone, high-precision lead generation scraper for discovering DACH restaurants and detecting competitor reservation widgets (Quandoo, OpenTable, TheFork, Resmio).

Built with 100% free open data: zero Google Places billing accounts, zero paid API keys, and zero heavy dependencies.

---

## Features

- **OpenStreetMap Overpass API Engine**:
  - Discovers restaurants tagged with `amenity=restaurant` and website links across Germany, Austria, and Switzerland.
  - Spatial radial coordinate indexes for high-speed query resolution (Berlin, München, Wien, Zürich, Hamburg, Frankfurt, Köln, etc.).
  - Multi-mirror failover (`overpass.kumi.systems`, `overpass.private.coffee`, `overpass-api.de`, `maps.mail.ru`) with automatic exponential backoff and custom User-Agent.
- **Resilient 2-Stage Web Crawler**:
  - **Stage 1 (Homepage)**: Fetches and inspects the restaurant homepage.
  - **Stage 2 (Subpage Discovery)**: Automatically discovers and scans dedicated reservation subpages (e.g. `/reservierung`, `/booking`, `/tisch`) if no widget is found on the homepage.
  - Defensive networking: 10s total timeout, SSL error bypass for expired/self-signed restaurant certificates (`rejectUnauthorized: false`), redirect following, and browser headers.
- **High-Precision Widget Signature Matcher**:
  - Detects script embeds, iframe containers, booking buttons, and direct booking links for:
    - **Quandoo**: Script loaders (`booking-widget.quandoo.com`), merchant iframes, and place URLs.
    - **OpenTable**: Reservation loader scripts, `restref` iframes, `<ot-widget>` tags, and profile URLs.
    - **TheFork**: `module.lafourchette.com`, widget iframes, and direct booking links.
    - **Resmio**: Static button scripts, app iframes, and `data-resmio-button` tags.
- **RFC 4180 Standard CSV Export**:
  - Produces standard 9-column CSV ready for import into CRM or spreadsheet software.
- **Zero-Dependency Modern Node.js**:
  - Native ESM (`"type": "module"`), native `fetch`, native `AbortSignal`, native `node:test`.

---

## Installation

Requires Node.js v20.0.0 or higher (Node 22 recommended):

```bash
cd /home/bonefade/Work/bookete-scraper
# No build step or third-party npm packages required!
```

---

## CLI Usage

### Basic Command

```bash
# Scan restaurants in a named DACH city
node src/cli.js --city Berlin --limit 20 --output leads.csv
```

### CLI Flags

| Flag | Short | Default | Description |
|---|---|---|---|
| `--city <name>` | `-c` | *(Required)* | Target DACH city name (e.g. `Berlin`, `München`, `Wien`, `Zürich`) or coordinates (`lat,lon[,radius]`) |
| `--limit <number>` | `-l` | `Infinity` | Maximum number of restaurant websites to scan |
| `--output <filepath>` | `-o` | `leads.csv` | Destination CSV file path |
| `--concurrency <number>` | | `5` | Number of concurrent HTTP crawler workers |
| `--only-matches` | | `false` | Only include rows where a competitor widget was detected |
| `--help` | `-h` | | Show CLI help text |

### Usage Examples

```bash
# Scan up to 50 restaurants in Munich and save matches to leads-munich.csv
node src/cli.js --city München --limit 50 --output leads-munich.csv

# Scan Vienna with high concurrency and export only matched leads
node src/cli.js --city Wien --limit 30 --concurrency 10 --only-matches --output vienna-matches.csv

# Scan a custom coordinate location (Frankfurt radius 5000m)
node src/cli.js --city "50.1109, 8.6821, 5000" --limit 15 --output frankfurt.csv
```

---

## CSV Output Schema

The exporter generates an RFC 4180 compliant CSV file with exactly 9 columns:

```csv
name,city,website,phone,detected_competitor,competitor_widget_url,status,timestamp,osm_id
```

### Column Definitions

1. `name`: Restaurant name from OpenStreetMap (fallback to localized name tags).
2. `city`: Target city name or normalized address city.
3. `website`: Cleaned and normalized restaurant URL (`https://...`).
4. `phone`: Contact phone number from OSM tags (empty string if omitted).
5. `detected_competitor`: Competitor detected (`Quandoo`, `OpenTable`, `TheFork`, `Resmio`, or `None`).
6. `competitor_widget_url`: The exact script URL, iframe URL, or booking link detected.
7. `status`: Scan result (`matched`, `no_widget`, or `unreachable`).
8. `timestamp`: UTC ISO 8601 timestamp of the scan.
9. `osm_id`: OpenStreetMap element type and ID (e.g. `node/12345678` or `way/98765432`).

---

## Running Tests

Unit tests are written using Node.js native test runner (`node:test` and `node:assert/strict`):

```bash
# Run all unit tests
npm test

# Or run directly with node
node --test test/*.test.js
```

The test suite covers:
- Competitor signature detector across Quandoo, OpenTable, TheFork, and Resmio.
- HTML tag attribute extraction and DOM element patterns.
- Overpass query builder for DACH cities and coordinate bboxes.
- Website URL normalization and OSM element parsing.
- Multi-mirror failover and backoff retry logic.
- 2-stage crawler subpage discovery and live HTTP server integration.
- RFC 4180 CSV escaping, column order, and disk export.
- Asynchronous worker pool concurrency and error boundaries.

---

## Git Repository & Upstream

- Git remote: `git@github.com:bonefade/bookete-os.git`
- Branch: `main`
