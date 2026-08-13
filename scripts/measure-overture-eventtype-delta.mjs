/**
 * MEASUREMENT ONLY — changes nothing. Answers the task-spec question: "how many events would
 * change `eventType` if Overture categories replaced/augmented `classifyByVenue`, and which."
 *
 * Explicitly OUT OF SCOPE for this task (per the task spec) to actually wire Overture categories into
 * `classifyByVenue`/`classifyEventType` (`src/classify.ts` is untouched — verify with `git status`).
 * This script only READS `src/classify.ts`'s exported functions and compares their output against a
 * hand-built, ILLUSTRATIVE (not production-grade) Overture-category -> EventType mapping, scoped only
 * to the categories actually observed on THIS corpus's venue matches. It is not a proposal to ship
 * that mapping as-is — see the task report for why (879 categories total; this covers a few dozen).
 *
 * Methodology:
 *   1. Parse the built `duluth-events.ics` feed (same VEVENT-line parsing `scripts/places-propose.mjs`
 *      already uses) for each event's title, source CATEGORIES, venue string, and its ALREADY-EMITTED
 *      `eventType` (X-EVENT-TYPE) — the real production result of `finalizeEvent`.
 *   2. Recompute `classifyEventType(title, categories, SENTINEL, "")` — i.e. stages 1+2 ONLY (source
 *      category match, then title/description vocabulary), with venue excluded entirely. If this does
 *      NOT return SENTINEL, the event's type is already decided upstream of the venue and neither
 *      `classifyByVenue` nor any Overture-category substitute could ever change it — `classifyEventType`
 *      only reaches stage 3 (venue) when stages 1+2 found nothing. These events are excluded from the
 *      "would change" population entirely, not just scored as "no change" — this is what makes the
 *      comparison fair to a REPLACE-vs-AUGMENT framing: an Overture-based venue classifier could only
 *      ever compete at the priority level `classifyByVenue` already occupies (last resort), never above
 *      title/category, so testing it against the FULL corpus would overstate the blast radius.
 *   3. For the remaining "venue-decided" events, group by venue string and find the venue's best
 *      Overture match using the SAME token-Jaccard scorer `scripts/places-propose.mjs` uses, at the
 *      SAME LIKELY threshold (score >= 0.5, untied, not permanently_closed) — a low-confidence or tied
 *      guess is not a legitimate basis for a categorization change any more than for a Place proposal.
 *   4. Map the matched venue's `categories.primary` through `CATEGORY_TO_EVENTTYPE` below. Compare
 *      against `classifyByVenue(venueRaw) ?? "community"` (the actual production stage-3 result).
 *      Disagreements are counted and listed.
 */
import { readFileSync } from "node:fs";
import { classifyEventType, classifyByVenue } from "../src/classify.js";
import { unescapeIcsText } from "../src/normalize.js";
import { normalizeVenueKey, parseVenueString, isSentinelVenue } from "../src/place-resolve.js";
import { loadOverturePlaces } from "../src/overture.js";

const ICS = process.argv[2] ?? "duluth-events.ics";
const SENTINEL = "__UNMATCHED__";

// --- ILLUSTRATIVE ONLY: Overture categories.primary -> our EventType, scoped to categories actually
// observed among this corpus's venue matches (see the script-level doc comment for why this is not a
// production mapping proposal). `null` = deliberately left unmapped (too ambiguous to assign without
// more judgment than a measurement script should exercise on its own) — those cases are reported
// separately, not silently folded into "no change".
const CATEGORY_TO_EVENTTYPE = {
  music_venue: "live-music",
  jazz_and_blues_venue: "live-music",
  bar: "food-drink",
  irish_pub: "food-drink",
  beer_bar: "food-drink",
  brewery: "food-drink",
  night_club: "live-music",
  restaurant: "food-drink",
  american_restaurant: "food-drink",
  coffee_shop: "food-drink",
  winery: "food-drink",
  performing_arts_theater: "performing-arts",
  theater: "performing-arts",
  movie_theater: "film",
  art_gallery: "visual-arts",
  art_museum: "visual-arts",
  museum: "education",
  history_museum: "education",
  library: "education",
  planetarium: "education",
  college_university: "education",
  stadium_arena: "sports",
  sports_club: "sports",
  golf_course: "sports",
  ice_skating_rink: "sports",
  amusement_park: "family",
  zoo: "family",
  park: null, // genuinely ambiguous — a park hosts festivals, markets, sports and community events alike
  community_services_non_profits: "community",
  church_house_of_worship: "community",
  religious_organization: "community",
  government_building: "meeting",
  farmers_market: "market",
  convention_center: null, // hosts everything; no single EventType fits
  hotel: null, // a venue-of-convenience, not a function
  hotel_bar: "food-drink",
};

function parseIcs(path) {
  const lines = readFileSync(path, "utf8").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
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
    else cur[k] += `\n${l.slice(i + 1)}`; // DESCRIPTION etc. can fold across multiple X- lines in theory
  }
  return evs;
}

// Same tokenizer/scorer as scripts/places-propose.mjs (duplicated, not imported — those are unexported
// script-local consts, and this is a throwaway measurement script, not a shared module).
const STOP = new Set(["the", "and", "of", "at", "inc", "llc", "co", "usa", "united", "states", "ave", "avenue", "street", "road", "drive", "blvd", "boulevard", "suite", "suites"]);
const tk = (s) => new Set(normalizeVenueKey(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

const overture = loadOverturePlaces("data/overture-places.json").filter((o) => o.operatingStatus !== "permanently_closed");
const ovIdx = overture.map((o) => ({ o, t: tk(o.name) }));

function bestOverture(raw) {
  const target = tk(raw);
  let best = null, score = 0, tied = false;
  for (const x of ovIdx) {
    const s = jac(target, x.t);
    if (s > score) { score = s; best = x.o; tied = false; }
    else if (s === score && s > 0) tied = true;
  }
  return score >= 0.5 && !tied ? { place: best, score } : null;
}

const evs = parseIcs(ICS);
console.log(`${evs.length} total events in ${ICS}`);

let venueDecidedEvents = 0;
const byVenue = new Map(); // normalized key -> { raw, n, titles: [] }
for (const e of evs) {
  const loc = unescapeIcsText(e.LOCATION ?? "");
  const rawField = e["X-PLACE-NAME"] ?? loc.split(",")[0];
  if (!rawField || isSentinelVenue(rawField)) continue;
  const raw = unescapeIcsText(rawField);
  const parsed = parseVenueString(raw);
  const venueName = parsed.name;
  if (!venueName) continue;

  const title = unescapeIcsText(e.SUMMARY ?? "");
  const categories = (e.CATEGORIES ?? "").split(",").map((c) => unescapeIcsText(c.trim())).filter(Boolean);

  const base = classifyEventType(title, categories, SENTINEL, "");
  if (base !== SENTINEL) continue; // stage 1/2 already decided it — venue (Overture or not) can't change it

  venueDecidedEvents++;
  const key = normalizeVenueKey(venueName);
  const prev = byVenue.get(key);
  byVenue.set(key, { raw: venueName, n: (prev?.n ?? 0) + 1, titles: [...(prev?.titles ?? []), title] });
}

console.log(`${venueDecidedEvents} of ${evs.length} events are "venue-decided" (stages 1+2 found nothing; classifyByVenue is what actually types them today)`);
console.log(`${byVenue.size} distinct venues among those events`);

let changedEvents = 0;
let changedVenues = 0;
let matchedNoMapping = 0;
let noConfidentMatch = 0;
const changes = [];
const unmappedCategories = new Map();

for (const [, v] of byVenue) {
  const currentType = classifyByVenue(v.raw) ?? "community";
  const match = bestOverture(v.raw);
  if (!match) { noConfidentMatch++; continue; }
  const cat = match.place.categories.primary;
  const overtureType = cat ? CATEGORY_TO_EVENTTYPE[cat] : undefined;
  // `== null` deliberately catches BOTH "not in the table at all" (undefined) and "in the table but
  // explicitly marked too ambiguous to map" (null, e.g. `park`) — both mean "no opinion", not "no type".
  if (overtureType == null) {
    matchedNoMapping++;
    if (cat) unmappedCategories.set(cat, (unmappedCategories.get(cat) ?? 0) + v.n);
    continue;
  }
  if (overtureType !== currentType) {
    changedVenues++;
    changedEvents += v.n;
    changes.push({ venue: v.raw, n: v.n, currentType, overtureType, category: cat, matchedName: match.place.name, score: match.score, titles: v.titles });
  }
}

console.log(`\n--- result ---`);
console.log(`venue-decided events: ${venueDecidedEvents}`);
console.log(`  no confident (score>=0.5, untied) Overture match: ${noConfidentMatch} venues`);
console.log(`  confident match but category unmapped (illustrative table only): ${matchedNoMapping} venues`);
console.log(`  confident match, mapped, SAME type as classifyByVenue: ${byVenue.size - noConfidentMatch - matchedNoMapping - changedVenues} venues`);
console.log(`  confident match, mapped, DIFFERENT type: ${changedVenues} venues / ${changedEvents} events`);

console.log(`\nunmapped categories encountered (illustrative table doesn't cover these), by event count:`);
for (const [cat, n] of [...unmappedCategories.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${n} event(s)`);
}

console.log(`\nchanges (venue, events, current classifyByVenue type -> hypothetical Overture-category type):`);
for (const c of changes.sort((a, b) => b.n - a.n)) {
  console.log(`  "${c.venue}" (${c.n} event${c.n === 1 ? "" : "s"}) [matched Overture "${c.matchedName}" cat=${c.category} sim=${c.score.toFixed(2)}]: ${c.currentType} -> ${c.overtureType}`);
}
