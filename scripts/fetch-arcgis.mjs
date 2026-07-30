/**
 * Vendor the City of Duluth's ArcGIS reference layers (Trails, Neighborhoods) into COMMITTED
 * artifacts, so this data is available offline and version-controlled rather than re-fetched live
 * on every build. Usage: node scripts/fetch-arcgis.mjs
 *
 * IDEMPOTENT BY DESIGN — re-running against unchanged upstream data must produce a byte-identical
 * file (zero git diff). That means, deliberately:
 *   - records sorted by their normalized `id` (a stable UUID) before writing
 *   - fixed, hand-ordered object keys (matching TrailSchema/NeighborhoodSchema field order in
 *     src/schema.ts exactly — see the comment above those schemas)
 *   - `raw` sub-object keys sorted alphabetically, independent of whatever order ArcGIS returns them in
 *   - NO wall-clock timestamp anywhere in the written file. `sourceWatermark` is the MAX
 *     `last_edited_date` across all records — the source's own change watermark, which only moves
 *     when the City actually edits a record. A `Date.now()` fetchedAt would dirty this file on every
 *     re-run even with zero upstream change; that trap is why watermark != fetch time.
 *
 * A human-readable fetch timestamp (if wanted) belongs in reports/ (gitignored), never in data/.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAYERS = [
  {
    key: "trails",
    layerId: 14,
    queryUrl: "https://utility.arcgis.com/usrsvcs/servers/085f4309eec943a8998e801f7849b1b8/rest/services/Parks/TrailsDuluthService/MapServer/14/query",
    outFile: "data/duluth-trails.json",
    recordsKey: "trails",
    build: buildTrail,
  },
  {
    key: "neighborhoods",
    layerId: 0,
    queryUrl: "https://services.arcgis.com/DgKyOSWnVuXUe0Jp/arcgis/rest/services/Neighborhoods_Duluth/FeatureServer/0/query",
    outFile: "data/duluth-neighborhoods.json",
    recordsKey: "neighborhoods",
    build: buildNeighborhood,
  },
];

const PAGE_SIZE = 1000; // matches the layers' own maxRecordCount
const ATTEMPTS = 3;

// --- normalization helpers -------------------------------------------------

/** `{D6440883-105D-409C-BB93-01E55FE7D52C}` (Trails) or `6be8a353-...` (Neighborhoods) -> one
 *  consistent lowercase-no-braces form, so both entity kinds key and sort alike. */
function normalizeGlobalId(raw) {
  return String(raw).replace(/[{}]/g, "").toLowerCase();
}

function isoFromEpochMs(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/** Y/Yes -> true; N/No/null/anything else -> false. Raw string always survives in `raw`. */
function toBool(v) {
  return v === "Y" || v === "Yes";
}

/** The source's literal string "None" is a null in disguise; every other value passes through. */
function normalizePartner(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "None" ? null : s;
}

/** An empty/whitespace-only string is functionally the same "no value" as a JSON null in this
 *  source (observed on `Name` and `Park`, 1 and 6 records respectively) — collapsed to null so
 *  every nullable string field in the schema can enforce non-empty (`.min(1)`) without a source
 *  data quirk breaking the parse. */
function nullIfEmpty(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** New object, same values, keys sorted alphabetically — for deterministic `raw` serialization
 *  regardless of the order ArcGIS happens to return `attributes` fields in. */
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// --- per-layer record builders (field order MUST match src/schema.ts) ------

function buildTrail(attrs) {
  const globalId = attrs.GlobalID;
  return {
    id: normalizeGlobalId(globalId),
    globalId,
    objectId: attrs.OBJECTID,
    name: nullIfEmpty(attrs.Name),
    park: nullIfEmpty(attrs.Park),
    jurisdiction: nullIfEmpty(attrs.Jurisdiction),
    type: nullIfEmpty(attrs.Type),
    status: nullIfEmpty(attrs.Status),
    season: attrs.Season === "Summer" ? "summer" : attrs.Season === "Winter" ? "winter" : "both",
    surface: nullIfEmpty(attrs.Suface),
    rating: attrs.Rating ?? null,
    uses: [
      { activity: "hiking", permitted: toBool(attrs.Hiking) },
      { activity: "mountainBiking", permitted: toBool(attrs.MountainBiking) },
      { activity: "xcSkiing", permitted: toBool(attrs.XCountrySkiing) },
      { activity: "snowmobile", permitted: toBool(attrs.Snowmobile) },
      { activity: "accessible", permitted: toBool(attrs.Accessible) },
      { activity: "horseback", permitted: toBool(attrs.Horseback) },
      { activity: "atv", permitted: toBool(attrs.ATV) },
      { activity: "adaptive", permitted: toBool(attrs.Adaptive) },
    ],
    partnerOrganization: normalizePartner(attrs.PartnerOrganization),
    mileage: attrs.Mileage ?? null,
    shapeLength: attrs["SHAPE.STLength()"] ?? null,
    dateOpen: isoFromEpochMs(attrs.Date_Open),
    constructionYear: attrs.ConstructionYear ?? null,
    lastEditedDate: isoFromEpochMs(attrs.last_edited_date),
    raw: sortKeys(attrs),
  };
}

function buildNeighborhood(attrs) {
  const globalId = attrs.GlobalID;
  return {
    id: normalizeGlobalId(globalId),
    globalId,
    objectId: attrs.OBJECTID,
    adminId: attrs.ID,
    name: attrs.NAME,
    shapeArea: attrs.Shape__Area ?? null,
    shapeLength: attrs.Shape__Length ?? null,
    lastEditedDate: isoFromEpochMs(attrs.last_edited_date),
    raw: sortKeys(attrs),
  };
}

// --- fetch ------------------------------------------------------------------

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`ArcGIS error: ${JSON.stringify(json.error)}`);
      return json;
    } catch (err) {
      lastErr = err;
      console.log(`  attempt ${attempt}/${ATTEMPTS} failed: ${String(err).slice(0, 120)}`);
      if (attempt < ATTEMPTS) await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

/** Paginate via resultOffset until exceededTransferLimit is falsy. Do NOT assume one page — the
 *  Trails layer's maxRecordCount is 1000 and has been observed to exceed it. */
async function fetchAllAttributes(queryUrl, label, p, tickBase) {
  let offset = 0;
  const all = [];
  for (;;) {
    const url = `${queryUrl}?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=${PAGE_SIZE}&resultOffset=${offset}&f=json`;
    const json = await fetchJson(url);
    const features = json.features ?? [];
    for (const f of features) all.push(f.attributes);
    p.tick(tickBase + all.length, { phase: `${label} offset=${offset} got=${features.length}` });
    if (!json.exceededTransferLimit || features.length === 0) break;
    offset += features.length;
  }
  return all;
}

async function main() {
  mkdirSync("data", { recursive: true });
  const p = progress("fetch-arcgis", { total: null, everyMs: 2000 });
  let tickBase = 0;

  for (const layer of LAYERS) {
    console.log(`fetching ${layer.key} (layer ${layer.layerId}) ...`);
    const attrs = await fetchAllAttributes(layer.queryUrl, layer.key, p, tickBase);
    tickBase += attrs.length;

    const records = attrs.map(layer.build);
    records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const dupes = records.length - new Set(records.map((r) => r.id)).size;
    if (dupes > 0) throw new Error(`${layer.key}: ${dupes} duplicate GlobalID(s) after normalization`);

    const maxEdited = Math.max(...attrs.map((a) => a.last_edited_date).filter((v) => typeof v === "number"));
    const envelope = {
      source: layer.queryUrl,
      layerId: layer.layerId,
      sourceWatermark: isoFromEpochMs(maxEdited),
      recordCount: records.length,
      [layer.recordsKey]: records,
    };

    const text = JSON.stringify(envelope, null, 2) + "\n";
    const before = existsSync(layer.outFile) ? readFileSync(layer.outFile, "utf8") : null;
    writeFileSync(layer.outFile, text);
    const changed = before !== text;
    console.log(`wrote ${layer.outFile} — ${records.length} records, watermark ${envelope.sourceWatermark}${changed ? "" : " (unchanged)"}`);
  }

  p.done({ phase: "done" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
