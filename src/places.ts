import type { PlaceInput } from "./schema.js";

/**
 * The canonical venue registry — the SOURCE OF TRUTH for place identity.
 *
 * @displayName Place Registry
 * @strategicPurpose Place ids appear in feed URLs, so they must never move. This file is curated and
 *   committed: `scripts/places-propose.mjs` PROPOSES entries but never writes here. The human paste
 *   IS the id-stability guarantee, and every judgment is visible in a git diff.
 * @tacticalObjective Map every venue-string variant a source emits onto one stable id, with a
 *   canonical address used to enrich events whose source supplied none.
 *
 * Adding an entry:
 *   1. `npm run places:propose` — prints paste-ready literals with provenance and a similarity score
 *   2. VERIFY the match yourself. A geocoder's confident wrong answer looks exactly like data:
 *      "Restaurant 301" resolved to "Perkins", "Sioux Falls" to "South Duluth Avenue".
 *   3. Paste here. Aliases may be written readably — buildPlaceIndex normalizes them on load.
 *
 * Typed as `PlaceInput[]` (the Zod INPUT type, `z.input<typeof PlaceSchema>`), not `Place[]` (the
 * post-parse output type) — these are hand-authored literals, parsed for the first time inside
 * buildPlaceIndex. `nameAliases` / `addressAliases` / `rooms` all default to `[]` in PlaceSchema, so
 * an entry with none of those need not write them at all.
 *
 * Address data from OpenStreetMap is ODbL; attribution ships in the feed footer.
 */
export const PLACES: PlaceInput[] = [
  {
    id: "bent-paddle-taproom",
    name: "Bent Paddle Brewing Co. — Brewery + Taproom",
    nameAliases: ["Bent Paddle Brewing", "Bent Paddle Taproom", "Bent Paddle Taproom 1832 W Michigan St."],
    addressAliases: ["1832 W Michigan St", "1832 W Michigan St, Duluth, MN, United States, Minnesota 55806"],
    address: { street: "1832 W Michigan St", city: "Duluth", state: "MN", inDuluth: true },
    rooms: ["The Yard"],
    provenance: { source: "manual", ref: "corpus + nominatim; street taken from the corpus listing, not the OSM 1912 result" },
  },
  {
    id: "lake-superior-estuarium",
    name: "Lake Superior Estuarium",
    addressAliases: ["3 Marina Drive", "3 Marina Dr"],
    address: { street: "3 Marina Drive", city: "Superior", state: "WI", geo: { lat: 46.7221, lon: -92.063 }, inDuluth: false },
    provenance: { source: "osm", ref: "nominatim:Lake Superior Estuarium, Superior, WI" },
  },
  {
    id: "wussows-concert-cafe",
    name: "Wussow's Concert Cafe",
    addressAliases: ["324 N Central Ave", "324 North Central Avenue"],
    address: { street: "324 North Central Avenue", city: "Duluth", state: "MN", geo: { lat: 46.7386, lon: -92.1662 }, inDuluth: true },
    provenance: { source: "osm", ref: "nominatim:Wussow's Concert Cafe, Duluth, MN" },
  },
];
