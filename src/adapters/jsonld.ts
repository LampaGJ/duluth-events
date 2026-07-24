import { DuluthEventSchema, type DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";
import { DEFAULT_TZ, makeUid, nowIso, wallTimeToIso } from "../normalize.js";
import { fetchJsonLdEvents, type JsonLdEvent } from "../fetchers/headless.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** schema.org descriptions are often entity-encoded HTML ("&lt;p&gt;…"); decode then strip tags. */
function decodeAndStrip(s: string): string {
  const decoded = s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;|&rsquo;|&#8217;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&nbsp;/gi, " ")
    .replace(/\\n|\\r/g, " ");
  return decoded
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mapLocation(loc: unknown): DuluthEvent["location"] {
  const o = loc && typeof loc === "object" ? (loc as Record<string, unknown>) : {};
  const addr = o.address && typeof o.address === "object" ? (o.address as Record<string, unknown>) : {};
  const city = str(addr.addressLocality) ?? "Duluth";
  return {
    venueName: str(o.name) ?? "See listing",
    street: str(addr.streetAddress),
    city,
    state: str(addr.addressRegion) ?? "MN",
    inDuluth: !/\bsuperior\b/i.test(city),
  };
}

function mapCost(offers: unknown): DuluthEvent["cost"] {
  const arr = Array.isArray(offers) ? offers : offers ? [offers] : [];
  const prices: number[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    for (const key of ["price", "lowPrice", "highPrice"]) {
      const n = Number(o[key]);
      if (Number.isFinite(n)) prices.push(n);
    }
  }
  if (prices.length === 0) return { kind: "unknown" };
  if (prices.every((p) => p === 0)) return { kind: "free" };
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return { kind: "paid", priceMin: min, priceMax: max === min ? undefined : max, currency: "USD" };
}

function mapStatus(s: unknown): DuluthEvent["status"] {
  const v = String(s ?? "");
  if (/Cancelled/i.test(v)) return "cancelled";
  if (/Postponed/i.test(v)) return "tentative";
  return "confirmed";
}

/** A date-only value ("2026-07-23") means all-day; give it a concrete midnight instant. */
function normalizeStart(raw: string): { start: string; allDay: boolean } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, mo, d] = raw.split("-").map(Number);
    return { start: wallTimeToIso(y!, mo!, d!, 0, 0, 0), allDay: true };
  }
  return { start: raw, allDay: false };
}

export function mapJsonLdEvent(raw: JsonLdEvent, source: SourceDef, retrievedAt: string): DuluthEvent | null {
  const name = str(raw.name);
  const rawStart = str(raw.startDate);
  if (!name || !rawStart) return null;
  const { start, allDay } = normalizeStart(rawStart);
  const loc = mapLocation(raw.location);
  const rawEnd = str(raw.endDate);
  const end = rawEnd && rawEnd.includes("T") ? rawEnd : undefined;

  const candidate = {
    uid: makeUid(source.name, str(raw.url), name, start, loc.venueName),
    title: decodeAndStrip(name),
    description: str(raw.description) ? decodeAndStrip(str(raw.description)!).slice(0, 1500) : undefined,
    start,
    end,
    allDay,
    timezone: DEFAULT_TZ,
    location: loc,
    cost: mapCost(raw.offers),
    url: str(raw.url),
    imageUrl: str(raw.image),
    status: mapStatus(raw.eventStatus),
    source: {
      name: source.name,
      type: source.type,
      url: source.url,
      sourceEventId: str(raw.url),
      extractionMethod: "jsonld" as const,
      retrievedAt,
      confidence: source.confidence, // "medium" — spec'd schema.org data off a rendered page
      verified: false,
    },
  };

  const parsed = DuluthEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logger.warn({ source: source.name, title: candidate.title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid event");
  return null;
}

/** JSON-LD adapter: headless-render a Cloudflare/JS-gated page and map its schema.org Events. */
export const importJsonLd: Adapter = async (source: SourceDef): Promise<DuluthEvent[]> => {
  if (!source.url) throw new Error(`jsonld: source "${source.name}" has no url`);
  const today = new Date().toISOString().slice(0, 10);
  const raw = await fetchJsonLdEvents(source.url, 3, today);
  const retrievedAt = nowIso();
  return raw.map((r) => mapJsonLdEvent(r, source, retrievedAt)).filter((e): e is DuluthEvent => e !== null);
};
