import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Overture Maps `places` theme, vendored for the Duluth bbox — see `scripts/fetch-overture.mjs` and
 * `data/overture-places.SOURCE.md`.
 *
 * @displayName Overture Places Loader
 * @strategicPurpose Overture's GERS id (a stable, cross-dataset UUID — see
 *   https://docs.overturemaps.org/gers/) is a join key candidate for `Place.gersId`
 *   (`src/schema.ts`), and its machine-aggregated address/category data measurably beats our other
 *   free geocoding tiers on cases probed live (Bent Paddle's street address; the Duluth Public
 *   Library branch ambiguity — see the task report). It is NOT a drop-in replacement for either the
 *   hand-curated Homegrown registry or event classification: only 27/77 of our registered venues
 *   matched Overture by exact name in the same probe.
 * @tacticalObjective Hold a SEPARATE schema from `PlaceSchema` (deliberately NOT added to
 *   `src/schema.ts` — that file's edit surface for this task is scoped to the additive `gersId`
 *   field only) so this vendored artifact can be Zod-validated and idempotency-tested exactly like
 *   `TrailsArtifactSchema`/`NeighborhoodsArtifactSchema`/`TrailConditionsArtifactSchema` are, without
 *   touching the frozen file.
 *
 * Field order below is the WRITE order `scripts/fetch-overture.mjs` uses — Zod rebuilds parsed
 * output in schema field-declaration order, not input order, so the two must stay in lockstep for
 * the idempotency round-trip (`parse` -> `JSON.stringify` reproduces the committed file byte-for-byte)
 * to hold. See the matching comment on `TrailSchema` in `src/schema.ts` for the same discipline.
 */
export const OvertureAddressSchema = z.object({
  freeform: z.string().min(1),
  locality: z.string().nullable(),
  postcode: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
});
export type OvertureAddress = z.infer<typeof OvertureAddressSchema>;

export const OvertureCategoriesSchema = z.object({
  primary: z.string().nullable(),
  alternate: z.array(z.string()).default([]),
});
export type OvertureCategories = z.infer<typeof OvertureCategoriesSchema>;

export const OverturePlaceSchema = z.object({
  /** GERS id — a stable UUID, Overture's own cross-theme/cross-dataset join key. Sort/primary key
   *  for this artifact, exactly as `globalId`/`embedKey` are for the ArcGIS/TrailBot artifacts. */
  gersId: z.string().min(1),
  name: z.string().min(1),
  /** Distinct values pulled from the source's `names.common` map (language-keyed alternate names).
   *  Empty for every record observed in the Duluth bbox on the 2026-07-22.0 release — kept as a
   *  first-class field, not omitted, because the task spec asks for it "if present" and a future
   *  release populating it must not require a schema change. */
  alternateNames: z.array(z.string()).default([]),
  categories: OvertureCategoriesSchema,
  /** Overture's own [0,1] place-confidence score (source: `/properties/confidence`, dataset
   *  "Overture" in the raw `sources` array) — NOT a match score against our registry; that scoring
   *  still happens entirely in `scripts/places-propose.mjs`, same as every other tier. */
  confidence: z.number().min(0).max(1),
  /** Present on every vendored record by construction — see the SOURCE.md filter note: an
   *  addressless point is dropped before it ever reaches this artifact. */
  address: OvertureAddressSchema,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Observed values: "open" | "permanently_closed" | null. Left as a plain nullable string rather
   *  than an enum — this is externally controlled vocabulary (Overture-signals, not us), and a
   *  future release adding a value (e.g. "closed_temporarily") must not hard-fail the fetcher. */
  operatingStatus: z.string().nullable(),
  /** Distinct `sources[].dataset` values contributing to this record (e.g. "Microsoft", "meta",
   *  "Foursquare", "Overture", "Overture-signals"), sorted. The raw `sources` array itself is NOT
   *  vendored — a single record can carry dozens of near-duplicate `operating_status` signal entries
   *  differing only by timestamp, which would bloat this artifact for no matching value; see
   *  SOURCE.md. */
  sourceDatasets: z.array(z.string()).min(1),
});
export type OverturePlace = z.infer<typeof OverturePlaceSchema>;

export const OverturePlacesArtifactSchema = z
  .object({
    source: z.string().min(1),
    /** Overture's own release version (e.g. "2026-07-22.0") — the source's own change watermark.
     *  Deliberately NOT a fetch timestamp; re-running the fetcher against the SAME pinned release
     *  must reproduce the committed file byte-for-byte (see `scripts/fetch-overture.mjs`). */
    releaseVersion: z.string().min(1),
    sourceWatermark: z.string().min(1),
    bbox: z.object({
      minLon: z.number(),
      maxLon: z.number(),
      minLat: z.number(),
      maxLat: z.number(),
    }),
    /** Row count returned by the bbox query BEFORE the addressless-point filter (see SOURCE.md). */
    preFilterCount: z.number().int().positive(),
    filter: z.string().min(1),
    recordCount: z.number().int().nonnegative(),
    places: z.array(OverturePlaceSchema),
  })
  .refine((v) => v.recordCount === v.places.length, { error: "recordCount must equal places.length" });
export type OverturePlacesArtifact = z.infer<typeof OverturePlacesArtifactSchema>;

/**
 * @tacticalObjective Read the artifact, Zod-parse it in full (one bad record throws with a path
 *   pinpointing the offending array index/field), and return the place list — same fail-fast
 *   discipline as `loadTrails`/`loadNeighborhoods`/`loadTrailConditions` in their own modules.
 *
 * Deliberately NOT eagerly loaded into a module-scope constant (unlike `TRAILS`/`NEIGHBORHOODS`):
 * nothing in the live build pipeline (`src/build.ts`, `src/cli.ts`, `src/server.ts`) consumes
 * Overture data today — only `scripts/places-propose.mjs` (its own tier) and this task's tests do —
 * so paying the parse/validate cost of 7,495 records at every module import of this file, including
 * ones that never touch Overture, would be pure overhead.
 */
export function loadOverturePlaces(path = "data/overture-places.json"): OverturePlace[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const parsed = OverturePlacesArtifactSchema.parse(raw);
  return parsed.places;
}
