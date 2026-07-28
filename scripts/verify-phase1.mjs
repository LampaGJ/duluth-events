/**
 * Phase-1 gate: resolution is now emitted, but merge behaviour must be UNCHANGED except for the one
 * deliberate, measured delta Task 6 introduced (the Buffalo Galaxy address-vs-name merge — see
 * docs/superpowers/plans/2026-07-28-place-entity-resolution.md Task 6 §4 and Task 7's carry-forward
 * notes in .superpowers/sdd/2026-07-28-place-entity-resolution/progress.md).
 *
 * A naive "any UID lost/gained is a FAIL" gate is WRONG here: it would flag that one true-positive
 * merge as a regression. This version CLASSIFIES losses instead of just counting them:
 *
 *   lost, explained by a same-place same-instant survivor  -> report, do NOT fail
 *   lost, unexplained                                      -> FAIL
 *   gained                                                 -> FAIL
 *
 * "Explained" is not a heuristic guess — it re-resolves the LOST event's own venue text through the
 * real `resolvePlace()` (the same function the pipeline uses) to get the place id it WOULD have
 * received under Phase 1, then checks whether a surviving event in the new feed shares both that
 * place id (X-PLACE-ID) and the lost event's start instant (DTSTART). Two events can only be the
 * "same merge" if both hold; matching on instant alone would over-explain unrelated coincidences,
 * and matching on place alone would over-explain recurring series at the same venue.
 *
 * Reusable: Task 11 (the merge-diff gate) needs the identical lost/explained/unexplained/gained
 * classification, so this is written as an importable function, not just a CLI script.
 *
 * Usage: npx tsx scripts/verify-phase1.mjs <baseline.ics> <new.ics>
 */
import { readFileSync } from "node:fs";
import { resolvePlace } from "../src/place-registry.js";

/** Parse an .ics file's VEVENT blocks into flat property-name -> first-value maps. */
export function parseIcs(f) {
  const lines = readFileSync(f, "utf8").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const evs = [];
  let cur = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (l === "END:VEVENT") {
      if (cur) evs.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = l.indexOf(":");
    if (i < 0) continue;
    const k = l.slice(0, i).split(";")[0];
    if (cur[k] === undefined) cur[k] = l.slice(i + 1);
  }
  return evs;
}

/** First comma-segment of an unescaped LOCATION value — the venue string, same convention formatLocation uses. */
function venueOf(e) {
  const loc = (e.LOCATION ?? "").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
  return loc.split(",")[0].trim();
}

/** Facet/eventType X-properties `deriveFacets` and `classifyByVenue` can move when a venue resolves. */
const FACET_KEYS = [
  "X-EVENT-TYPE",
  "X-ALCOHOL",
  "X-SETTING",
  "X-AUDIENCE",
  "X-COST-TIER",
  "X-GEO-SCOPE",
  "X-TIME-OF-DAY",
  "X-WEEKEND",
  "X-RECURRING",
  "X-REGISTRATION",
  "X-PUBLIC-ADMISSION",
  "X-HOME-AWAY",
  "X-INSTITUTIONAL-NOTICE",
  "X-RESCHEDULED",
];

/**
 * Classify baseline (a) vs new (b) parsed event arrays.
 * Returns { lostExplained, lostUnexplained, possibleRenames, gained, resolvedCount, registeredCount,
 *           locationChanged, facetChanged }.
 */
export function classify(a, b) {
  const byUidA = new Map(a.map((e) => [e.UID, e]));
  const byUidB = new Map(b.map((e) => [e.UID, e]));

  const lostUids = [...byUidA.keys()].filter((u) => !byUidB.has(u));
  const gainedUids = [...byUidB.keys()].filter((u) => !byUidA.has(u));

  // Index survivors by (X-PLACE-ID, DTSTART instant) for O(1) explanation lookup.
  const survivorsByPlaceInstant = new Map();
  for (const e of b) {
    const placeId = e["X-PLACE-ID"];
    if (!placeId || !e.DTSTART) continue;
    const key = `${placeId}|${e.DTSTART}`;
    if (!survivorsByPlaceInstant.has(key)) survivorsByPlaceInstant.set(key, []);
    survivorsByPlaceInstant.get(key).push(e);
  }

  const lostExplained = [];
  const lostUnexplainedRaw = [];
  for (const uid of lostUids) {
    const lost = byUidA.get(uid);
    const venue = venueOf(lost);
    const wouldBePlace = resolvePlace(venue || undefined);
    const survivors = wouldBePlace ? (survivorsByPlaceInstant.get(`${wouldBePlace.id}|${lost.DTSTART}`) ?? []) : [];
    if (survivors.length) {
      lostExplained.push({ uid, lost, wouldBePlaceId: wouldBePlace.id, survivors });
    } else {
      lostUnexplainedRaw.push({ uid, lost, wouldBePlaceId: wouldBePlace?.id ?? null });
    }
  }

  const gainedRaw = gainedUids.map((uid) => ({ uid, event: byUidB.get(uid) }));

  // A lost UID and a gained UID sharing SUMMARY+DTSTART is NOT a place-identity merge (that requires
  // a place match, above) — it is the same physical event surfacing under a different UID string,
  // which would mean a makeUid() input changed. That is a genuine regression Task 6 claims did NOT
  // happen; flag it distinctly so it isn't mistaken for the expected merge shape and isn't silently
  // dropped into "unexplained" undifferentiated from a naturally-expired event.
  const gainedBySig = new Map(gainedRaw.map((g) => [`${g.event.SUMMARY}|${g.event.DTSTART}`, g]));
  const possibleRenames = [];
  const lostUnexplained = [];
  for (const x of lostUnexplainedRaw) {
    const sig = `${x.lost.SUMMARY}|${x.lost.DTSTART}`;
    const match = gainedBySig.get(sig);
    if (match) possibleRenames.push({ ...x, renamedTo: match });
    else lostUnexplained.push(x);
  }
  const renamedGainedUids = new Set(possibleRenames.map((r) => r.renamedTo.uid));
  const gained = gainedRaw.filter((g) => !renamedGainedUids.has(g.uid));

  const resolved = b.filter((e) => e["X-PLACE-ID"]);
  const registered = resolved.filter((e) => e["X-PLACE-PROVISIONAL"] === "false");

  // Informational only (never affects pass/fail): among events present in BOTH feeds under the SAME
  // uid, how many changed LOCATION text or a facet/eventType field. Expected deltas #2/#3.
  const locationChanged = [];
  const facetChanged = [];
  for (const [uid, ea] of byUidA) {
    const eb = byUidB.get(uid);
    if (!eb) continue;
    if (ea.LOCATION !== eb.LOCATION) locationChanged.push({ uid, before: ea.LOCATION, after: eb.LOCATION });
    for (const k of FACET_KEYS) {
      if (ea[k] !== eb[k]) facetChanged.push({ uid, key: k, before: ea[k], after: eb[k] });
    }
  }

  return {
    baselineCount: a.length,
    newCount: b.length,
    lostExplained,
    lostUnexplained,
    possibleRenames,
    gained,
    resolvedCount: resolved.length,
    registeredCount: registered.length,
    locationChanged,
    facetChanged,
  };
}

// --- CLI entry point ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [baselinePath, newPath] = process.argv.slice(2);
  if (!baselinePath || !newPath) {
    console.error("Usage: npx tsx scripts/verify-phase1.mjs <baseline.ics> <new.ics>");
    process.exit(2);
  }

  const a = parseIcs(baselinePath);
  const b = parseIcs(newPath);
  const r = classify(a, b);

  console.log(`baseline ${r.baselineCount} events | new ${r.newCount} events`);
  console.log(`resolution: ${r.resolvedCount}/${r.newCount} have a place (${r.registeredCount} registered, ${r.resolvedCount - r.registeredCount} provisional)`);

  console.log(`\nUIDs lost: ${r.lostExplained.length + r.lostUnexplained.length + r.possibleRenames.length} (${r.lostExplained.length} explained, ${r.lostUnexplained.length} unexplained, ${r.possibleRenames.length} possible UID renames)`);
  console.log(`UIDs gained: ${r.gained.length}`);

  console.log(`\n--- Informational (never affects pass/fail) ---`);
  console.log(`LOCATION text changed (matched uids): ${r.locationChanged.length}`);
  for (const x of r.locationChanged.slice(0, 10)) {
    console.log(`  ${x.uid}`);
    console.log(`    before: ${x.before}`);
    console.log(`    after:  ${x.after}`);
  }
  if (r.locationChanged.length > 10) console.log(`  … and ${r.locationChanged.length - 10} more`);
  console.log(`\nfacet/eventType shifts (matched uids): ${r.facetChanged.length}`);
  for (const x of r.facetChanged.slice(0, 10)) {
    console.log(`  ${x.uid}  ${x.key}: ${x.before ?? "(unset)"} -> ${x.after ?? "(unset)"}`);
  }
  if (r.facetChanged.length > 10) console.log(`  … and ${r.facetChanged.length - 10} more`);

  if (r.lostExplained.length) {
    console.log(`\n--- EXPLAINED losses (absorbed by a same-place same-instant merge; not a failure) ---`);
    for (const x of r.lostExplained) {
      console.log(`  LOST   ${x.uid}`);
      console.log(`         "${x.lost.SUMMARY}" @ ${x.lost.DTSTART}  place=${x.wouldBePlaceId}`);
      for (const s of x.survivors) {
        console.log(`         absorbed by -> "${s.SUMMARY}" (${s.UID}) source=${s["X-SOURCE-NAME"] ?? "?"} alsoListedIn=${s["X-ALSO-LISTED-IN"] ?? "-"}`);
      }
    }
  }

  let fail = false;
  if (r.lostUnexplained.length) {
    fail = true;
    console.error(`\n--- UNEXPLAINED losses (FAIL) ---`);
    for (const x of r.lostUnexplained) {
      console.error(`  LOST   ${x.uid}`);
      console.error(`         "${x.lost.SUMMARY}" @ ${x.lost.DTSTART}  venue="${venueOf(x.lost)}"  wouldBePlaceId=${x.wouldBePlaceId ?? "(sentinel/unresolved)"}`);
    }
  }
  if (r.possibleRenames.length) {
    fail = true;
    console.error(`\n--- POSSIBLE UID RENAMES (FAIL — same title+instant, different UID; a makeUid() input moved) ---`);
    for (const x of r.possibleRenames) {
      console.error(`  ${x.uid} -> ${x.renamedTo.uid}`);
      console.error(`         "${x.lost.SUMMARY}" @ ${x.lost.DTSTART}`);
    }
  }
  if (r.gained.length) {
    fail = true;
    console.error(`\n--- GAINED events (FAIL — Phase 1 must not add events) ---`);
    for (const g of r.gained) {
      console.error(`  GAINED ${g.uid}`);
      console.error(`         "${g.event.SUMMARY}" @ ${g.event.DTSTART}`);
    }
  }

  if (fail) {
    console.error(`\nFAIL: Phase 1 changed which events exist beyond the known place-identity merge.`);
    process.exit(1);
  }
  console.log(`\nPASS: event set unchanged except for explained place-identity merges.`);
}
