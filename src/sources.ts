import type { Source } from "./schema.js";

/**
 * The source registry — every Duluth events origin, its adapter, and its confidence tier.
 *
 * Confidence is bound to the adapter/extraction method by the schema's CONFIDENCE_CEILING:
 *   ics  -> ics-import  -> high   (first-party .ics feed, verified live)
 *   html -> html-scrape -> medium (no feed; parsed from calendar markup)
 *   pdf  -> pdf-llm-extract -> low (LLM read a brochure; never trusted like a feed)
 *
 * `enabled: false` sources are wired but not yet fetched (stub adapters / needs work).
 * URLs marked CONFIRMED were fetched during research (2026-07-23) and returned real VCALENDAR.
 */
export type AdapterKind = "ical" | "structured-api" | "jsonld" | "rec1" | "html" | "pdf-llm";

export interface SourceDef {
  name: string;
  adapter: AdapterKind;
  /** For adapter="structured-api": which per-source JSON mapper to use. ("rec1" adapter TBD.) */
  mapper?: "legistar" | "tribe-rest" | "rec1";
  /** iCal feed URL, JSON API base, HTML calendar URL, or PDF URL depending on adapter. */
  url?: string;
  type: Source["type"];
  confidence: Source["confidence"];
  enabled: boolean;
  notes?: string;
}

export const SOURCES: SourceDef[] = [
  {
    name: "Perfect Duluth Day",
    adapter: "jsonld",
    url: "https://perfectduluthday.com/duluth-events/list/",
    type: "html-calendar",
    confidence: "medium",
    enabled: true,
    notes: "Cloudflare WAF blocks ?ical=1 AND wp-json/tribe even from a cleared browser (verified 2026-07-23), but the rendered list page embeds full schema.org Event JSON-LD. Extracted via headless Chromium (jsonld adapter), paginated. Broad crowd-sourced calendar → medium.",
  },
  {
    name: "UMD Events",
    adapter: "ical",
    url: "https://calendar.d.umn.edu/live/ical/events",
    type: "ics-feed",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. LiveWhale. University of Minnesota Duluth campus events (lectures, planetarium, concerts, athletics).",
  },
  {
    name: "Duluth City Meetings (Legistar)",
    adapter: "structured-api",
    mapper: "legistar",
    url: "https://webapi.legistar.com/v1/duluth-mn/events",
    type: "json-api",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. Granicus Legistar Web API (client slug `duluth-mn`), documented OData JSON. City Council + ~18 boards/commissions (incl. Library Board, Parks & Rec Commission). First-party government record → high, verified.",
  },
  {
    name: "Visit Duluth",
    adapter: "structured-api",
    mapper: "tribe-rest",
    url: "https://visitduluth.com/wp-json/tribe/events/v1/events",
    type: "json-api",
    confidence: "medium",
    enabled: true,
    notes: "CONFIRMED. The Events Calendar REST API (~1158 events). Aggregator that also re-lists DECC → medium (dedupe collapses the overlap). Paginated; v1 pulls the first 50 upcoming.",
  },
  {
    name: "Do Duluth",
    adapter: "structured-api",
    mapper: "tribe-rest",
    url: "https://doduluth.com/wp-json/tribe/events/v1/events",
    type: "json-api",
    confidence: "medium",
    enabled: true,
    notes: "CONFIRMED. The Events Calendar REST (wp-json/tribe), HTTP 200 with a browser UA. Broad Twin Ports 'everything happening' aggregator. Overlaps PDD/DECC — dedupe collapses.",
  },
  {
    name: "Whole Foods Co-op",
    adapter: "structured-api",
    mapper: "tribe-rest",
    url: "https://wholefoods.coop/wp-json/tribe/events/v1/events",
    type: "json-api",
    confidence: "medium",
    enabled: true,
    notes: "CONFIRMED. The Events Calendar REST, HTTP 200 (~19 events). Co-op community calendar (classes, meetups, board meetings). Narrower/civic.",
  },
  {
    name: "Duluth Parks & Recreation",
    adapter: "rec1",
    url: "https://secure.rec1.com/MN/duluthparks/catalog",
    type: "json-api",
    confidence: "medium",
    enabled: true,
    notes: "REC1/CivicRec catalog as structured JSON (retires the PDF brochure). hash from catalog HTML -> getItems (program groups) -> getActivitySessions (dated sessions with date/time/location/fee/age). eventType=class; multi-week ranges -> multiDay. Deterministic, no LLM.",
  },
  {
    name: "Duluth Public Library",
    adapter: "jsonld",
    url: "https://duluthlibrary.events.mylibrary.digital/events",
    type: "html-calendar",
    confidence: "medium",
    enabled: false,
    notes: "CORRECTION (surfaced via r/duluth): the library runs a real events calendar on the LibraryMarket platform (duluthlibrary.events.mylibrary.digital) — NOT just City press-release PDFs as earlier assumed. Bot-gated (403 to plain fetch) → needs the headless path like PDD; confirm whether it embeds Event JSON-LD or exposes a LibraryMarket iCal/RSS export before wiring. Far better than the PDF route.",
  },
  {
    name: "Twin Ports Nightlife",
    adapter: "html",
    url: "https://www.twinportsnightlife.com/",
    type: "html-calendar",
    confidence: "medium",
    enabled: false,
    notes: "r/duluth-recommended live-music/nightlife listings. NOT WordPress (no wp-json / ?ical=1 / tribe REST — all 404). Custom platform → needs an HTML scrape or JSON-LD from a rendered page. Lead, unwired.",
  },
  {
    name: "The DECC",
    adapter: "html",
    url: "https://decc.org/events-calendar/",
    type: "html-calendar",
    confidence: "medium",
    enabled: false,
    notes: "No ICS feed. Custom WordPress. Arena/theater/convention shows. Needs HTML scrape. Stub.",
  },
];
