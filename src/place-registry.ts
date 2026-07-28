import { PlaceSchema, type Place } from "./schema.js";
import { normalizeVenueKey, isSentinelVenue } from "./place-resolve.js";
import { PLACES } from "./places.js";

/**
 * Registry loading and indexing.
 *
 * @displayName Place Index
 * @strategicPurpose Resolution must be O(1) and exact at build time — all fuzziness lives in the
 *   offline proposer. This turns the curated registry into the lookup maps that make that possible.
 * @tacticalObjective Validate every entry, normalize aliases on the way in, and FAIL FAST on a
 *   duplicate id or a colliding alias: the registry is a build-time asset, so a broken one must stop
 *   the build rather than silently mis-resolve events.
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
