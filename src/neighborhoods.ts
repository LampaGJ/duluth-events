import { readFileSync } from "node:fs";
import { NeighborhoodsArtifactSchema, type Neighborhood } from "./schema.js";

/**
 * @displayName Neighborhood Registry Loader
 * @strategicPurpose `data/duluth-neighborhoods.json` is a committed, offline snapshot of the City of
 *   Duluth's ArcGIS neighborhood-boundary layer (see `scripts/fetch-arcgis.mjs`). Same build-time,
 *   fail-fast discipline as `src/trails.ts` / `src/place-registry.ts`.
 * @tacticalObjective Read the artifact, Zod-parse it in full, and return the neighborhood list.
 */
export function loadNeighborhoods(path = "data/duluth-neighborhoods.json"): Neighborhood[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const parsed = NeighborhoodsArtifactSchema.parse(raw);
  return parsed.neighborhoods;
}

/** The shipped neighborhood list, validated at module load. */
export const NEIGHBORHOODS: Neighborhood[] = loadNeighborhoods();
