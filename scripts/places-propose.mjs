/**
 * Propose registry entries for unresolved venue strings. PRINTS ONLY — never writes src/places.ts.
 * The human paste is the id-stability guarantee.
 *
 * Usage: npx tsx scripts/places-propose.mjs <feed.ics>
 *
 * Ordering matters and each step fixes a measured probe defect:
 *   unescape ICS -> decode entities -> strip room suffixes -> query with the CORRECT city.
 *
 * `unescapeIcsText` runs before any entity-decode, twice over: once inline here on text pulled
 * straight out of the .ics (LOCATION, and the X-PLACE-NAME fallback), because ical-generator
 * re-escapes `;`/`,`/`\` on every X-property it re-serializes, and again inside
 * `normalizeVenueKey`/`cleanText` downstream. Skipping the first pass is exactly the bug that hit
 * `normalizeVenueKey` and the verify script's categorizer already (see place-resolve.ts and
 * verify-phase1.mjs): an escaped `\;` masks an HTML entity's terminator and the entity survives
 * undecoded straight into a geocoder query.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";
import { normalizeVenueKey, isSentinelVenue, parseVenueString } from "../src/place-resolve.js";
import { unescapeIcsText } from "../src/normalize.js";
import { deriveSetting, deriveGeoScope } from "../src/facets.js";

const ICS = process.argv[2] ?? "duluth-events.ics";
const UA = "duluth-events/0.1 (github.com/LampaGJ/duluth-events)";

/**
 * Pre-classification: some raw strings can never be a Place no matter what a geocoder returns for
 * them, per project spec ("virtual pseudo-venues, cities used as venues, and rooms" are rejected
 * outright, left provisional forever). These get sorted into their own NOT-A-VENUE bucket instead of
 * being scored — a perfect similarity score on a bare city name is maximally deceptive precisely
 * because a perfect score is the signal the LIKELY tier exists to reward.
 *
 *   virtual   — reuses src/facets.ts's OWN `deriveSetting` (its VIRTUAL_RE), so "Zoom"/"webinar"/
 *               "z.umn.edu" detection can never drift out of sync with the production classifier.
 *   room      — a small, evidence-drawn regex in the same minimal no-fuzzy-logic style as
 *               place-resolve.ts's SENTINELS list: every literal here is a raw string actually
 *               observed in the corpus ("Council Chambers[-,] ... City Hall", "Lakeside Conference
 *               Room", "Rm 430"), not a speculative pattern.
 *   city-as-venue — checked separately below (both pre- and post-geocode), since it needs the
 *               parsed `city` field this same collection loop is still computing.
 */
const ROOM_RE = /\bcouncil\s+chambers?\b|\bconference\s+room\b|\bmeeting\s+room\b|\bboard\s*room\b|\broom\s+\d+\b|\brm\.?\s*\d+\b/i;
const isVirtualPseudoVenue = (raw) => deriveSetting(raw, raw) === "virtual";

// --- collect unresolved venue strings with counts and their stated city ---
const lines = readFileSync(ICS, "utf8").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
const evs = [];
let cur = null;
for (const l of lines) {
  if (l === "BEGIN:VEVENT") { cur = {}; continue; }
  if (l === "END:VEVENT") { if (cur) evs.push(cur); cur = null; continue; }
  if (!cur) continue;
  const i = l.indexOf(":");
  if (i < 0) continue;
  const k = l.slice(0, i).split(";")[0];
  if (cur[k] === undefined) cur[k] = l.slice(i + 1);
}

const wanted = new Map(); // normalized key -> { raw, city, state, n }
const notAVenue = new Map(); // normalized key -> { raw, n, reason } — never geocoded, never scored
const addNotAVenue = (map, key, raw, n, reason) => {
  const prev = map.get(key);
  map.set(key, { raw, reason, n: (prev?.n ?? 0) + n });
};

for (const e of evs) {
  const loc = unescapeIcsText(e.LOCATION ?? "");
  const rawField = e["X-PLACE-NAME"] ?? loc.split(",")[0];
  if (!rawField || isSentinelVenue(rawField)) continue;
  if (e["X-PLACE-PROVISIONAL"] === "false") continue; // already registered
  const raw = unescapeIcsText(rawField); // guard: X-PLACE-NAME may itself carry RFC5545 escaping

  if (isVirtualPseudoVenue(raw)) {
    addNotAVenue(notAVenue, normalizeVenueKey(raw) || raw, raw, 1, "virtual pseudo-venue");
    continue;
  }
  if (ROOM_RE.test(raw)) {
    addNotAVenue(notAVenue, normalizeVenueKey(raw) || raw, raw, 1, "room, not a venue");
    continue;
  }

  const parsed = parseVenueString(raw);
  const key = normalizeVenueKey(parsed.name);
  if (!key) continue;
  const m = loc.match(/,\s*([A-Za-z .'-]+),\s*([A-Z]{2})\b/); // ALL states, not just MN|WI
  const prev = wanted.get(key);
  const city = parsed.city ?? prev?.city ?? m?.[1]?.trim() ?? "Duluth";
  const state = parsed.state ?? prev?.state ?? m?.[2] ?? "MN";

  // City-as-venue, pre-geocode: the source gave no venue name at all, just repeated its own city
  // (UMD away-game feeds do this — "Sioux Falls, SD" with an empty `rest`). Catching it here means
  // these never cost a Nominatim call at all, not just that they're relabeled after one.
  if (normalizeVenueKey(parsed.name) === normalizeVenueKey(city)) {
    addNotAVenue(notAVenue, key, parsed.name, 1, "raw venue string is just its own city (no venue name in source)");
    wanted.delete(key); // in case an earlier alias of the same key had already gone into `wanted`
    continue;
  }

  wanted.set(key, { raw: parsed.name, city, state, n: (prev?.n ?? 0) + 1 });
}
const targets = [...wanted.values()].sort((a, b) => b.n - a.n);
console.log(`${targets.length} unresolved venue strings (+ ${notAVenue.size} pre-classified NOT-A-VENUE, skipped)`);

// --- tier 1: the committed OSM cache ---
const osm = existsSync("data/osm-duluth.json") ? JSON.parse(readFileSync("data/osm-duluth.json", "utf8")) : [];
// "duluth" is the single most common token in this corpus (a Duluth-venue registry, mostly Duluth
// addresses) — leaving it a scoring token inflates Jaccard similarity between genuinely unrelated
// venues that merely both mention the city ("Duluth East High School" and "Duluth River Train" both
// token-matched "Duluth Grill" on "duluth" alone). Geographic and address-boilerplate words carry no
// venue IDENTITY, so they're stopped the same way "the"/"and" already were. Deliberately NOT stopping
// "building" — "Lincoln Park Building" uses it as a distinguishing word, not boilerplate.
const STOP = new Set([
  "the", "and", "of", "at", "inc", "llc", "co",
  "duluth", "superior", "minnesota", "wisconsin", "usa", "united", "states",
  "ave", "avenue", "street", "road", "drive", "blvd", "boulevard", "suite",
]);
const tk = (s) => new Set(normalizeVenueKey(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
/** Does `short` look like an acronym of `long`? DECC -> Duluth Entertainment Convention Center. */
const isAcronym = (short, long) => {
  const s = short.replace(/[^a-z]/gi, "").toLowerCase();
  if (s.length < 2 || s.length > 6) return false;
  const initials = long.split(/\s+/).filter(Boolean).map((w) => w[0]?.toLowerCase() ?? "").join("");
  return initials.includes(s);
};
/** Room/building codes in parens are not venue identity ("AMSOIL Arena (G)") — strip before a geocoder query. */
const stripRoomSuffix = (s) => s.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
const osmIdx = osm.map((o) => ({ o, t: tk(o.name) }));

/**
 * `data/osm-duluth.json` is a Duluth-BOUNDING-BOX extract (see scripts/fetch-osm.mjs's QUERY), not a
 * general venue database. An away-game venue (city="Sioux Falls, SD") can never legitimately match
 * it — every entry in the cache is, by construction, near Duluth. Matching non-local targets against
 * it anyway produced internally contradictory proposals: a correct away-city label paired with
 * Duluth-area coordinates pulled in from whatever local venue happened to token-overlap ("Bob Young
 * Field" in Sioux Falls -> "Field 9", a Duluth park), which reads as legitimate data (real name, real
 * OSM ref, real coordinates) with nothing on the page signaling the contradiction.
 *
 * Reuses src/facets.ts's OWN `deriveGeoScope` (the same TWIN_PORTS/REGIONAL rings production
 * X-GEO-SCOPE derivation uses) rather than inventing a second locality list. Only "duluth" and
 * "twin-ports" fall inside the cache's fetch bbox (46.60,-92.35 to 46.90,-91.95); "regional" (Two
 * Harbors, Hibbing, Ely, ...) and "distant" are real places outside it that must go straight to
 * Nominatim, which takes the city and can actually answer for them.
 */
const isLocalToOsmCache = (city, state) => {
  const scope = deriveGeoScope(city, state, "unknown");
  return scope === "duluth" || scope === "twin-ports";
};

/**
 * Belt-and-braces, independent of the string-based check above: the cache is itself geometrically
 * bbox-bound, so ANY accepted tier-1 hit's coordinates must fall inside that exact box. This is a
 * no-op against today's cache (fetch-osm.mjs's Overpass query already only returns points inside the
 * box) — it exists to catch a bug in `isLocalToOsmCache` itself, or a future cache that's widened or
 * hand-edited to include non-local data, using geometry rather than re-running the same string
 * classifier a second time.
 */
const DULUTH_BBOX = { latMin: 46.6, latMax: 46.9, lonMin: -92.35, lonMax: -91.95 };
const withinDuluthBbox = (lat, lon) =>
  lat != null && lon != null && lat >= DULUTH_BBOX.latMin && lat <= DULUTH_BBOX.latMax && lon >= DULUTH_BBOX.lonMin && lon <= DULUTH_BBOX.lonMax;

const p = progress("places-propose", { total: targets.length, everyN: 5 });
const rows = [];
let done = 0;

for (const t of targets) {
  let best = null, score = 0, src = null;
  // tier 1 only for targets the parsed city says are actually near Duluth — see isLocalToOsmCache's
  // doc comment. A non-local target skips straight to tier 2 (score stays 0, so the `< 0.5` gate
  // below fires unconditionally for it).
  if (isLocalToOsmCache(t.city, t.state)) {
    for (const x of osmIdx) {
      // Same acronym boost tier 2 gets, applied symmetrically so DECC-style names can resolve from the
      // committed cache without a network call at all when the cache already has the long-form entry.
      const s = Math.max(jac(tk(t.raw), x.t), isAcronym(t.raw, x.o.name) ? 0.9 : 0);
      if (s > score) { score = s; best = x.o; src = "osm"; }
    }
    // Belt-and-braces (see withinDuluthBbox's doc comment): reject the tier-1 hit outright if its own
    // coordinates somehow fall outside the cache's bbox.
    if (best && !withinDuluthBbox(best.lat, best.lon)) { best = null; score = 0; src = null; }
  }
  // tier 2: Nominatim, only when OSM was unconvincing (or skipped entirely as non-local)
  if (score < 0.5) {
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("q", `${stripRoomSuffix(t.raw)}, ${t.city}, ${t.state}`);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("addressdetails", "1");
      const j = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
      if (j.length) {
        const r = j[0], a = r.address ?? {};
        const name = r.name || String(r.display_name).split(",")[0];
        const s = Math.max(jac(tk(t.raw), tk(name)), isAcronym(t.raw, name) ? 0.9 : 0);
        if (s > score) {
          score = s; src = "web";
          best = {
            name, street: [a.house_number, a.road].filter(Boolean).join(" ") || null,
            city: a.city ?? a.town ?? a.village ?? null, state: a.state ?? null, zip: a.postcode ?? null,
            lat: +r.lat, lon: +r.lon, ref: `${r.osm_type}/${r.osm_id}`,
          };
        }
      }
      await new Promise((r) => setTimeout(r, 1150)); // Nominatim policy: <= 1 req/s
    } catch { /* leave whatever OSM gave */ }
  }
  rows.push({ ...t, best, score: +score.toFixed(2), src });
  p.tick(++done);
}

// City-as-venue, post-geocode: catches the case pre-geocode filtering above can't — raw text that
// doesn't textually equal its city, but which the geocoder still resolved TO the bare city (no
// distinguishing venue in the result either). A perfect similarity score here is the most dangerous
// case, not the safest: "Sioux Falls" -> Sioux Falls, SD at sim=1 is a mathematically correct geocode
// of a string that was never a venue to begin with.
const keptRows = [];
for (const r of rows) {
  if (r.best && normalizeVenueKey(r.best.name) === normalizeVenueKey(r.city)) {
    addNotAVenue(notAVenue, `${r.raw}|resolved`, r.raw, r.n, "resolved name equals its own city");
    continue;
  }
  keptRows.push(r);
}
const finalRows = keptRows;
p.done({ total: finalRows.length, notAVenue: notAVenue.size });

// --- emit paste-ready literals, ranked, with the verdict a human must check ---
const slug = (s) => normalizeVenueKey(s).replace(/\s+/g, "-").slice(0, 48).replace(/-+$/, "");
const verdict = (r) => (!r.best ? "NO MATCH — research by hand" : r.score >= 0.5 ? "LIKELY" : "WEAK — verify or reject");
const notAVenueRows = [...notAVenue.values()].sort((a, b) => b.n - a.n);
const anyAcronymHit = finalRows.some((r) => r.best && r.score === 0.9);

// Compute each row's proposed id ONCE (also reused in the literal-emission loop below), so duplicate
// detection and the pasted `id:` field can never drift apart from computing it twice differently.
for (const r of finalRows) r.id = slug(r.best?.name ?? r.raw);

/**
 * Two different raw strings can propose the SAME id — most visibly when the parsed name is generic
 * ("Wade Stadium") but the city differs per event (an away game vs. the real Duluth venue, or two
 * unrelated remote venues that both matched a similarly-named tier-2 result). Pasting duplicates as
 * written would trip `buildPlaceIndex`'s duplicate-id throw in src/place-registry.ts — a real
 * fail-fast, but only after a human has already done the work of writing the entries. Surface the
 * collision before pasting, not after.
 */
const idGroups = new Map();
for (const r of finalRows) {
  if (!idGroups.has(r.id)) idGroups.set(r.id, []);
  idGroups.get(r.id).push(r);
}
const totalEvents = (rs) => rs.reduce((sum, r) => sum + r.n, 0);
// Ranked by TOTAL EVENT COUNT across the colliding group, not candidate count — a 2-way collision
// carrying 41 events (lincoln-park) outranks a 6-way collision of one-off WEAK guesses.
const duplicateIds = [...idGroups.entries()].filter(([, rs]) => rs.length > 1).sort((a, b) => totalEvents(b[1]) - totalEvents(a[1]));

let out = "";
if (duplicateIds.length) {
  out += `# COLLIDING IDS — resolve before pasting\n\n`;
  out += `${duplicateIds.length} id${duplicateIds.length === 1 ? "" : "s"} below ${duplicateIds.length === 1 ? "is" : "are"} proposed by more than one raw\n`;
  out += `string. Pasting more than one literal per id as written would trip \`buildPlaceIndex\`'s\n`;
  out += `duplicate-id throw in src/place-registry.ts — a real fail-fast, but only after the work of\n`;
  out += `writing the entries is already done. Every candidate for a given id is grouped here, ranked\n`;
  out += `by total event count, so the two situations this tool CANNOT tell apart are at least visible\n`;
  out += `side by side instead of scattered through the file below:\n\n`;
  out += `  - the SAME physical place, described by more than one raw string -> merge into ONE\n`;
  out += `    literal, folding every raw string into that literal's \`nameAliases\`.\n`;
  out += `  - genuinely DIFFERENT places that happen to have proposed the same id -> keep both\n`;
  out += `    literals, but rename one of the \`id\`s before pasting.\n\n`;
  out += `**This tool does not decide which — that judgment is exactly what Task 9 is for.**\n\n`;
  for (const [id, rs] of duplicateIds) {
    out += `## COLLIDING ID: ${id}  (${totalEvents(rs)} events across ${rs.length} proposals)\n\n`;
    out += `Merge into one literal with combined \`nameAliases\`, or rename one \`id\` — decide, don't paste as-is.\n\n`;
    for (const r of rs) {
      out += `- "${r.raw}" (${r.n} event${r.n === 1 ? "" : "s"}) — ${verdict(r)}${r.best ? `, sim=${r.score}` : ""} — matched: ${r.best ? `"${r.best.name}" (${r.src}${r.best.ref ? `, ${r.best.ref}` : ""})` : "(no match)"}\n`;
    }
    out += `\n`;
  }
  out += `---\n\n`;
}
if (notAVenueRows.length) {
  out += `# NOT-A-VENUE — reject, leave provisional forever\n\n`;
  out += `${notAVenueRows.length} raw strings are structurally not venues (a city used as a venue\n`;
  out += `name, a virtual/online pseudo-venue, or a building room/subdivision). Per spec these are\n`;
  out += `never registered — **confirm the rejection**, do not paste a Place literal for any of\n`;
  out += `these. Listed here, ranked, and pulled OUT of the LIKELY/WEAK/NO MATCH tiers below so\n`;
  out += `skimming LIKELY can't miss them (a perfect similarity score on a bare city name is the\n`;
  out += `most deceptive case, not the safest one).\n\n`;
  for (const r of notAVenueRows) {
    out += `- **${r.raw}** (${r.n} event${r.n === 1 ? "" : "s"}) — ${r.reason}\n`;
  }
  out += `\n---\n\n`;
}

out += `# Place proposals\n\n`;
out += `${finalRows.length} unresolved strings. **Verify every entry before pasting.** A geocoder's\n`;
out += `confident wrong answer looks exactly like data: "Restaurant 301" resolved to "Perkins",\n`;
out += `"Sioux Falls" to "South Duluth Avenue". Nothing here is auto-accepted.\n\n`;
out += `Caveat: the acronym-boost path (DECC -> Duluth Entertainment Convention Center, scoring 0.9\n`;
out += `on zero token overlap) **${anyAcronymHit ? "did" : "did not"} fire** on this run — ${
  anyAcronymHit ? "at least one row below shows sim=0.9 via that path." : "no row below shows sim=0.9."
} It is proven\n`;
out += `correct in isolation (\`isAcronym("DECC", "Duluth Entertainment Convention Center") === true\`)\n`;
out += `but undemonstrated on live data in this run; see the Task 8 report for detail.\n\n`;
for (const r of finalRows) {
  out += `## ${r.raw}  (${r.n} event${r.n === 1 ? "" : "s"}) — ${verdict(r)}${r.best ? `, sim=${r.score}` : ""}\n\n`;
  out += "```ts\n{\n";
  out += `  id: ${JSON.stringify(r.id)},\n`;
  out += `  name: ${JSON.stringify(r.best?.name ?? r.raw)},\n`;
  out += `  nameAliases: ${JSON.stringify([r.raw])},\n`;
  out += `  addressAliases: ${JSON.stringify(r.best?.street ? [r.best.street] : [])},\n`;
  const city = r.best?.city ?? r.city, state = r.best?.state ?? r.state;
  out += `  address: { ${r.best?.street ? `street: ${JSON.stringify(r.best.street)}, ` : ""}city: ${JSON.stringify(city)}, state: ${JSON.stringify(state)}`;
  if (r.best?.lat) out += `, geo: { lat: ${r.best.lat}, lon: ${r.best.lon} }`;
  out += `, inDuluth: ${/^duluth$/i.test(city)} },\n`;
  out += `  provenance: { source: ${JSON.stringify(r.src ?? "manual")}${r.best?.ref ? `, ref: ${JSON.stringify(r.best.ref)}` : ""} },\n`;
  out += "},\n```\n\n";
}
mkdirSync("reports", { recursive: true });
writeFileSync("reports/places-proposal.md", out);
console.log(`\nwrote reports/places-proposal.md`);
console.log(`  NOT-A-VENUE: ${notAVenueRows.length}`);
console.log(`  LIKELY:      ${finalRows.filter((r) => r.best && r.score >= 0.5).length}`);
console.log(`  WEAK:        ${finalRows.filter((r) => r.best && r.score < 0.5).length}`);
console.log(`  NO MATCH:    ${finalRows.filter((r) => !r.best).length}`);
console.log(`  duplicate proposed ids: ${duplicateIds.length}${duplicateIds.length ? ` (${duplicateIds.map(([id]) => id).join(", ")})` : ""}`);
console.log(`\nreports/places-proposal.md is NOT the registry. Review, then paste into src/places.ts.`);
