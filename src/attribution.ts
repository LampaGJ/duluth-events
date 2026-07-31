import { PLACES } from "./places.js";
import type { PlaceInput } from "./schema.js";

/**
 * @displayName Data-source attribution
 * @strategicPurpose Several vendored reference datasets carry a licence that obliges us to credit
 *   them wherever their data reaches a public page. A hardcoded credit line rots in both directions:
 *   it under-credits the moment a place is registered from a new dataset (a licence violation), and
 *   it over-credits a dataset we no longer ship (a false claim about provenance). So the credits are
 *   DERIVED from the provenance actually present in the registry, never hand-maintained.
 * @tacticalObjective Map each registered place's `provenance` to the dataset that produced it, and
 *   return the distinct set of credits owed by the places we actually publish.
 */

export interface Credit {
  /** Dataset key as it appears in a `provenance.ref` prefix. */
  key: string;
  /** Rendered credit text, e.g. "© OpenStreetMap contributors". */
  text: string;
  /** Canonical licence/attribution URL. */
  url: string;
}

/**
 * Every dataset a `provenance` may name. Adding a place sourced from a dataset absent here is a
 * build-time error rather than a silently-uncredited record — see `creditsFor`.
 *
 * `nominatim` is OpenStreetMap's own geocoder, so it collapses onto the OSM credit (same `key`);
 * two refs producing one credit is the normal case, not a special one.
 */
const DATASETS: Record<string, Credit> = {
  osm: { key: "osm", text: "© OpenStreetMap contributors, ODbL", url: "https://www.openstreetmap.org/copyright" },
  nominatim: { key: "osm", text: "© OpenStreetMap contributors, ODbL", url: "https://www.openstreetmap.org/copyright" },
  overture: { key: "overture", text: "© Overture Maps Foundation", url: "https://docs.overturemaps.org/attribution/" },
  homegrown: {
    key: "homegrown",
    text: "Duluth Homegrown Map venue list",
    url: "https://github.com/LampaGJ/duluth-homegrown-map",
  },
};

/**
 * A `ref` is EITHER a `dataset:local-id` key (`"overture:08f2ab…"`) or a bare citation — an OSM
 * element id (`"way/123456"`) or the URL a fact was read from. Only the first form names a dataset.
 * A URL is excluded explicitly: `"https://…"` would otherwise parse as the dataset `https`.
 */
function datasetKeyOf(prov: PlaceInput["provenance"]): string | undefined {
  const ref = prov.ref;
  if (ref && !/^https?:/i.test(ref)) {
    const m = /^([a-z][a-z0-9-]*):/.exec(ref);
    if (m) return m[1];
  }
  // No dataset-qualified ref: `source: "osm"` still means OSM. `web`/`manual` are our own research
  // against a cited page, which obliges no dataset credit.
  return prov.source === "osm" ? "osm" : undefined;
}

/**
 * The credits owed by a set of places, deduplicated and stably ordered.
 *
 * Throws on an unrecognized dataset key. The asymmetry is deliberate and matches the rest of this
 * codebase: shipping an uncredited dataset is a licence violation that is invisible at runtime,
 * while a build that fails loudly is fixed in one line by registering the dataset above.
 */
export function creditsFor(places: readonly PlaceInput[] = PLACES): Credit[] {
  const byKey = new Map<string, Credit>();
  for (const p of places) {
    const key = datasetKeyOf(p.provenance);
    if (key === undefined) continue;
    const credit = DATASETS[key];
    if (!credit) {
      throw new Error(
        `place "${p.id}" cites unknown dataset "${key}" in provenance.ref — register it in ` +
          `src/attribution.ts DATASETS so its licence is credited on the public page`,
      );
    }
    byKey.set(credit.key, credit);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
