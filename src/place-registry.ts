import { PlaceSchema, type Place, type PlaceRef } from "./schema.js";
import { normalizeVenueKey, isSentinelVenue, parseVenueString } from "./place-resolve.js";
import { PLACES } from "./places.js";

/**
 * Registry loading, indexing, and resolution.
 *
 * @displayName Place Index
 * @strategicPurpose Resolution must be O(1) and exact at build time — all fuzziness lives in the
 *   offline proposer. This turns the curated registry into the lookup maps that make that possible,
 *   and holds `resolvePlace`, the one function that walks a raw venue string to a canonical place.
 * @tacticalObjective Validate every entry, normalize aliases on the way in, and FAIL FAST on a
 *   duplicate id or a colliding alias: the registry is a build-time asset, so a broken one must stop
 *   the build rather than silently mis-resolve events.
 *
 * `resolvePlace` lives HERE, not in `place-resolve.ts`, so the import graph stays strictly
 * one-directional: `classify.ts -> place-registry.ts -> place-resolve.ts`. `place-resolve.ts`
 * imports nothing from this file — a prior version had `resolvePlace` in `place-resolve.ts`
 * importing `PLACE_INDEX` back from here, which closed a cycle. Because this module eagerly builds
 * `PLACE_INDEX` at load time (the fail-fast guarantee above), that cycle meant `place-resolve.ts`
 * could get called back into, via this eager build, before its OWN top-level `const`s had run —
 * `SENTINELS` was one such landmine, and would not have been the last: ANY future module-scope
 * `const`/`let`/`class` added to `place-resolve.ts` would have carried the same latent crash. Keeping
 * the graph one-way removes the hazard structurally instead of relying on a convention nothing
 * enforces.
 */

export interface PlaceIndex {
  byId: Map<string, Place>;
  byNameAlias: Map<string, Place>;
  byAddressAlias: Map<string, Place>;
  all: Place[];
}

export function buildPlaceIndex(places: readonly unknown[]): PlaceIndex {
  const all = places.map((p) => PlaceSchema.parse(p));

  const byId = new Map<string, Place>();
  for (const p of all) {
    if (byId.has(p.id)) throw new Error(`duplicate place id: "${p.id}"`);
    byId.set(p.id, p);
  }

  const byNameAlias = new Map<string, Place>();
  const byAddressAlias = new Map<string, Place>();

  const claim = (map: Map<string, Place>, kind: string, raw: string, p: Place): void => {
    const key = normalizeVenueKey(raw);
    if (!key) return;
    if (isSentinelVenue(key)) throw new Error(`place "${p.id}" claims sentinel ${kind} alias "${raw}" — sentinels must never resolve`);
    const existing = map.get(key);
    if (existing && existing.id !== p.id) throw new Error(`${kind} alias "${key}" claimed by both "${existing.id}" and "${p.id}"`);
    map.set(key, p);
  };

  for (const p of all) {
    claim(byNameAlias, "name", p.name, p); // the canonical name is always an alias for itself
    for (const a of p.nameAliases) claim(byNameAlias, "name", a, p);
    for (const a of p.addressAliases) claim(byAddressAlias, "address", a, p);
  }

  return { byId, byNameAlias, byAddressAlias, all };
}

/** The shipped registry, validated at module load. A bad entry throws before any event is processed. */
export const PLACE_INDEX: PlaceIndex = buildPlaceIndex(PLACES);

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

  // Also try the FULL raw string, not just the parsed name. This only diverges from the lookup
  // above when parseVenueString actually stripped a leading "City, ST," (the away-game case) — for
  // an ordinary venue string `key` and `fullKey` are identical, so this second lookup is a cheap
  // no-op, not dead weight. It matters when a curator aliases the venue's literal corpus form
  // VERBATIM, city prefix and all (e.g. pasting "Pueblo, CO, Massari Arena" straight from the feed
  // rather than first mentally splitting it into "Massari Arena") — see
  // test/place-registry.test.ts's "resolves via the literal packed alias" case.
  const fullKey = normalizeVenueKey(venueRaw);
  const fullHit = index.byNameAlias.get(fullKey) ?? index.byAddressAlias.get(fullKey);
  if (fullHit) return { id: fullHit.id, name: fullHit.name, provisional: false };

  return { id: provisionalId(key), name: parsed.name, provisional: true };
}
