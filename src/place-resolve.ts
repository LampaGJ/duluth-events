import { cleanText } from "./normalize.js";
import { extractLeadingCity } from "./facets.js";

/**
 * Venue-string normalization and resolution.
 *
 * @displayName Place Resolver
 * @strategicPurpose Cross-source duplicates cannot be found by comparing venue strings — the same
 *   physical place appears as "Bent Paddle Brewing", "Bent Paddle Taproom // 1832 W Michigan St. //
 *   Duluth", and "1832 W Michigan St, Duluth, MN, United States, Minnesota 55806". Resolution turns
 *   all three into one identity.
 * @tacticalObjective Normalize a raw venue string to a stable lookup key, reject sentinels, and
 *   split packed "City, ST, Venue" forms — deterministically, with no fuzzy matching and no I/O.
 */

/**
 * Placeholder strings sources emit when they have no venue. These must NEVER resolve to a place:
 * two events at the same instant both reading "See listing" are demonstrably different events, and
 * merging them would DELETE one. 129 of 461 live events (28%) carry one.
 */
const SENTINELS = [
  "see listing",
  "see catalog",
  "see agenda",
  "not specified",
  "sign in to download the location",
  "tbd",
  "to be determined",
  "various",
  "varies",
];

/**
 * Normalize to a lookup key. Order matters and each step fixes a measured probe defect:
 *   1. unescape ICS (`\;` `\,` `\\`) — otherwise `&#038\;` never decodes
 *   2. decode HTML entities (cleanText)
 *   3. strip parenthetical suffixes — "(G)", "(MWAP)" are room/building codes, not venue identity
 *   4. strip apostrophes (elide, don't space-break — "Wussow's" -> "wussows" not "wussow s")
 *   5. lowercase, strip punctuation, collapse whitespace
 */
export function normalizeVenueKey(raw: string): string {
  const unescaped = raw.replace(/\\([;,\\])/g, "$1");
  return cleanText(unescaped)
    .replace(/\(.*?\)/g, " ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isSentinelVenue(raw: string): boolean {
  const key = normalizeVenueKey(raw ?? "");
  if (!key) return true;
  return SENTINELS.some((s) => key === s || key.startsWith(`${s} `));
}

/**
 * Split a packed venue string into its name and, when present, the city it leads with.
 *
 * UMD athletics encodes away games as "<City>, <ST>, <Venue>" inside the venue field while the city
 * field still says Duluth — which shipped 59 out-of-state games inside `duluth-proper.ics`. This is
 * where the deleted `resolveLocation()`'s fix now lives, parsing into the RIGHT fields instead of
 * rewriting a conflated one.
 */
export function parseVenueString(raw: string): { name: string; city?: string; state?: string } {
  const found = extractLeadingCity(raw);
  if (!found) return { name: cleanText(raw) };
  return { name: found.rest || found.city, city: found.city, state: found.state };
}
