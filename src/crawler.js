/**
 * Resilient 2-stage web crawler for restaurant websites.
 *
 * Stage 1: Fetches restaurant homepage and runs signature detector.
 * Stage 2: If no widget detected, discovers internal reservation subpages
 *          (e.g. /reservierung, /booking, /tisch) and scans them.
 */

import { detectWidget } from "./detector.js";

// Bypass SSL certificate validation for crawling heterogeneous restaurant websites
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const DEFAULT_HEADERS = {
  "User-Agent": DEFAULT_USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"
};

export const RESERVATION_LINK_REGEX =
  /(?:reservier|booking|tisch|reserve|buchen|table|reservation)/i;

export const IGNORED_EXTENSIONS_REGEX =
  /\.(?:pdf|png|jpe?g|gif|webp|svg|css|js|ico|zip|tar|gz|mp4|mov|avi|xml|json)$/i;

/**
 * Discovers potential reservation subpage URLs from page HTML.
 *
 * @param {string} html - HTML string of the page
 * @param {string} baseUrl - Base URL of the site to resolve relative paths
 * @returns {string[]} Array of candidate subpage URLs (maximum 3 candidates)
 */
export function findReservationSubpages(html, baseUrl) {
  if (!html || typeof html !== "string") return [];

  let baseOrigin;
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const candidates = [];
  const seenUrls = new Set();
  const linkRegex = /<\s*a\b[^>]*\bhref\s*=\s*(?:["']([^"']*)["']|([^\s>]+))[^>]*>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const rawHref = (match[1] !== undefined ? match[1] : match[2])?.trim();
    if (!rawHref) continue;

    // Skip anchor-only, mailto, tel, javascript links
    if (
      rawHref.startsWith("#") ||
      rawHref.startsWith("mailto:") ||
      rawHref.startsWith("tel:") ||
      rawHref.startsWith("javascript:")
    ) {
      continue;
    }

    // Skip binary and media assets
    if (IGNORED_EXTENSIONS_REGEX.test(rawHref)) {
      continue;
    }

    try {
      const resolved = new URL(rawHref, baseUrl);

      // Must be same origin (internal subpage) and http/https
      if (resolved.origin !== baseOrigin) continue;
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

      const pathAndQuery = `${resolved.pathname}${resolved.search}`;
      if (RESERVATION_LINK_REGEX.test(pathAndQuery)) {
        const fullUrl = resolved.href;
        if (!seenUrls.has(fullUrl) && fullUrl !== baseUrl) {
          seenUrls.add(fullUrl);
          candidates.push(fullUrl);
          if (candidates.length >= 3) break;
        }
      }
    } catch {
      // Invalid URL skipped
    }
  }

  return candidates;
}

/**
 * Safely fetches an HTML page with timeout and headers.
 *
 * @param {string} url - Target URL to fetch
 * @param {number} [timeoutMs=10000] - Request timeout in milliseconds
 * @returns {Promise<{ ok: boolean, status: number, html: string, finalUrl: string }>}
 */
export async function safeFetchHtml(url, timeoutMs = 10000) {
  let targetUrl = url;
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = `https://${targetUrl}`;
  }

  try {
    const response = await fetch(targetUrl, {
      headers: DEFAULT_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      return { ok: false, status: response.status, html: "", finalUrl: targetUrl };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("xhtml")) {
      return { ok: false, status: response.status, html: "", finalUrl: targetUrl };
    }

    const html = await response.text();
    return { ok: true, status: response.status, html, finalUrl: response.url || targetUrl };
  } catch (err) {
    return { ok: false, status: 0, html: "", finalUrl: targetUrl, error: err.message };
  }
}

/**
 * Executes a 2-stage crawl on a restaurant website.
 *
 * Stage 1: Scans the homepage.
 * Stage 2: Scans candidate reservation subpages if homepage yields no match.
 *
 * @param {string} websiteUrl - Restaurant website URL
 * @param {object} [options={}] - Options (timeoutMs)
 * @returns {Promise<{
 *   status: "matched" | "no_widget" | "unreachable",
 *   detected_competitor: string,
 *   competitor_widget_url: string,
 *   scanned_url: string
 * }>}
 */
export async function crawlRestaurant(websiteUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;

  // Stage 1: Homepage scan
  const homeResult = await safeFetchHtml(websiteUrl, timeoutMs);
  if (!homeResult.ok || !homeResult.html) {
    // If https failed, attempt http fallback once if original was bare domain
    if (websiteUrl.startsWith("https://") || !websiteUrl.startsWith("http")) {
      const httpUrl = websiteUrl.replace(/^https:\/\//, "http://");
      const httpResult = await safeFetchHtml(httpUrl.startsWith("http") ? httpUrl : `http://${httpUrl}`, timeoutMs);
      if (httpResult.ok && httpResult.html) {
        const detection = detectWidget(httpResult.html, httpResult.finalUrl);
        if (detection.detected !== "None") {
          return {
            status: "matched",
            detected_competitor: detection.detected,
            competitor_widget_url: detection.widgetUrl,
            scanned_url: httpResult.finalUrl
          };
        }
      }
    }

    return {
      status: "unreachable",
      detected_competitor: "None",
      competitor_widget_url: "",
      scanned_url: websiteUrl
    };
  }

  const detection = detectWidget(homeResult.html, homeResult.finalUrl);
  if (detection.detected !== "None") {
    return {
      status: "matched",
      detected_competitor: detection.detected,
      competitor_widget_url: detection.widgetUrl,
      scanned_url: homeResult.finalUrl
    };
  }

  // Stage 2: Subpage discovery
  const subpages = findReservationSubpages(homeResult.html, homeResult.finalUrl);

  for (const subUrl of subpages) {
    const subResult = await safeFetchHtml(subUrl, Math.min(timeoutMs, 8000));
    if (subResult.ok && subResult.html) {
      const subDetection = detectWidget(subResult.html, subResult.finalUrl);
      if (subDetection.detected !== "None") {
        return {
          status: "matched",
          detected_competitor: subDetection.detected,
          competitor_widget_url: subDetection.widgetUrl,
          scanned_url: subResult.finalUrl
        };
      }
    }
  }

  return {
    status: "no_widget",
    detected_competitor: "None",
    competitor_widget_url: "",
    scanned_url: homeResult.finalUrl
  };
}
