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
  /** For adapter="structured-api": which per-source JSON mapper to use. */
  mapper?: "legistar" | "tribe-rest" | "squarespace" | "rec1";
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
  // --- Nature centers & museums (venue-own calendars; multisample -> corroborate/merge) ---
  {
    name: "Duluth Art Institute",
    adapter: "structured-api",
    mapper: "tribe-rest",
    url: "https://duluthart.org/wp-json/tribe/events/v1/events",
    type: "json-api",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. The Events Calendar REST — venue's own calendar, ~102 upcoming events (art classes, camps, exhibitions). First-party -> high.",
  },
  {
    name: "North Shore Scenic Railroad",
    adapter: "structured-api",
    mapper: "tribe-rest",
    url: "https://duluthtrains.com/wp-json/tribe/events/v1/events",
    type: "json-api",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. The Events Calendar REST — ~7 events (dinner trains, excursions).",
  },
  {
    name: "Glensheen",
    adapter: "ical",
    url: "https://calendar.d.umn.edu/live/ical/events/group/Glensheen",
    type: "ics-feed",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. LiveWhale GROUP-scoped ICS (Glensheen-only). ~9 VEVENTs (concerts on the pier, lectures). Also appears in the main UMD feed -> dedupe corroborates/merges (multisample).",
  },
  {
    name: "St. Louis River Alliance",
    adapter: "structured-api",
    mapper: "squarespace",
    url: "https://www.stlouisriver.org/events",
    type: "json-api",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. Squarespace Events collection via ?format=json (upcoming[] with epoch-ms startDate). ~6 upcoming (volunteer days, paddling workshops, River Revival). Some events across the bridge (Superior WI) -> tagged inDuluth:false.",
  },
  {
    name: "Friends of the Lake Superior Reserve",
    adapter: "structured-api",
    mapper: "squarespace",
    url: "https://folsr.org/events",
    type: "json-api",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. Squarespace ?format=json (runs the Lake Superior Estuarium, Barker's Island, Superior WI). ~33 upcoming (Estuarium open hours, Everyone Can Bird). Superior-WI venue -> inDuluth:false.",
  },
  {
    name: "Richard I. Bong Veterans Historical Center",
    adapter: "structured-api",
    mapper: "tribe-rest",
    url: "https://bongcenter.org/wp-json/tribe/events/v1/events",
    type: "json-api",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED. The Events Calendar REST — Superior, WI (across the bridge; mapper tags inDuluth:false via venue city). Thin (~3 upcoming). Use a >=12-month window.",
  },
  {
    name: "Friends of Sax-Zim Bog",
    adapter: "structured-api",
    mapper: "tribe-rest",
    url: "https://saxzim.org/wp-json/tribe/events/v1/events",
    type: "json-api",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED working (returned a real past event) but 0 upcoming posted right now — birding/nature programming ~40mi north of Duluth. Harmless when empty; contributes when populated.",
  },
  {
    name: "Duluth Public Library",
    adapter: "jsonld",
    url: "https://duluthlibrary.events.mylibrary.digital/events",
    type: "html-calendar",
    confidence: "medium",
    enabled: false,
    notes: "BLOCKED (Cloudflare Turnstile). Real LibraryMarket events calendar (duluthlibrary.events.mylibrary.digital) but the whole zone is behind a Turnstile managed challenge that bundled Playwright/Chrome cannot pass (CDP-detected, even headed). Needs patchright/stealth or a harvested cf_clearance cookie. See docs/extraction-methods.md.",
  },
  {
    name: "Twin Ports Nightlife",
    adapter: "html",
    url: "https://www.twinportsnightlife.com/music?format=feed&type=rss",
    type: "html-calendar",
    confidence: "medium",
    enabled: false,
    notes: "CRACKED (sniffed): Joomla + iCagenda exposes a native RSS 2.0 feed at ?format=feed&type=rss on list views (/music, /the-nightlife/calendar). Plain fetch, no bot-wall. Needs a new `rss` adapter (10-item Joomla cap). Live-music value.",
  },
  {
    name: "The DECC",
    adapter: "html",
    url: "https://decc.org/wp-content/plugins/swim-events-calendar/events-template.php?cat=All",
    type: "html-calendar",
    confidence: "medium",
    enabled: false,
    notes: "CRACKED (sniffed): NOT The Events Calendar (tribe 404 was a red herring) — a bespoke `swim-events-calendar` plugin fragment endpoint returns all ~94 events in one plain fetch. Needs an html-scrape adapter (stable classes .event-list-item/.entry-title/.event-date/.slide-venue).",
  },
  {
    name: "Duluth Farmers Market",
    adapter: "ical",
    url: "https://duluthfarmersmarket.com/feed/my-calendar-google/",
    type: "ics-feed",
    confidence: "high",
    enabled: false,
    notes: "CRACKED (sniffed): WP My Calendar exposes a real ICS at /feed/my-calendar-google/. Use the APEX host (cert lacks a www SAN). Reuses the ical adapter. Thin (~2 recurring VEVENTs). Enable once the apex-TLS path is confirmed.",
  },
  {
    name: "Duluth Reader",
    adapter: "html",
    url: "https://duluthreader.com/events/calendar",
    type: "html-calendar",
    confidence: "medium",
    enabled: false,
    notes: "CRACKED (sniffed): custom server-rendered calendar; one plain GET per day at /events/calendar/YYYY/MM/DD?city=duluth -> <article class=result event_time> (.title/.date/.location_text/.cost/.age). Needs an html-scrape adapter with date-range iteration.",
  },
];
