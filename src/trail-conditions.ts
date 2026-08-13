import { readFileSync } from "node:fs";
import { TrailConditionsArtifactSchema, type TrailCondition } from "./schema.js";

/**
 * @displayName Trail Conditions Loader
 * @strategicPurpose `data/trail-conditions.json` is a committed snapshot of COGGS' live
 *   trail-conditions widgets (TrailBot, see `scripts/fetch-trailbot.mjs`) — an undocumented SSR
 *   payload, not a published API. It is a build-time asset exactly like `src/trails.ts`'s ArcGIS
 *   snapshot, so a malformed record must fail the build rather than reach a consumer, and a shape
 *   break upstream is caught here rather than surfacing as silently-missing trail conditions.
 * @tacticalObjective Read the artifact, Zod-parse it in full (one bad record throws with a path
 *   pinpointing the offending array index/field), and return the trail-condition list.
 */
export function loadTrailConditions(path = "data/trail-conditions.json"): TrailCondition[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const parsed = TrailConditionsArtifactSchema.parse(raw);
  return parsed.trailConditions;
}

/** The shipped trail-conditions list, validated at module load — a bad artifact throws before any
 *  consumer runs. */
export const TRAIL_CONDITIONS: TrailCondition[] = loadTrailConditions();
