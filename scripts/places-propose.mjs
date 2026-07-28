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

const ICS = process.argv[2] ?? "duluth-events.ics";
const UA = "duluth-events/0.1 (github.com/LampaGJ/duluth-events)";

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
for (const e of evs) {
  const loc = unescapeIcsText(e.LOCATION ?? "");
  const rawField = e["X-PLACE-NAME"] ?? loc.split(",")[0];
  if (!rawField || isSentinelVenue(rawField)) continue;
  if (e["X-PLACE-PROVISIONAL"] === "false") continue; // already registered
  const raw = unescapeIcsText(rawField); // guard: X-PLACE-NAME may itself carry RFC5545 escaping
  const parsed = parseVenueString(raw);
  const key = normalizeVenueKey(parsed.name);
  if (!key) continue;
  const m = loc.match(/,\s*([A-Za-z .'-]+),\s*([A-Z]{2})\b/); // ALL states, not just MN|WI
  const prev = wanted.get(key);
  wanted.set(key, {
    raw: parsed.name,
    city: parsed.city ?? prev?.city ?? m?.[1]?.trim() ?? "Duluth",
    state: parsed.state ?? prev?.state ?? m?.[2] ?? "MN",
    n: (prev?.n ?? 0) + 1,
  });
}
const targets = [...wanted.values()].sort((a, b) => b.n - a.n);
console.log(`${targets.length} unresolved venue strings`);

// --- tier 1: the committed OSM cache ---
const osm = existsSync("data/osm-duluth.json") ? JSON.parse(readFileSync("data/osm-duluth.json", "utf8")) : [];
const STOP = new Set(["the", "and", "of", "at", "inc", "llc", "co"]);
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

const p = progress("places-propose", { total: targets.length, everyN: 5 });
const rows = [];
let done = 0;

for (const t of targets) {
  let best = null, score = 0, src = null;
  for (const x of osmIdx) {
    // Same acronym boost tier 2 gets, applied symmetrically so DECC-style names can resolve from the
    // committed cache without a network call at all when the cache already has the long-form entry.
    const s = Math.max(jac(tk(t.raw), x.t), isAcronym(t.raw, x.o.name) ? 0.9 : 0);
    if (s > score) { score = s; best = x.o; src = "osm"; }
  }
  // tier 2: Nominatim, only when OSM was unconvincing
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
p.done({ total: rows.length });

// --- emit paste-ready literals, ranked, with the verdict a human must check ---
const slug = (s) => normalizeVenueKey(s).replace(/\s+/g, "-").slice(0, 48).replace(/-+$/, "");
const verdict = (r) => (!r.best ? "NO MATCH — research by hand" : r.score >= 0.5 ? "LIKELY" : "WEAK — verify or reject");

let out = `# Place proposals\n\n`;
out += `${rows.length} unresolved strings. **Verify every entry before pasting.** A geocoder's\n`;
out += `confident wrong answer looks exactly like data: "Restaurant 301" resolved to "Perkins",\n`;
out += `"Sioux Falls" to "South Duluth Avenue". Nothing here is auto-accepted.\n\n`;
for (const r of rows) {
  out += `## ${r.raw}  (${r.n} event${r.n === 1 ? "" : "s"}) — ${verdict(r)}${r.best ? `, sim=${r.score}` : ""}\n\n`;
  out += "```ts\n{\n";
  out += `  id: ${JSON.stringify(slug(r.best?.name ?? r.raw))},\n`;
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
console.log(`  LIKELY:   ${rows.filter((r) => r.best && r.score >= 0.5).length}`);
console.log(`  WEAK:     ${rows.filter((r) => r.best && r.score < 0.5).length}`);
console.log(`  NO MATCH: ${rows.filter((r) => !r.best).length}`);
console.log(`\nreports/places-proposal.md is NOT the registry. Review, then paste into src/places.ts.`);
