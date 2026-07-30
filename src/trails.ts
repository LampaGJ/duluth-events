import { readFileSync } from "node:fs";
import { TrailsArtifactSchema, type Trail } from "./schema.js";

/**
 * @displayName Trail Registry Loader
 * @strategicPurpose `data/duluth-trails.json` is a committed, offline snapshot of the City of
 *   Duluth's ArcGIS trails layer (see `scripts/fetch-arcgis.mjs`). It is a build-time asset exactly
 *   like `src/places.ts`'s curated registry, so a malformed record must fail the build rather than
 *   reach a consumer — this mirrors the fail-fast discipline in `src/place-registry.ts`.
 * @tacticalObjective Read the artifact, Zod-parse it in full (one bad record throws with a path
 *   pinpointing the offending array index/field), and return the trail list.
 */
export function loadTrails(path = "data/duluth-trails.json"): Trail[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const parsed = TrailsArtifactSchema.parse(raw);
  return parsed.trails;
}

/** The shipped trail list, validated at module load — a bad artifact throws before any consumer runs. */
export const TRAILS: Trail[] = loadTrails();
