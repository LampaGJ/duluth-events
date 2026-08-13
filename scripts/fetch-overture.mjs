/**
 * Vendor Overture Maps' `places` theme for the Duluth bbox into a COMMITTED reference artifact
 * (`data/overture-places.json`), so this data is available offline and version-controlled rather
 * than re-queried live against S3 on every build. Peer of `scripts/fetch-arcgis.mjs` and
 * `scripts/fetch-trailbot.mjs` — same idempotency contract, same fail-fast Zod validation before
 * anything is written (the TrailBot fetcher's stricter discipline, since this is also an
 * externally-controlled schema we do not own).
 *
 * Usage: npx tsx scripts/fetch-overture.mjs   (npm run places:overture)
 *
 * Requires the `duckdb` CLI on PATH (`brew install duckdb`) with the `spatial` and `httpfs`
 * extensions — both self-install on first LOAD, no separate `INSTALL` step needed once cached.
 * Queries Overture's public `overturemaps-us-west-2` S3 bucket directly; anonymous/public read, no
 * credentials required.
 *
 * PINNED RELEASE — `RELEASE_VERSION` below is a hardcoded string, not "latest". Overture ships a new
 * release roughly twice a month; querying "whatever's newest" would make this fetcher's output drift
 * out from under us on a schedule we don't control, and would break the idempotency contract (two
 * runs on either side of a release boundary would legitimately differ). Bump `RELEASE_VERSION`
 * deliberately, in its own commit, when picking up a newer release.
 *
 * FILTER — see data/overture-places.SOURCE.md for the full justification. Short version: of 7,693
 * places in the bbox, 7,495 (97.4%) carry a non-null `addresses[1]`; the other 198 are dropped. An
 * addressless point cannot be used as either a name-token match candidate with a real address to
 * enrich onto a hit, or as an address-alias candidate — it is Overture's least useful record shape
 * for this registry's purposes, so it is filtered at vendor time rather than carried dead-weight into
 * every future consumer of this file.
 *
 * IDEMPOTENT BY DESIGN — re-running against the SAME pinned release must produce a byte-identical
 * file (zero git diff):
 *   - records sorted by `gersId` (a stable UUID) — enforced BOTH in the SQL (`ORDER BY`) and again in
 *     JS, so a future SQL edit that drops the ORDER BY cannot silently reintroduce nondeterminism
 *   - fixed, hand-ordered object keys, matching `OverturePlaceSchema`'s field order in
 *     `src/overture.ts` exactly (Zod rebuilds parse output in SCHEMA field order, not input order —
 *     see the comment there)
 *   - every array field (`alternateNames`, `categories.alternate`, `sourceDatasets`) sorted, both in
 *     SQL (`list_sort`/`list_distinct`) and defensively again in JS
 *   - NO wall-clock timestamp anywhere in the written file. `sourceWatermark` is the pinned Overture
 *     RELEASE VERSION — the source's own version stamp, which only moves when we deliberately bump
 *     `RELEASE_VERSION` above, not on every re-run.
 *
 * A human-readable fetch timestamp (if wanted) belongs in reports/ (gitignored), never in data/.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";
import { OverturePlacesArtifactSchema } from "../src/overture.js";

const RELEASE_VERSION = "2026-07-22.0";
const BBOX = { minLon: -92.35, maxLon: -91.9, minLat: 46.6, maxLat: 46.95 };
const OUT_FILE = "data/overture-places.json";
const ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Field order here is deliberate SELECT-clause shaping, not just a convenience projection: DuckDB's
// `-json` output preserves struct/column order, and JSON.parse preserves string-key insertion order,
// so shaping the exact desired record shape in SQL means the JS side only needs to re-verify it
// (defensively) rather than rebuild it. Every array is pre-sorted/deduped in SQL for the same reason.
const SQL = `
SET lambda_syntax='ENABLE_SINGLE_ARROW';
LOAD spatial; LOAD httpfs; SET s3_region='us-west-2';
WITH base AS (
  SELECT
    id AS gers_id,
    names.primary AS name,
    CASE WHEN names.common IS NULL THEN []
         ELSE list_sort(list_distinct(map_values(names.common))) END AS alternate_names,
    categories.primary AS category_primary,
    list_sort(coalesce(categories.alternate, [])) AS category_alternate,
    confidence,
    addresses[1].freeform AS addr_freeform,
    addresses[1].locality AS addr_locality,
    addresses[1].postcode AS addr_postcode,
    addresses[1].region AS addr_region,
    addresses[1].country AS addr_country,
    ST_Y(geometry) AS lat,
    ST_X(geometry) AS lon,
    operating_status,
    list_sort(list_distinct(list_transform(sources, s -> s.dataset))) AS source_datasets
  FROM read_parquet('s3://overturemaps-us-west-2/release/${RELEASE_VERSION}/theme=places/type=place/*',
                    filename=false, hive_partitioning=1)
  WHERE bbox.xmin BETWEEN ${BBOX.minLon} AND ${BBOX.maxLon}
    AND bbox.ymin BETWEEN ${BBOX.minLat} AND ${BBOX.maxLat}
)
SELECT * FROM base ORDER BY gers_id;
`;

/** Run the DuckDB CLI as a subprocess (no `duckdb` npm binding is in this project's dependency set —
 *  see the CLAUDE.md dependency-selection rule; shelling out to the official CLI is the documented,
 *  zero-new-dependency path). Emits a heartbeat while the single blocking S3 scan+filter query runs —
 *  DuckDB gives no mid-query row callback here, so this is elapsed-time heartbeat, not a done/total
 *  count; that's still real pollable progress per project rule, not a log-soup `\r` bar. */
async function runDuckDb(sql, p) {
  return new Promise((resolve, reject) => {
    const child = spawn("duckdb", ["-json", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const heartbeat = setInterval(() => p.tick(0, { phase: "querying S3 (single blocking scan)" }), 3000);
    child.on("error", (e) => {
      clearInterval(heartbeat);
      reject(e);
    });
    child.on("close", (code) => {
      clearInterval(heartbeat);
      if (code !== 0) reject(new Error(`duckdb exited ${code}: ${err.slice(0, 2000)}`));
      else resolve(out);
    });
  });
}

async function queryWithRetry(p) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await runDuckDb(SQL, p);
    } catch (err) {
      lastErr = err;
      console.log(`  attempt ${attempt}/${ATTEMPTS} failed: ${String(err).slice(0, 200)}`);
      if (attempt < ATTEMPTS) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

function buildRecord(row) {
  return {
    gersId: row.gers_id,
    name: row.name,
    alternateNames: [...(row.alternate_names ?? [])].sort(),
    categories: {
      primary: row.category_primary ?? null,
      alternate: [...(row.category_alternate ?? [])].sort(),
    },
    confidence: row.confidence,
    address: {
      freeform: row.addr_freeform,
      locality: row.addr_locality ?? null,
      postcode: row.addr_postcode ?? null,
      region: row.addr_region ?? null,
      country: row.addr_country ?? null,
    },
    lat: row.lat,
    lon: row.lon,
    operatingStatus: row.operating_status ?? null,
    sourceDatasets: [...(row.source_datasets ?? [])].sort(),
  };
}

async function main() {
  mkdirSync("data", { recursive: true });
  const p = progress("fetch-overture", { total: null, everyMs: 3000 });

  console.log(`querying Overture release ${RELEASE_VERSION}, bbox ${JSON.stringify(BBOX)} ...`);
  const stdout = await queryWithRetry(p);
  const rows = JSON.parse(stdout);
  console.log(`bbox query returned ${rows.length} places (pre-filter)`);

  const preFilterCount = rows.length;
  const addressed = rows.filter((r) => r.addr_freeform != null && String(r.addr_freeform).trim() !== "");
  const droppedCount = preFilterCount - addressed.length;
  p.tick(addressed.length, { phase: "shaping records", preFilterCount, droppedCount });

  const records = addressed.map(buildRecord);
  records.sort((a, b) => (a.gersId < b.gersId ? -1 : a.gersId > b.gersId ? 1 : 0));

  const dupes = records.length - new Set(records.map((r) => r.gersId)).size;
  if (dupes > 0) throw new Error(`${dupes} duplicate gersId(s) after collection`);

  const envelope = {
    source: `s3://overturemaps-us-west-2/release/${RELEASE_VERSION}/theme=places/type=place/`,
    releaseVersion: RELEASE_VERSION,
    sourceWatermark: RELEASE_VERSION,
    bbox: BBOX,
    preFilterCount,
    filter: `addresses[1] IS NOT NULL (dropped ${droppedCount}/${preFilterCount} addressless points — see data/overture-places.SOURCE.md)`,
    recordCount: records.length,
    places: records,
  };

  // Fail-fast Zod validation BEFORE anything is written — same stricter discipline as
  // scripts/fetch-trailbot.mjs (this is also an externally-controlled, undocumented-to-us schema
  // shape, unlike fetch-arcgis.mjs's stable documented FeatureServer contract).
  const check = OverturePlacesArtifactSchema.safeParse(envelope);
  if (!check.success) {
    throw new Error(`built envelope failed schema validation: ${JSON.stringify(check.error.issues).slice(0, 4000)}`);
  }

  const text = JSON.stringify(envelope, null, 2) + "\n";
  const before = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : null;
  writeFileSync(OUT_FILE, text);
  const changed = before !== text;
  console.log(
    `wrote ${OUT_FILE} — ${records.length} record(s) (${droppedCount} addressless dropped), watermark ${RELEASE_VERSION}${changed ? "" : " (unchanged)"}`,
  );

  p.done({ phase: "done", records: records.length, preFilterCount, droppedCount });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
