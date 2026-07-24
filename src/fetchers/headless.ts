import { logger } from "../logger.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export type JsonLdEvent = Record<string, unknown>;

/** Pull schema.org Event JSON-LD blocks out of a raw HTML string (works for proxy or rendered HTML). */
function extractJsonLdEvents(html: string): JsonLdEvent[] {
  const out: JsonLdEvent[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(m[1]!.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const o of arr) {
        if (o && typeof o === "object" && (o as Record<string, unknown>)["@type"] === "Event") out.push(o as JsonLdEvent);
      }
    } catch {
      /* skip malformed block */
    }
  }
  return out;
}

/** Find The Events Calendar "next page" href in raw HTML (class before or after href). */
function findNextPage(html: string): string | null {
  const a =
    html.match(/<a[^>]*tribe-events-c-nav__next[^>]*href=["']([^"']+)["']/i) ??
    html.match(/<a[^>]*href=["']([^"']+)["'][^>]*tribe-events-c-nav__next/i) ??
    html.match(/<a[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i);
  return a ? a[1]!.replace(/&amp;/g, "&") : null;
}

/**
 * Fetch a page's HTML via a residential render/anti-bot PROXY when `SCRAPER_PROXY` is set.
 * `SCRAPER_PROXY` is a URL template ending in `url=` (or containing `{url}`); the target URL is
 * appended URL-encoded. This lets any provider (ScraperAPI, ZenRows, ScrapingBee, Browserless…) be
 * plugged in via one secret, and — crucially — it fetches from the provider's RESIDENTIAL IPs, which
 * clear Cloudflare where a GitHub-Actions datacenter IP cannot.
 */
async function fetchViaProxy(proxy: string, url: string): Promise<string> {
  const target = proxy.includes("{url}") ? proxy.replace("{url}", encodeURIComponent(url)) : proxy + encodeURIComponent(url);
  const r = await fetch(target, { headers: { Accept: "text/html,*/*" } });
  const body = await r.text();
  if (!r.ok) throw new Error(`scraper proxy HTTP ${r.status}`);
  return body;
}

/** Render a page in local headless Chromium (clears a JS challenge from a clean/residential IP). */
async function fetchViaHeadless(url: string): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 }, locale: "en-US" });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(() => !/just a moment/i.test(document.title), { timeout: 40000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    return await page.content();
  } finally {
    await browser.close();
  }
}

/**
 * Get schema.org Event JSON-LD from a JS/Cloudflare-gated calendar, paginating the TEC "next" link.
 * Prefers a residential render proxy (`SCRAPER_PROXY`) — the only thing that reliably clears
 * Cloudflare from CI datacenter IPs — and falls back to local headless Chromium otherwise.
 */
/** Cheapest-first: proxy if configured, else a plain fetch (works for non-gated JSON-LD like the
 *  Children's Museum), falling back to headless only when plain is challenged or yields no events. */
async function fetchPageSmart(url: string, proxy?: string): Promise<string> {
  if (proxy) return fetchViaProxy(proxy, url);
  try {
    const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html,*/*" }, redirect: "follow" });
    const html = await r.text();
    const challenged = /just a moment|cf-chl|challenge-platform|sgcaptcha|robot challenge/i.test(html);
    if (r.ok && !challenged && extractJsonLdEvents(html).length > 0) return html;
  } catch {
    /* fall through to headless */
  }
  return fetchViaHeadless(url);
}

export async function fetchJsonLdEvents(startUrl: string, maxPages = 3, tzDate?: string): Promise<JsonLdEvent[]> {
  const proxy = process.env.SCRAPER_PROXY?.trim();
  const collected: JsonLdEvent[] = [];
  let url: string | null = tzDate ? `${startUrl}?tribe-bar-date=${tzDate}` : startUrl;

  for (let i = 0; i < maxPages && url; i++) {
    let html: string;
    try {
      html = await fetchPageSmart(url, proxy);
    } catch (err) {
      logger.warn({ url, err: err instanceof Error ? err.message : String(err) }, "JSON-LD page fetch failed");
      break;
    }
    collected.push(...extractJsonLdEvents(html));
    url = findNextPage(html);
  }

  logger.info({ startUrl, events: collected.length, via: proxy ? "proxy" : "plain/headless" }, "JSON-LD extraction complete");
  return collected;
}
