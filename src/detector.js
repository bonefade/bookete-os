/**
 * Competitor reservation widget signature detector.
 * Scans HTML source for scripts, iframes, booking links, and DOM attributes
 * matching Quandoo, OpenTable, TheFork, and Resmio.
 */

export const COMPETITORS = {
  QUANDOO: "Quandoo",
  OPENTABLE: "OpenTable",
  THEFORK: "TheFork",
  RESMIO: "Resmio"
};

export const SIGNATURES = [
  {
    name: COMPETITORS.QUANDOO,
    scriptPatterns: [
      /booking-widget\.quandoo\.(?:com|de|at|ch)/i,
      /quandoo\.(?:com|de|at|ch)\/widget/i,
      /widgets\.quandoo\.(?:com|de|at|ch)/i
    ],
    iframePatterns: [
      /booking-widget\.quandoo\.(?:com|de|at|ch)/i,
      /quandoo\.(?:com|de|at|ch)\/place\/.*\/widget/i,
      /quandoo\.(?:com|de|at|ch)\/widget/i
    ],
    linkPatterns: [
      /quandoo\.(?:com|de|at|ch)\/place\//i,
      /quandoo\.(?:com|de|at|ch)\/restaurant\//i
    ],
    domPatterns: [
      /id\s*=\s*["']quandoo-booking-widget["']/i,
      /class\s*=\s*["'][^"']*\bquandoo(?:-widget|-booking-widget)?\b[^"']*["']/i,
      /data-merchant-id\s*=\s*["'][^"']+["'][^>]*quandoo/i,
      /data-agent-id\s*=\s*["'][^"']+["'][^>]*quandoo/i
    ],
    inlinePatterns: [
      /booking-widget\.quandoo\.(?:com|de|at|ch)/i,
      /quandoo-booking-widget/i
    ]
  },
  {
    name: COMPETITORS.OPENTABLE,
    scriptPatterns: [
      /widgets\.opentable\.(?:com|de|at|ch|co\.uk)/i,
      /opentable\.(?:com|de|at|ch|co\.uk)\/widget\/reservation\/loader/i,
      /opentable\.(?:com|de|at|ch|co\.uk)\/javascripts\/widgets\.js/i
    ],
    iframePatterns: [
      /opentable\.(?:com|de|at|ch|co\.uk)\/restref\/client/i,
      /opentable\.(?:com|de|at|ch|co\.uk)\/widget\/reservation/i,
      /widgets\.opentable\.(?:com|de|at|ch|co\.uk)/i
    ],
    linkPatterns: [
      /opentable\.(?:com|de|at|ch|co\.uk)\/restaurant\/profile\//i,
      /opentable\.(?:com|de|at|ch|co\.uk)\/r\//i,
      /opentable\.(?:com|de|at|ch|co\.uk)\/restref\/client/i
    ],
    domPatterns: [
      /<ot-widget\b/i,
      /id\s*=\s*["']ot-reservation-widget["']/i,
      /id\s*=\s*["']opentable-widget["']/i,
      /class\s*=\s*["'][^"']*\bot-widget\b[^"']*["']/i,
      /class\s*=\s*["'][^"']*\bopentable-container\b[^"']*["']/i
    ],
    inlinePatterns: [
      /opentable\.com\/widget\/reservation/i,
      /opentable\.de\/widget\/reservation/i
    ]
  },
  {
    name: COMPETITORS.THEFORK,
    scriptPatterns: [
      /module\.lafourchette\.com/i,
      /widget\.thefork\.(?:com|de|at|ch)/i,
      /thefork\.(?:com|de|at|ch)\/widget/i
    ],
    iframePatterns: [
      /module\.lafourchette\.com/i,
      /widget\.thefork\.(?:com|de|at|ch)/i,
      /thefork\.(?:com|de|at|ch)\/widget/i
    ],
    linkPatterns: [
      /thefork\.(?:com|de|at|ch)\/restaurant\//i,
      /lafourchette\.com\/restaurant\//i,
      /thefork\.(?:com|de|at|ch)\/de_DE\/restaurant/i
    ],
    domPatterns: [
      /id\s*=\s*["']lafourchette_module["']/i,
      /class\s*=\s*["'][^"']*\bthefork\b[^"']*["']/i,
      /class\s*=\s*["'][^"']*\bthefork-widget\b[^"']*["']/i
    ],
    inlinePatterns: [
      /module\.lafourchette\.com/i,
      /widget\.thefork\.(?:com|de|at|ch)/i
    ]
  },
  {
    name: COMPETITORS.RESMIO,
    scriptPatterns: [
      /static\.resmio\.com\/.*button\.js/i,
      /static\.resmio\.com\/.*widget\.js/i,
      /resmio\.com\/button\.js/i
    ],
    iframePatterns: [
      /app\.resmio\.com\/.*\/widget/i,
      /app\.resmio\.com/i
    ],
    linkPatterns: [
      /app\.resmio\.com\//i,
      /resmio\.com\//i
    ],
    domPatterns: [
      /data-resmio-button\b/i,
      /id\s*=\s*["']resmio-button["']/i,
      /class\s*=\s*["'][^"']*\bresmio\b[^"']*["']/i
    ],
    inlinePatterns: [
      /static\.resmio\.com/i,
      /app\.resmio\.com/i
    ]
  }
];

/**
 * Extracts attribute values from HTML tags with the given tag name and attribute name.
 * Handles both single and double quotes as well as unquoted values.
 *
 * @param {string} html - Raw HTML text
 * @param {string} tagName - Tag name (e.g. "script", "iframe", "a")
 * @param {string} attrName - Attribute name (e.g. "src", "href")
 * @returns {string[]} Array of attribute values
 */
export function extractTagAttributes(html, tagName, attrName) {
  if (!html || typeof html !== "string") return [];
  const results = [];
  // Matches <tagName ... attr="val" ...> or <tagName ... attr='val' ...>
  const regex = new RegExp(
    `<\\s*${tagName}\\b[^>]*?\\b${attrName}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`,
    "gi"
  );
  let match;
  while ((match = regex.exec(html)) !== null) {
    const val = match[1] !== undefined ? match[1] : match[2];
    if (val) {
      results.push(val.trim());
    }
  }
  return results;
}

/**
 * Scans HTML content for competitor reservation widgets.
 *
 * Priority order of detection:
 * 1. Script sources
 * 2. Iframe sources
 * 3. Anchor href links
 * 4. DOM elements and attributes
 * 5. Inline script patterns
 *
 * @param {string} html - Raw HTML of the scanned page
 * @param {string} [pageUrl=""] - Base URL of the page being scanned
 * @returns {{ detected: string, widgetUrl: string }}
 */
export function detectWidget(html, pageUrl = "") {
  if (!html || typeof html !== "string") {
    return { detected: "None", widgetUrl: "" };
  }

  const scriptSrcs = extractTagAttributes(html, "script", "src");
  const iframeSrcs = extractTagAttributes(html, "iframe", "src");
  const anchorHrefs = extractTagAttributes(html, "a", "href");

  for (const comp of SIGNATURES) {
    // 1. Script tags src
    for (const src of scriptSrcs) {
      for (const pattern of comp.scriptPatterns) {
        if (pattern.test(src)) {
          return { detected: comp.name, widgetUrl: src };
        }
      }
    }

    // 2. Iframe tags src
    for (const src of iframeSrcs) {
      for (const pattern of comp.iframePatterns) {
        if (pattern.test(src)) {
          return { detected: comp.name, widgetUrl: src };
        }
      }
    }

    // 3. Anchor tags href
    for (const href of anchorHrefs) {
      for (const pattern of comp.linkPatterns) {
        if (pattern.test(href)) {
          return { detected: comp.name, widgetUrl: href };
        }
      }
    }

    // 4. Specific DOM element and attribute patterns
    for (const pattern of comp.domPatterns) {
      const match = html.match(pattern);
      if (match) {
        return { detected: comp.name, widgetUrl: match[0] };
      }
    }

    // 5. Inline script / initialization patterns
    for (const pattern of comp.inlinePatterns) {
      const match = html.match(pattern);
      if (match) {
        return { detected: comp.name, widgetUrl: match[0] };
      }
    }
  }

  return { detected: "None", widgetUrl: "" };
}
