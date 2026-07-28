import { cleanText } from "./normalize.js";
import { extractLeadingCity } from "./facets.js";
import type { PlaceRef } from "./schema.js";
import { PLACE_INDEX, type PlaceIndex } from "./place-registry.js";

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

/**
 * Placeholder strings sources emit when they have no venue, and words that plausibly continue a
 * sentinel phrase rather than start a real venue name.
 *
 * Declared INSIDE the function, not at module scope: `place-resolve.ts` and `place-registry.ts`
 * import each other (the registry imports these normalizers; `resolvePlace` below imports
 * `PLACE_INDEX`), and `place-registry.ts` eagerly builds `PLACE_INDEX` at module load. When this
 * module is the entry point, that eager build calls back into `isSentinelVenue` before this
 * module's OWN top-level statements have run — a module-scope `const` here would still be in its
 * temporal dead zone at that point and throw. A function-local const has no such ordering
 * dependency: it is freshly created on every call, cycle or not.
 */
export function isSentinelVenue(raw: string): boolean {
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
  const SENTINEL_CONTINUATIONS = ["for", "see", "check", "tbd"];

  const key = normalizeVenueKey(raw ?? "");
  if (!key) return true;
  return SENTINELS.some((s) => {
    if (key === s) return true;
    if (!key.startsWith(`${s} `)) return false;
    // A prefix match only counts as a sentinel when the sentinel itself is a multi-word phrase
    // (too specific to accidentally open a real venue name), or when a single-word sentinel is
    // followed by another sentinel-flavored word — otherwise a lone sentinel word starting a real
    // venue name (e.g. "Various Stages at Bayfront", "TBD Skatepark") would be misclassified.
    if (s.includes(" ")) return true;
    const rest = key.slice(s.length + 1);
    return SENTINEL_CONTINUATIONS.some((w) => rest === w || rest.startsWith(`${w} `));
  });
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

/** kebab slug for a provisional id. Prefixed "~" so provisional ids can never collide with curated ones. */
function provisionalId(key: string): string {
  return `~${key.replace(/\s+/g, "-")}`;
}

/**
 * Resolve a raw venue string to a canonical place.
 *
 * Three outcomes, deliberately distinct:
 *   sentinel      -> undefined     never merges, never gets a feed
 *   registered    -> stable id     public feed URL, id guaranteed not to move
 *   anything else -> provisional   usable for dedupe, no feed, no stability promise
 */
export function resolvePlace(venueRaw: string | undefined, index: PlaceIndex = PLACE_INDEX): PlaceRef | undefined {
  if (!venueRaw || isSentinelVenue(venueRaw)) return undefined;

  const parsed = parseVenueString(venueRaw);
  const key = normalizeVenueKey(parsed.name);
  if (!key) return undefined;

  const hit = index.byNameAlias.get(key) ?? index.byAddressAlias.get(key);
  if (hit) return { id: hit.id, name: hit.name, provisional: false };

  // Also try the FULL raw string: sources like Do Duluth put the whole address in the venue field,
  // and that form is registered as an address alias.
  const fullKey = normalizeVenueKey(venueRaw);
  const fullHit = index.byNameAlias.get(fullKey) ?? index.byAddressAlias.get(fullKey);
  if (fullHit) return { id: fullHit.id, name: fullHit.name, provisional: false };

  return { id: provisionalId(key), name: parsed.name, provisional: true };
}
