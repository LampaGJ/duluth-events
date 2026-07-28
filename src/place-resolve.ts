import { cleanText, unescapeIcsText } from "./normalize.js";
import { extractLeadingCity } from "./facets.js";

/**
 * Venue-string normalization.
 *
 * @displayName Venue Normalizer
 * @strategicPurpose Cross-source duplicates cannot be found by comparing venue strings — the same
 *   physical place appears as "Bent Paddle Brewing", "Bent Paddle Taproom // 1832 W Michigan St. //
 *   Duluth", and "1832 W Michigan St, Duluth, MN, United States, Minnesota 55806". This module turns
 *   any of those into a stable lookup key so `resolvePlace` (in `place-registry.ts`) can find them
 *   all under one identity.
 * @tacticalObjective Normalize a raw venue string to a stable lookup key, reject sentinels, and
 *   split packed "City, ST, Venue" forms — deterministically, with no fuzzy matching and no I/O.
 *
 * Import direction is deliberately one-way: this file imports NOTHING from `place-registry.ts`, not
 * even a type. `place-registry.ts` imports these normalizers, never the other way around — a prior
 * version of this file imported `PLACE_INDEX` back for `resolvePlace`, which closed a cycle and
 * crashed on module load the moment any module-scope `const` here was read during that cycle's
 * eager index build. `resolvePlace` now lives in `place-registry.ts`, where the graph is strictly
 * `classify -> place-registry -> place-resolve`.
 */

/**
 * Combining diacritical marks (U+0300-U+036F) left behind by `String.prototype.normalize("NFD")`
 * once a precomposed accented letter (é, ñ, å, …) is decomposed into base-letter + mark.
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Transliterate accented Latin letters to their unaccented ASCII base, upper- and lower-case alike.
 * NFD + combining-mark strip is the general mechanism (é -> "e"+◌́ -> "e"); æ, ø and ß do NOT
 * decompose under NFD (they are their own code points, not base-letter-plus-accent), so those three
 * get an explicit substitution instead. Deliberately mechanical, not a curated list of "known"
 * accented venue names — any accented Latin letter this doesn't special-case still folds correctly
 * via NFD, so a future source's "Château" or "Piña" degrades safely without a code change.
 */
function transliterate(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/ß/g, "ss");
}

/** Trailing tokens that mark a legal/company suffix, never a real word inside a venue name. */
const LEGAL_SUFFIXES = new Set(["company", "co", "inc", "llc", "ltd", "corp", "incorporated"]);

/** Leading tokens that are grammatical articles, never load-bearing for venue identity. */
const LEADING_ARTICLES = new Set(["the", "a", "an"]);

/**
 * Normalize to a lookup key. Order matters and each step fixes a measured probe defect:
 *   1. unescape ICS (`\;` `\,` `\\`) — otherwise `&#038\;` never decodes
 *   2. decode HTML entities (cleanText) — BEFORE transliteration, so a numeric-entity accent
 *      ("Caf&#233;") is real Unicode by the time step 3 looks for it, not still an entity string
 *   3. transliterate accented Latin letters to their ASCII base — BEFORE the punctuation strip
 *      (step 7), which otherwise treats an accented letter as punctuation and DELETES it outright
 *      ("Café" -> "caf", not "cafe"). This was a live bug: Task 9b fixed the slug generator's own
 *      copy of this transliteration but not this function, so a place's id and its matching key
 *      disagreed on accented venues.
 *   4. `&` -> " and " — BEFORE punctuation stripping, so "Sports & Health" and "Sports and Health"
 *      converge on the same tokens instead of "&" silently vanishing into whitespace
 *   5. strip parenthetical suffixes — "(G)", "(MWAP)" are room/building codes, not venue identity
 *   6. strip apostrophes (elide, don't space-break — "Wussow's" -> "wussows" not "wussow s")
 *   7. lowercase, strip punctuation, collapse whitespace
 *   8. strip a leading article token (the/a/an) — AFTER tokenizing, so "The Rex" and "Rex" converge
 *   9. strip trailing legal/company-suffix tokens — same tokenized pass, restricted to exactly the
 *      LAST token, so a mid-string or non-trailing "co"/"op" survives untouched ("Co-op" -> "co op",
 *      last token is "op", not a suffix, so nothing strips; "Co-op Deli" -> "co op deli" likewise)
 *
 * Idempotent by construction: every step above either is a no-op on its own output (transliterating
 * already-ASCII text, replacing an "&" that no longer exists) or removes a token that a second pass
 * would no longer find at the position it looks (a leading/trailing token already stripped).
 */
export function normalizeVenueKey(raw: string): string {
  const unescaped = unescapeIcsText(raw);
  const withAnd = transliterate(cleanText(unescaped)).replace(/&/g, " and ");
  const base = withAnd
    .replace(/\(.*?\)/g, " ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const tokens = base.split(" ").filter(Boolean);
  if (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0]!)) tokens.shift();
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();

  return tokens.join(" ");
}

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

/** Words that plausibly continue a sentinel phrase rather than start a real venue name. */
const SENTINEL_CONTINUATIONS = ["for", "see", "check", "tbd"];

export function isSentinelVenue(raw: string): boolean {
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
