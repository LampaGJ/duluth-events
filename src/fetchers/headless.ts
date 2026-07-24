import { logger } from "../logger.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export type JsonLdEvent = Record<string, unknown>;

/**
 * Render a JS/Cloudflare-gated events page in headless Chromium (which clears the managed
 * challenge that a plain fetch cannot), extract schema.org `Event` JSON-LD from the DOM, and follow
 * the calendar's "next page" link up to `maxPages`. Playwright is lazy-imported so an ordinary
 * pipeline run (no headless sources) never loads a browser.
 *
 * Used for Perfect Duluth Day, whose ?ical=1 and wp-json REST endpoints are separately WAF-blocked
 * even from a cleared browser, but whose rendered list page embeds full Event JSON-LD.
 */
export async function fetchJsonLdEvents(startUrl: string, maxPages = 3, tzDate?: string): Promise<JsonLdEvent[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const collected: JsonLdEvent[] = [];
  try {
    const ctx = await browser.newContext({ userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 }, locale: "en-US" });
    const page = await ctx.newPage();
    let url: string | null = tzDate ? `${startUrl}?tribe-bar-date=${tzDate}` : startUrl;

    for (let i = 0; i < maxPages && url; i++) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForFunction(() => !/just a moment/i.test(document.title), { timeout: 40000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});

      const { events, next } = await page.evaluate(() => {
        const ev: Record<string, unknown>[] = [];
        for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          try {
            const parsed: unknown = JSON.parse(s.textContent || "null");
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const o of arr) {
              if (o && typeof o === "object" && (o as Record<string, unknown>)["@type"] === "Event") {
                ev.push(o as Record<string, unknown>);
              }
            }
          } catch {
            /* skip malformed JSON-LD block */
          }
        }
        const n = document.querySelector('a.tribe-events-c-nav__next, a[rel="next"]');
        return { events: ev, next: n instanceof HTMLAnchorElement ? n.href : null };
      });

      collected.push(...events);
      url = next;
    }
  } finally {
    await browser.close();
  }
  logger.info({ startUrl, events: collected.length }, "headless JSON-LD extraction complete");
  return collected;
}
