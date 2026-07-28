/**
 * Bulk-fetch named Duluth-area venues from OpenStreetMap into a COMMITTED cache, so seeding is
 * reproducible offline and does not re-hit the API. Re-run only when refreshing the cache.
 * Usage: node scripts/fetch-osm.mjs
 *
 * Mirrors are observed flaky under load (429s, 504s, and multi-minute hangs with no response at
 * all) — each mirror gets a couple of retries with backoff before falling through to the next,
 * and progress is emitted per attempt so a background run is pollable instead of silent.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = `[out:json][timeout:90];
(
  nwr["name"]["amenity"~"^(bar|pub|cafe|theatre|arts_centre|community_centre|library|nightclub|events_venue|restaurant|casino|college|university|place_of_worship)$"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["tourism"~"^(museum|attraction|gallery|hotel)$"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["leisure"~"^(park|sports_centre|stadium|ice_rink|marina|nature_reserve)$"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["craft"="brewery"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["microbrewery"="yes"](46.60,-92.35,46.90,-91.95);
);
out center tags;`;

// overpass-api.de 504s under load; kumi is the reliable mirror — try it first, fall back in order.
const MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const UA = "duluth-events/0.1 (github.com/LampaGJ/duluth-events)";

const ATTEMPTS_PER_MIRROR = 2;
const p = progress("fetch-osm", { total: MIRRORS.length * ATTEMPTS_PER_MIRROR, everyN: 1 });
let attemptsDone = 0;

let data = null;
outer: for (const m of MIRRORS) {
  for (let attempt = 1; attempt <= ATTEMPTS_PER_MIRROR; attempt++) {
    console.log(`trying ${m} (attempt ${attempt}/${ATTEMPTS_PER_MIRROR})`);
    p.tick(++attemptsDone, { phase: `POST ${m}` });
    try {
      // Match the query's own [timeout:90] budget, plus slack for transport — a hung socket must
      // not block forever on a script with no other liveness signal.
      // Both an explicit Accept and a real User-Agent are required: overpass-api.de's Apache front
      // end 406s undici's default (Accept-less) request via mod_negotiation, and a missing UA is a
      // separate 403/429 risk on public Overpass mirrors.
      const res = await fetch(m, {
        method: "POST",
        body: QUERY,
        headers: { "Content-Type": "text/plain", Accept: "*/*", "User-Agent": UA },
        signal: AbortSignal.timeout(100_000),
      });
      if (!res.ok) {
        console.log(`  HTTP ${res.status}`);
        if (res.status === 429) await sleep(5000 * attempt); // rate-limited: back off before retrying
        continue;
      }
      data = await res.json();
      break outer;
    } catch (err) {
      console.log(`  ${String(err).slice(0, 80)}`);
    }
  }
}
if (!data) {
  p.done({ phase: "failed" });
  console.error("all mirrors failed");
  process.exit(1);
}
p.done({ phase: "fetched", elements: data.elements.length });

mkdirSync("data", { recursive: true });
const places = data.elements
  .filter((e) => e.tags?.name)
  .map((e) => {
    const c = e.center ?? e;
    const t = e.tags;
    return {
      name: t.name,
      street: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || null,
      city: t["addr:city"] ?? null,
      state: t["addr:state"] ?? null,
      zip: t["addr:postcode"] ?? null,
      lat: c.lat ?? null,
      lon: c.lon ?? null,
      ref: `${e.type}/${e.id}`,
    };
  });
writeFileSync("data/osm-duluth.json", JSON.stringify(places, null, 2));
console.log(`wrote data/osm-duluth.json — ${places.length} venues, ${places.filter((p) => p.street).length} with street addresses`);
