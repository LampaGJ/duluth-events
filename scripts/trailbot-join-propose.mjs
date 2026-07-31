/**
 * PROPOSE what a join between TrailBot trail conditions (data/trail-conditions.json) and the
 * vendored ArcGIS trails layer (data/duluth-trails.json) would look like. PRINTS ONLY — never
 * writes src/, never writes a join table anywhere. The human decides; this just does the exact-
 * match legwork so the decision is informed.
 *
 * Deliberately NOT a fuzzy join (no edit distance, no token-set scoring, no alias table) — per the
 * task spec. Two match levels only, both mechanical and inspectable:
 *   1. WHOLE-STRING exact match: normalize(trailName) === normalize(ArcGIS Name or Park).
 *   2. SEGMENT exact match: TrailBot's OWN compound-name delimiter is "/" (e.g.
 *      "Piedmont/Brewer/Enger/Keene" names four systems in one widget) — split on it and exact-
 *      match each segment. This is not an invented heuristic; it's using TrailBot's own naming
 *      convention as the only segmentation rule.
 * Normalization: lowercase, "/" and "-" -> space, whitespace-collapsed. No stemming, no fuzzy
 * scoring, no abbreviation table.
 *
 * Usage: npx tsx scripts/trailbot-join-propose.mjs
 */
import { readFileSync } from "node:fs";
import { TrailsArtifactSchema, TrailConditionsArtifactSchema } from "../src/schema.js";

const trailsRaw = JSON.parse(readFileSync("data/duluth-trails.json", "utf8"));
const trails = TrailsArtifactSchema.parse(trailsRaw).trails;

const conditionsRaw = JSON.parse(readFileSync("data/trail-conditions.json", "utf8"));
const conditions = TrailConditionsArtifactSchema.parse(conditionsRaw).trailConditions;

function norm(s) {
  return s
    .toLowerCase()
    .replace(/[/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// normalized ArcGIS Name/Park -> Set of original spellings (source has known typo variants, e.g.
// "Magney-Snively" / "Magney-Snivley" / "Magney/Snively" — all three normalize to the same key,
// which is itself informative: a normalized-exact join would silently absorb typo variants too).
const nameIndex = new Map();
const parkIndex = new Map();
for (const t of trails) {
  if (t.name) {
    const k = norm(t.name);
    if (!nameIndex.has(k)) nameIndex.set(k, new Set());
    nameIndex.get(k).add(t.name);
  }
  if (t.park) {
    const k = norm(t.park);
    if (!parkIndex.has(k)) parkIndex.set(k, new Set());
    parkIndex.get(k).add(t.park);
  }
}

function lookup(raw) {
  const k = norm(raw);
  const name = nameIndex.get(k);
  const park = parkIndex.get(k);
  if (!name && !park) return null;
  return { name: name ? [...name] : [], park: park ? [...park] : [] };
}

let wholeMatches = 0;
let segmentOnlyMatches = 0;
let noMatches = 0;

console.log(`TrailBot trail-conditions <-> ArcGIS trails layer join proposal (exact-match only, human review required)`);
console.log(`${conditions.length} TrailBot record(s) vs ${trails.length} ArcGIS record(s) (${nameIndex.size} distinct Name, ${parkIndex.size} distinct Park)\n`);

for (const c of conditions) {
  console.log(`--- ${c.trailName}  (embedKey ${c.embedKey}, slug ${c.slug})`);
  const whole = lookup(c.trailName);
  if (whole) {
    wholeMatches++;
    if (whole.name.length) console.log(`  WHOLE-STRING exact match -> ArcGIS Name: ${whole.name.join(", ")}`);
    if (whole.park.length) console.log(`  WHOLE-STRING exact match -> ArcGIS Park: ${whole.park.join(", ")}`);
    continue;
  }

  const segments = c.trailName.split("/").map((s) => s.trim());
  let anySegmentMatch = false;
  for (const seg of segments) {
    const hit = lookup(seg);
    if (hit) {
      anySegmentMatch = true;
      const via = [hit.name.length ? `Name: ${hit.name.join(", ")}` : null, hit.park.length ? `Park: ${hit.park.join(", ")}` : null].filter(Boolean).join(" | ");
      console.log(`  segment "${seg}" exact match -> ${via}`);
    } else {
      console.log(`  segment "${seg}": no exact match`);
    }
  }
  if (anySegmentMatch) segmentOnlyMatches++;
  else noMatches++;
}

console.log(`\n=== Summary ===`);
console.log(`WHOLE-STRING exact matches:        ${wholeMatches}/${conditions.length}`);
console.log(`At-least-one-SEGMENT exact match:  ${segmentOnlyMatches}/${conditions.length}`);
console.log(`Zero matches at any level:          ${noMatches}/${conditions.length}`);
console.log(`\nNo join is written anywhere by this script. A human should decide, per record above,`);
console.log(`whether a segment match (or a near-miss like "Spirit Mountain" vs ArcGIS's "Spirit`);
console.log(`Mountain"/"Spirt Mountain" typo variants) is close enough to hand-wire into a future`);
console.log(`join table — and note that 4 of the 9 TrailBot trail systems are OUTSIDE Duluth city`);
console.log(`limits entirely (Superior WI x2, Cloquet, Lake County), so a "no match" for those is`);
console.log(`the CORRECT outcome, not a join failure.`);
