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
export type AdapterKind = "ical" | "html" | "pdf-llm";

export interface SourceDef {
  name: string;
  adapter: AdapterKind;
  /** iCal feed URL, HTML calendar URL, or PDF URL depending on adapter. */
  url?: string;
  type: Source["type"];
  confidence: Source["confidence"];
  enabled: boolean;
  notes?: string;
}

export const SOURCES: SourceDef[] = [
  {
    name: "Perfect Duluth Day",
    adapter: "ical",
    url: "https://perfectduluthday.com/duluth-events/?ical=1",
    type: "ics-feed",
    confidence: "high",
    enabled: true,
    notes: "CONFIRMED feed, but the endpoint sits behind a Cloudflare JS challenge that a plain server fetch (any User-Agent) CANNOT clear — verified 403. Needs a headless-browser fetcher (e.g. Playwright) wired into fetchIcsText, OR subscribe to it directly in your calendar app. Left enabled so its failure is visible in /stats.",
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
    name: "DoDuluth",
    adapter: "ical",
    url: "https://doduluth.com/events/?ical=1",
    type: "ics-feed",
    confidence: "high",
    enabled: false,
    notes: "CONFIRMED feed but possibly STALE (rendered 2024 events). Heavy overlap with PDD. Enable only for redundancy.",
  },
  {
    name: "Duluth Parks & Recreation (brochure)",
    adapter: "pdf-llm",
    url: "https://duluthmn.gov/media/3fjdsbwc/parks-and-recreation-summer-2026-brochure-for-web.pdf",
    type: "pdf-brochure",
    confidence: "low",
    enabled: false,
    notes: "Seasonal PDF brochure (no ICS feed exists). Needs pdf text extraction + LLM structuring. Adapter is a stub.",
  },
  {
    name: "Duluth Public Library",
    adapter: "pdf-llm",
    url: "https://duluthmn.gov/communications/press-releases/duluth-public-library/",
    type: "pdf-brochure",
    confidence: "low",
    enabled: false,
    notes: "Library programs are published as City press-release PDFs (no LibCal/ICS found). Needs PDF+LLM extraction. Stub.",
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
