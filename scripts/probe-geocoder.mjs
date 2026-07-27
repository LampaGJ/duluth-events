/**
 * DESIGN RESEARCH (not production): measure Nominatim coverage + reliability across every distinct
 * venue string in the corpus, to size the Place registry seeding pipeline.
 *
 * Nominatim always returns a best guess, so raw hit-rate is meaningless. What matters is the
 * name-similarity between what we asked for and what came back — that is the signal the real
 * proposer will use to decide "auto-accept" vs "flag for human review".
 *
 * Emits pollable progress to reports/.progress/geocode-probe.json (per user shell discipline).
 * Usage: node scripts/probe-geocoder.mjs <path-to-ics>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";

const ICS = process.argv[2] ?? "/tmp/live.ics";
const UA = "duluth-events/0.1 (github.com/LampaGJ/duluth-events; design research)";
const SENTINEL = /^(see listing|not specified|see catalog|see agenda|sign in to download|tbd|various|zoom|online)/i;

const ENT = { amp: "&", nbsp: " ", ndash: "-", mdash: "-", rsquo: "", lsquo: "", hellip: "", quot: '"' };
const dec = (s) => {
  let o = s;
  for (let i = 0; i < 3; i++) {
    const n = o.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (w, b) => {
      b = b.toLowerCase();
      if (b[0] === "#") return String.fromCodePoint(b[1] === "x" ? parseInt(b.slice(2), 16) : +b.slice(1));
      return ENT[b] ?? w;
    });
    if (n === o) break;
    o = n;
  }
  return o;
};
const STOP = new Set(["the", "and", "of", "at", "inc", "llc", "co"]);
const tk = (s) =>
  new Set(
    dec(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2 && !STOP.has(w)),
  );
const jac = (a, b) => {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};

// --- parse distinct venue strings + counts + the city the source claimed ---
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
const counts = new Map();
for (const e of evs) {
  const loc = (e.LOCATION ?? "").replace(/\\,/g, ",");
  const venue = loc.split(",")[0].trim();
  if (!venue || SENTINEL.test(venue)) continue;
  const m = loc.match(/,\s*([A-Za-z .'-]+),\s*(MN|WI)\b/);
  const city = m ? `${m[1].trim()}, ${m[2]}` : "Duluth, MN";
  const key = `${dec(venue)}|${city}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const targets = [...counts].map(([k, n]) => ({ venue: k.split("|")[0], city: k.split("|")[1], n })).sort((a, b) => b.n - a.n);

const p = progress("geocode-probe", { total: targets.length, everyN: 5 });
const results = [];
let done = 0;

for (const t of targets) {
  const q = `${t.venue}, ${t.city}`;
  let row = { ...t, status: "error", match: null, sim: 0 };
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "1");
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const j = await res.json();
    if (!j.length) row.status = "miss";
    else {
      const r = j[0];
      const a = r.address ?? {};
      const name = r.name || String(r.display_name).split(",")[0];
      const sim = jac(tk(t.venue), tk(name));
      row = {
        ...t,
        status: sim >= 0.5 ? "confident" : sim > 0 ? "weak" : "mismatch",
        sim: +sim.toFixed(2),
        match: {
          name,
          street: [a.house_number, a.road].filter(Boolean).join(" ") || null,
          city: a.city ?? a.town ?? a.village ?? null,
          state: a.state ?? null,
          zip: a.postcode ?? null,
          lat: +r.lat,
          lon: +r.lon,
          osm: `${r.osm_type}/${r.osm_id}`,
        },
      };
    }
  } catch (err) {
    row.note = String(err).slice(0, 80);
  }
  results.push(row);
  p.tick(++done, { confident: results.filter((r) => r.status === "confident").length });
  await new Promise((r) => setTimeout(r, 1150)); // Nominatim policy: <= 1 req/s
}

p.done({ total: results.length });
mkdirSync("reports", { recursive: true });
writeFileSync("reports/geocode-probe.json", JSON.stringify(results, null, 2));

const by = (s) => results.filter((r) => r.status === s);
const ev = (rs) => rs.reduce((a, r) => a + r.n, 0);
console.log(`\n=== Nominatim probe: ${results.length} distinct venue strings, ${ev(results)} events ===`);
for (const s of ["confident", "weak", "mismatch", "miss", "error"]) {
  console.log(`  ${s.padEnd(10)} ${String(by(s).length).padStart(4)} strings / ${String(ev(by(s))).padStart(4)} events`);
}
console.log(`\nAUTO-ACCEPTABLE (sim>=0.5): ${((100 * ev(by("confident"))) / ev(results)).toFixed(0)}% of events`);
console.log(`\nMISMATCHES (would be wrong if auto-accepted):`);
for (const r of by("mismatch").slice(0, 15)) console.log(`  ${String(r.n).padStart(3)}  "${r.venue}" -> "${r.match?.name}"`);
console.log(`\nWEAK (need review):`);
for (const r of by("weak").slice(0, 12)) console.log(`  sim=${r.sim} ${String(r.n).padStart(3)}  "${r.venue}" -> "${r.match?.name}"`);
