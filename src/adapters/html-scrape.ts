import type { DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";

/**
 * HTML-scrape adapter (confidence: medium) — STUB.
 *
 * For no-feed sources (DECC, Visit Duluth, Duluth Reader). Each needs a site-specific parser:
 * fetch the calendar HTML, extract event nodes (title/date/venue/url), and map to DuluthEvent with
 * `extractionMethod: "html-scrape"` and `confidence: "medium"`. Recommended tooling: `cheerio` for
 * DOM parsing (add as a dep when implementing). Returns [] until a per-site parser is written.
 */
export const importHtml: Adapter = async (source: SourceDef): Promise<DuluthEvent[]> => {
  logger.warn({ source: source.name }, "html-scrape adapter is a stub — no events emitted yet");
  return [];
};
