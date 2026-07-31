/**
 * Vendor COGGS' live TrailBot trail-conditions widgets into a COMMITTED artifact
 * (`data/trail-conditions.json`), joining the ArcGIS trails layer vendored by
 * `scripts/fetch-arcgis.mjs` (`data/duluth-trails.json`) with the condition-dependent dimension
 * that layer structurally cannot express: whether a trail is ACTUALLY open right now.
 *
 * Usage: npx tsx scripts/fetch-trailbot.mjs  (npm run trails:conditions)
 *
 * Run via tsx, not plain node — it imports TrailConditionSchema directly from src/schema.ts (a .ts
 * file) to Zod-validate every record before anything is written, per the task spec's stricter
 * "fail loudly, in the fetcher itself" requirement (scripts/fetch-arcgis.mjs, by contrast, defers
 * all validation to test/reference-data.test.ts against the committed artifact).
 *
 * THIS IS NOT A PUBLISHED API. COGGS (https://www.coggs.com/trail-conditions) embeds TrailBot
 * widgets via `<iframe src="https://trailbot.com/widgets/feed?keys=<uuid>[,<uuid>...]">` tags. The
 * widget is a Next.js SSR page; the data lives in the `__NEXT_DATA__` script tag's
 * `props.pageProps.trails[]`. Nothing about this shape is documented or versioned — it can change
 * without notice. See data/trail-conditions.SOURCE.md for the full defensive-parsing rationale and
 * the observed field shape.
 *
 * DISCOVERY: embed keys are scraped from the COGGS page's raw HTML (regex over iframe `src`
 * attributes), NOT hand-maintained here — a key added/removed on COGGS is picked up automatically
 * on the next fetch. Each discovered key is then fetched INDIVIDUALLY (not as one combined
 * `?keys=a,b,c` request), even though TrailBot supports batching, specifically so a single key's
 * failure is diagnosable on its own — a combined request that failed would implicate all N keys at
 * once with no way to tell which one actually broke.
 *
 * FAIL-FAST DISCIPLINE (per task spec):
 *   - A fetch failure (HTTP error after retries) for any key is a HARD, IMMEDIATE error naming
 *     that key. The run does not continue and nothing is written.
 *   - A structural failure — the `__NEXT_DATA__` script tag is absent, or
 *     `props.pageProps.trails` is missing from it — is also a HARD, IMMEDIATE error naming the key.
 *     This is the "the payload shape changed" signal and must not be silently swallowed.
 *   - Every record TrailBot does return is Zod-parsed against `TrailConditionSchema`; a record
 *     that fails to parse is a HARD, IMMEDIATE error naming the key and the Zod issue path. Bad
 *     records are never silently dropped from the written artifact.
 *   - A key returning a STRUCTURALLY VALID but EMPTY trails array (`trails: []`) is different from
 *     the above — it is a true fact about that trail system (e.g. temporarily deactivated), not a
 *     parsing failure. It is reported distinctly (a named warning list) and does NOT abort the run
 *     BY ITSELF. If, and only if, EVERY discovered key returns zero trails, the run still hard-fails
 *     — a conditions feed that quietly writes zero records is worse than one that errors, because
 *     downstream it silently reads as "all trails fine."
 *
 * IDEMPOTENT BY DESIGN — re-running against unchanged upstream data (i.e. two runs seconds apart,
 * with no new trail-maintainer update landing in between) must produce a byte-identical file:
 *   - records sorted by `embedKey` (a stable UUID; one key returned exactly one trail in every
 *     observed case, so `embedKey` doubles as `slug`'s sort-equivalent)
 *   - fixed, hand-ordered object keys, matching TrailConditionSchema's field order in
 *     src/schema.ts exactly (Zod rebuilds output in SCHEMA field order, not input order)
 *   - `raw` sub-object keys sorted alphabetically, independent of TrailBot's own field-return order
 *   - `keys` (the discovered embed-key list) sorted
 *   - NO wall-clock timestamp anywhere in the written file. `sourceWatermark` is the MAX
 *     `updatedAt` across all records — the source's own last-update time, which only moves when a
 *     trail maintainer actually posts an update.
 *
 * A human-readable fetch timestamp (if wanted) belongs in reports/ (gitignored), never in data/.
 *
 * UNLIKE the ArcGIS layers, this feed's underlying reality (trail conditions) changes constantly —
 * this artifact is a point-in-time snapshot, not an evergreen fact set. Re-fetch it whenever the
 * conditions data needs to be current; two runs seconds apart being byte-identical proves the
 * WRITER is deterministic, not that the data itself is static.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";
import { TrailConditionSchema } from "../src/schema.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COGGS_PAGE = "https://www.coggs.com/trail-conditions";
const WIDGET_BASE = "https://trailbot.com/widgets/feed";
const OUT_FILE = "data/trail-conditions.json";
const UA = "duluth-events/0.1 (github.com/LampaGJ/duluth-events)";
const ATTEMPTS = 3;

// --- normalization helpers -------------------------------------------------

/** New object, same values, keys sorted alphabetically — deterministic `raw` serialization
 *  regardless of the order TrailBot happens to return record fields in. */
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** An absent key and an explicit `null` are the same "no value" fact in this source (observed:
 *  `weatherPolicy` is simply OMITTED on records that don't have one, never present-as-null) — this
 *  collapses "missing" into "null" so every record can carry the same set of keys and the schema
 *  can express the absence as `.nullable()` instead of `.optional()`. */
function nullIfMissing(v) {
  return v === undefined ? null : v;
}

/** An empty/whitespace-only string is functionally the same "no value" as a JSON null in this
 *  source (observed on `street` and `url`, both on the same remote-trailhead record) — collapsed to
 *  null so those schema fields can enforce non-empty (`.min(1)` / `.url()`) without this source
 *  quirk breaking the parse. Same discipline as `scripts/fetch-arcgis.mjs`'s `nullIfEmpty`. */
function nullIfEmpty(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// --- fetch with retry --------------------------------------------------------

async function fetchText(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      console.log(`  [${label}] attempt ${attempt}/${ATTEMPTS} failed: ${String(err).slice(0, 160)}`);
      if (attempt < ATTEMPTS) await sleep(1000 * attempt);
    }
  }
  throw new Error(`fetch failed for ${label} (${url}) after ${ATTEMPTS} attempts: ${lastErr}`);
}

// --- key discovery -----------------------------------------------------------

/** Scrape every `trailbot.com/widgets/feed?keys=<uuid>[,<uuid>...]` iframe src from the COGGS page
 *  HTML and return the union of every embed key found, sorted. No JS execution needed — the iframe
 *  src attributes are present in the server-rendered HTML. */
function discoverKeys(html) {
  const keys = new Set();
  const re = /trailbot\.com\/widgets\/feed\?keys=([a-zA-Z0-9,-]+)/g;
  let m;
  while ((m = re.exec(html))) {
    for (const k of m[1].split(",")) {
      const trimmed = k.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return [...keys].sort();
}

// --- widget parse -------------------------------------------------------------

/** Extract `props.pageProps.trails` from a TrailBot widget page's `__NEXT_DATA__` payload. Throws
 *  a diagnostic naming `key` on any structural failure — this is the "the SSR shape changed"
 *  tripwire the task spec requires. */
function extractTrails(html, key) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`key ${key}: __NEXT_DATA__ script tag not found in widget response — TrailBot's SSR shape may have changed`);
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`key ${key}: __NEXT_DATA__ contents did not parse as JSON: ${err}`);
  }
  const trails = data?.props?.pageProps?.trails;
  if (trails === undefined) {
    throw new Error(`key ${key}: props.pageProps.trails is missing from __NEXT_DATA__ — TrailBot's payload shape may have changed`);
  }
  if (!Array.isArray(trails)) {
    throw new Error(`key ${key}: props.pageProps.trails is not an array (got ${typeof trails})`);
  }
  return trails;
}

// --- record builder (field order MUST match TrailConditionSchema in src/schema.ts) --------------

function buildRecord(t) {
  return {
    embedKey: t.embedKey,
    trailId: t.trailId,
    trailName: t.trailName,
    slug: t.slug,
    trailStatus: t.trailStatus,
    statusTags: t.statusTags,
    description: t.description,
    weatherPolicy: nullIfMissing(t.weatherPolicy),
    activity: t.activity,
    authority: t.authority,
    agency: t.agency,
    region: t.region,
    regions: t.regions,
    latitude: t.latitude,
    longitude: t.longitude,
    street: nullIfEmpty(t.street),
    city: t.city,
    state: t.state,
    zipcode: t.zipcode,
    timezone: t.timezone,
    last24Precip: t.last24Precip,
    last24PrecipType: t.last24PrecipType,
    updatedAt: t.updatedAt,
    remindedAt: t.remindedAt,
    sourceDescription: t.sourceDescription,
    url: nullIfEmpty(t.url),
    socials: sortKeys(t.socials ?? {}),
    organization: { name: t.organization?.name, slug: t.organization?.slug },
    raw: sortKeys(t),
  };
}

// --- main ---------------------------------------------------------------------

async function main() {
  mkdirSync("data", { recursive: true });
  const p = progress("fetch-trailbot", { total: null, everyMs: 2000 });

  console.log(`discovering embed keys from ${COGGS_PAGE} ...`);
  const pageHtml = await fetchText(COGGS_PAGE, "coggs-page");
  const keys = discoverKeys(pageHtml);
  if (keys.length === 0) throw new Error(`discovered ZERO embed keys on ${COGGS_PAGE} — page structure may have changed`);
  console.log(`discovered ${keys.length} embed key(s): ${keys.join(", ")}`);

  const records = [];
  const zeroTrailKeys = [];
  let done = 0;
  for (const key of keys) {
    const widgetUrl = `${WIDGET_BASE}?keys=${key}`;
    const html = await fetchText(widgetUrl, key);
    const trails = extractTrails(html, key);
    if (trails.length === 0) {
      zeroTrailKeys.push(key);
    } else {
      for (const t of trails) records.push(buildRecord(t));
    }
    done += 1;
    p.tick(done, { phase: `key ${key} -> ${trails.length} trail(s)` });
  }

  if (zeroTrailKeys.length > 0) {
    console.log(`WARNING: ${zeroTrailKeys.length}/${keys.length} key(s) returned zero trails (reported distinctly from a fetch failure): ${zeroTrailKeys.join(", ")}`);
  }
  if (records.length === 0) {
    throw new Error(`ALL ${keys.length} discovered key(s) returned zero trails — refusing to write an empty conditions artifact (would silently read downstream as "all trails fine")`);
  }

  // Zod-validate every record before writing anything — one bad record fails the whole run. This
  // is a hard requirement of the task spec (unlike scripts/fetch-arcgis.mjs, which defers all
  // validation to test/reference-data.test.ts against the committed file): an undocumented SSR
  // payload must never silently write a shape Zod would have rejected.
  records.forEach((r, i) => {
    const res = TrailConditionSchema.safeParse(r);
    if (!res.success) {
      throw new Error(`record ${i} (embedKey ${r.embedKey}) failed schema validation: ${JSON.stringify(res.error.issues)}`);
    }
  });

  records.sort((a, b) => (a.embedKey < b.embedKey ? -1 : a.embedKey > b.embedKey ? 1 : 0));

  const dupes = records.length - new Set(records.map((r) => r.embedKey)).size;
  if (dupes > 0) throw new Error(`${dupes} duplicate embedKey(s) after collection`);

  const maxUpdated = Math.max(...records.map((r) => r.updatedAt));
  const envelope = {
    source: WIDGET_BASE,
    discoverySource: COGGS_PAGE,
    keys,
    sourceWatermark: new Date(maxUpdated).toISOString(),
    recordCount: records.length,
    trailConditions: records,
  };

  const text = JSON.stringify(envelope, null, 2) + "\n";
  const before = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : null;
  writeFileSync(OUT_FILE, text);
  const changed = before !== text;
  console.log(`wrote ${OUT_FILE} — ${records.length} record(s), watermark ${envelope.sourceWatermark}${changed ? "" : " (unchanged)"}`);

  p.done({ phase: "done", records: records.length, zeroTrailKeys: zeroTrailKeys.length });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
