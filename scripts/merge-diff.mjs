/**
 * PHASE-3 HARD GATE. Prints every event that disappeared between two builds and why, so a human can
 * confirm no false merge before Phase 3 ships. A false merge DELETES an event, so this must be READ,
 * not skimmed — the riskiest lines are sorted to the top so a human can stop after ten.
 *
 * Usage: tsx scripts/merge-diff.mjs <baseline.ics> <new.ics> [maxMerges]
 *
 * --- WHY THIS DOES NOT REUSE scripts/verify-phase1.mjs's classify() UNMODIFIED ------------------
 *
 * verify-phase1.mjs's `phase1MergeExplanationKey` is `${placeId}|${dtstartInstant string}` — it
 * encodes PHASE 1's merge rule (same X-PLACE-ID + same raw DTSTART text) and its own header warns
 * any later caller to re-derive it before trusting the explained/unexplained split. Task 10 (commit
 * e411dab..9ebf1b5) changed the merge rule itself, in exactly three ways this file's explanation
 * logic below has to account for:
 *
 *   1. INSTANT, not DTSTART string. `src/dedupe.ts` pass 1 keys on `new Date(e.start).getTime()`
 *      (schema.ts:312's standing rule) so two sources writing one moment as `-05:00` and `Z` merge.
 *      Comparing raw DTSTART text — as phase1MergeExplanationKey does — would MISS that merge and
 *      call it unexplained.
 *   2. CROSS-SOURCE, PLUS a same-source EXACT-TITLE fold. Phase 1 never merged same-source copies at
 *      all, so its key had no source check. Phase 3 refuses a same-source pair UNLESS the titles are
 *      byte-identical (dedupe.ts's `bySourceTitle` fold, which runs before refusal (b)). A key that
 *      ignores source, like phase1's, would call some Phase-3 refusals "explained" (false PASS) and
 *      would call the same-source EXACT-title fold case itself unreadable as a distinct path.
 *   3. TITLE-VETO GATED. Phase 1 had no title check. Phase 3 refuses a whole place+instant group if
 *      any pair scores below TITLE_VETO (0.15) on `titleSimilarity`. Reusing phase1's key would call
 *      a same-place-same-instant pair "explained" even where the real dedupe() would have vetoed it
 *      and left both events standing — exactly the over-explaining failure mode the Phase-1 script's
 *      own header calls out as the dangerous direction (a false PASS on a real missing event).
 *
 * So this file derives its OWN `phase3ExplainLoss`, built from the actual Task-10 primitives —
 * `resolvePlace`, `titleSimilarity`, `TITLE_VETO`, `fuzzyKey` — imported from `src/dedupe.js` and
 * `src/place-registry.js`, never reimplemented by hand. The printed title-similarity score for every
 * place-pass explanation IS the number the real veto compared against TITLE_VETO, not a re-derivation
 * that could silently drift from it.
 * ---------------------------------------------------------------------------------------------------
 */
import { readFileSync } from "node:fs";
import { parseIcs } from "./verify-phase1.mjs";
import { resolvePlace } from "../src/place-registry.js";
import { titleSimilarity, TITLE_VETO, fuzzyKey } from "../src/dedupe.js";
import { decodeEntities, unescapeIcsText } from "../src/normalize.js";
import { SOURCES } from "../src/sources.js";

const venueOf = (e) => unescapeIcsText(e.LOCATION ?? "").split(",")[0].trim();
const titleOf = (e) => decodeEntities(unescapeIcsText(e.SUMMARY ?? ""));

/**
 * DTSTART in a SHIPPED feed is emitted in one of two ICS basic forms, both UTC (`src/emit.ts` via
 * `ical-generator`): a timed event as "20260729T231500Z", an all-day event as bare-DATE "20261023"
 * (no time, no Z — `X-MICROSOFT-CDO-ALLDAYEVENT` sidecar confirms it). Converting either to extended
 * ISO and parsing gives the true resolved instant, matching `dedupe.ts` pass 1's
 * `new Date(e.start).getTime()` — not the Phase-1 gate's raw-string comparison. An all-day event
 * resolves to that date's UTC midnight, same as the pipeline's own all-day handling, which is exactly
 * why all-day events at one provisional place collapse to one instant regardless of true kickoff time
 * (the away-game carry-forward this tool flags separately). Returns null (never merges) if DTSTART is
 * missing or matches neither form, which would mean emit.ts's contract changed and this needs
 * re-deriving too.
 */
export function instantOf(e) {
  const raw = e.DTSTART;
  if (!raw) return null;
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (timed) {
    const [, y, mo, d, h, mi, s] = timed;
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    return Number.isNaN(t) ? null : t;
  }
  const allDay = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (allDay) {
    const [, y, mo, d] = allDay;
    const t = Date.parse(`${y}-${mo}-${d}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Every source name credited for an event: its primary X-SOURCE-NAME plus X-ALSO-LISTED-IN. */
function sourceSetOf(e) {
  const set = new Set();
  if (e["X-SOURCE-NAME"]) set.add(decodeEntities(unescapeIcsText(e["X-SOURCE-NAME"])));
  const also = unescapeIcsText(e["X-ALSO-LISTED-IN"] ?? "");
  if (also) for (const s of also.split(", ")) if (s) set.add(decodeEntities(s));
  return set;
}

function isProvisional(e) {
  return e["X-PLACE-ID"] !== undefined && e["X-PLACE-PROVISIONAL"] === "true";
}

/** Build a minimal object shaped enough for the real `fuzzyKey()` to read (title/start/place/venueRaw). */
function pseudoEventFor(e, wouldBePlace) {
  return {
    title: titleOf(e),
    start: new Date(instantOf(e)).toISOString(),
    place: wouldBePlace,
    venueRaw: venueOf(e),
  };
}

/**
 * Explain one LOST event against the survivors of the NEW file. Two paths, mirroring dedupe()'s two
 * passes:
 *
 *   PLACE — a survivor shares the lost event's re-resolved place id and resolved instant, AND the
 *     lost event's source is credited (primary or X-ALSO-LISTED-IN) on that survivor — i.e. the
 *     survivor's OWN provenance says it absorbed this source, not just a place/instant coincidence.
 *     titleSimilarity is always computed and returned for display. If it comes back below
 *     TITLE_VETO, shipped dedupe() could not have produced this merge — that candidate is REJECTED
 *     (this file's match is a false positive, e.g. a provisional-place instant collision), not
 *     trusted, so a real anomaly can never get a free pass through this gate.
 *   TITLE — pass 2's fallback: `fuzzyKey(lost) === fuzzyKey(survivor)`, for whatever the place pass
 *     could not explain (typically a sentinel venue with no resolved place at all). Approximate near
 *     local-midnight: fuzzyKey's `day` component reads the event's LOCAL calendar date, which this
 *     tool cannot recover from a UTC-emitted DTSTART alone, so this path uses the UTC calendar date
 *     instead. This can only make the gate MORE conservative (a real title-pass merge misses
 *     explanation and is reported unexplained for a human to eyeball), never less — it cannot ever
 *     manufacture a false "explained".
 *
 * Returns { status: "place" | "title" | "unexplained", survivor?, wouldBePlace, similarity? }.
 */
function explainLoss(lost, survivors) {
  const venue = venueOf(lost);
  const wouldBePlace = resolvePlace(venue || undefined);
  const lostSources = sourceSetOf(lost);

  if (wouldBePlace) {
    const instant = instantOf(lost);
    const placeCandidates = survivors.filter(
      (s) => s["X-PLACE-ID"] === wouldBePlace.id && instantOf(s) === instant,
    );
    for (const s of placeCandidates) {
      const survivorSources = sourceSetOf(s);
      const credited = [...lostSources].some((name) => name && survivorSources.has(name));
      if (!credited) continue;
      const similarity = titleSimilarity(titleOf(lost), titleOf(s));
      if (similarity < TITLE_VETO) continue; // cannot be a real dedupe() merge — reject, don't trust
      return { status: "place", survivor: s, wouldBePlace, similarity };
    }
  }

  const lostKey = fuzzyKey(pseudoEventFor(lost, wouldBePlace));
  for (const s of survivors) {
    const sPlace = s["X-PLACE-ID"] ? { id: s["X-PLACE-ID"], name: decodeEntities(unescapeIcsText(s["X-PLACE-NAME"] ?? "")) } : undefined;
    if (fuzzyKey(pseudoEventFor(s, sPlace)) !== lostKey) continue;
    const survivorSources = sourceSetOf(s);
    const credited = [...lostSources].some((name) => name && survivorSources.has(name));
    if (!credited) continue;
    return { status: "title", survivor: s, wouldBePlace };
  }

  return { status: "unexplained", wouldBePlace };
}

/**
 * Full classification of baseline (a) vs new (b). Exported so a test can pin the merge-count bound
 * without shelling out.
 */
export function diff(a, b) {
  const byUidA = new Map(a.map((e) => [e.UID, e]));
  const byUidB = new Map(b.map((e) => [e.UID, e]));

  const lostRaw = [...byUidA.values()].filter((e) => !byUidB.has(e.UID));
  const gainedRaw = [...byUidB.values()].filter((e) => !byUidA.has(e.UID));

  // Same SUMMARY(decoded)+instant on both a lost and a gained UID is one physical event under a
  // DIFFERENT uid string, not a merge — a makeUid() input moved. Always a failure; never conflated
  // with an explained merge or an ordinary gain.
  const gainedBySig = new Map(gainedRaw.map((g) => [`${titleOf(g)}|${instantOf(g)}`, g]));
  const changedUid = [];
  const lost = [];
  for (const l of lostRaw) {
    const sig = `${titleOf(l)}|${instantOf(l)}`;
    const match = gainedBySig.get(sig);
    if (match) changedUid.push({ lost: l, gained: match });
    else lost.push(l);
  }
  const renamedGainedUids = new Set(changedUid.map((r) => r.gained.UID));
  const gained = gainedRaw.filter((g) => !renamedGainedUids.has(g.UID));

  const survivors = [...byUidB.values()];
  const absorbed = lost.map((l) => ({ lost: l, ...explainLoss(l, survivors) }));

  const explained = absorbed.filter((x) => x.status !== "unexplained");
  const unexplained = absorbed.filter((x) => x.status === "unexplained");

  // Structural risk, independent of the diff: ANY group of >=2 events sharing one PROVISIONAL place
  // and instant in the NEW file, merged or not. A city-level provisional place (away games, all-day
  // midnight collisions) turns "same place + same instant" into "anything all-day in this city" —
  // the title veto is the only guard once a second source lands there. Scanned on the new file
  // because a refused group keeps its full original membership (dedupe.ts pushes the ORIGINAL group
  // on every refusal), so this is not an approximation of the pre-dedupe corpus, it IS it.
  const provisionalGroups = new Map();
  for (const e of survivors) {
    if (!isProvisional(e)) continue;
    const key = `${e["X-PLACE-ID"]}|${instantOf(e)}`;
    const arr = provisionalGroups.get(key);
    if (arr) arr.push(e);
    else provisionalGroups.set(key, [e]);
  }
  const provisionalRisk = [...provisionalGroups.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([key, members]) => {
      const sources = members.map((m) => decodeEntities(unescapeIcsText(m["X-SOURCE-NAME"] ?? "")));
      const crossSource = new Set(sources).size > 1;
      let minSim = 1;
      for (let i = 0; i < members.length; i++)
        for (let j = i + 1; j < members.length; j++)
          minSim = Math.min(minSim, titleSimilarity(titleOf(members[i]), titleOf(members[j])));
      return { key, members, sources, crossSource, minSim };
    });

  // Source-completeness caveat: any ENABLED source credited zero times anywhere in the new file (as
  // primary OR corroborator) had a degraded fetch on this run. A clean diff against a degraded fetch
  // is not evidence of safety — it is evidence that the multi-member groups a missing source would
  // have created never existed to be tested.
  const creditedInNew = new Set();
  for (const e of survivors) for (const s of sourceSetOf(e)) creditedInNew.add(s);
  const missingSources = SOURCES.filter((s) => s.enabled && !creditedInNew.has(s.name)).map((s) => s.name);

  return {
    baselineCount: a.length,
    newCount: b.length,
    absorbed,
    explained,
    unexplained,
    changedUid,
    gained,
    provisionalRisk,
    missingSources,
  };
}

/** The merge-count bound, factored out so the CLI's own gate condition is directly testable. */
export function exceedsBound(d, maxMerges) {
  return d.absorbed.length > maxMerges;
}

/** True when the diff overall must fail CI — every reason, not just the bound. */
export function isFailing(d, maxMerges) {
  return d.unexplained.length > 0 || d.gained.length > 0 || d.changedUid.length > 0 || exceedsBound(d, maxMerges);
}

// --- risk ranking: provisional-place merges first, then low-similarity, then the rest -----------
function riskRank(x) {
  const provisional = x.wouldBePlace?.provisional === true;
  const sim = x.similarity ?? (x.status === "title" ? 1 : 0.5); // title-pass has no score; mid-rank unexplained
  return [provisional ? 0 : 1, sim, x.lost.SUMMARY ?? ""];
}

function fmtEv(e) {
  return `"${titleOf(e)}" [${decodeEntities(unescapeIcsText(e["X-SOURCE-NAME"] ?? "?"))}]`;
}

function printReport(d, maxMerges) {
  console.log(`baseline ${d.baselineCount} -> new ${d.newCount}  (${d.absorbed.length} absorbed)\n`);

  if (d.missingSources.length) {
    console.log(`!! SOURCE COMPLETENESS WARNING !!`);
    console.log(`   The following ENABLED source(s) are credited ZERO times in the NEW feed:`);
    for (const s of d.missingSources) console.log(`     - ${s}`);
    console.log(`   A clean diff from a degraded fetch is NOT evidence of safety: a missing source`);
    console.log(`   removes exactly the multi-member place-and-instant groups where a false merge`);
    console.log(`   would occur. The false-merge RATE is under-tested, not merely the yield.\n`);
  }

  if (d.provisionalRisk.length) {
    console.log(`!! PROVISIONAL-PLACE STRUCTURAL RISK !!`);
    console.log(`   ${d.provisionalRisk.length} group(s) of >=2 events share one PROVISIONAL place + instant`);
    console.log(`   in the new feed. City-level provisional places (away games, all-day midnight) can`);
    console.log(`   degenerate to "anything on this date in this city" — the title veto is the only guard.`);
    const sorted = [...d.provisionalRisk].sort((a, b) => a.minSim - b.minSim);
    for (const g of sorted) {
      const flag = g.crossSource ? "CROSS-SOURCE" : "same-source (refused)";
      console.log(`     [${flag}, min title-sim ${g.minSim.toFixed(3)}] ${g.key}`);
      for (const m of g.members) console.log(`       - ${fmtEv(m)}`);
    }
    console.log();
  }

  const ranked = [...d.absorbed].sort((a, b) => {
    const ra = riskRank(a), rb = riskRank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    return String(ra[2]).localeCompare(String(rb[2]));
  });

  for (const x of ranked) {
    const provisionalFlag = x.wouldBePlace?.provisional ? " [PROVISIONAL PLACE]" : "";
    console.log(`ABSORBED  ${fmtEv(x.lost)}${provisionalFlag}`);
    if (x.status === "unexplained") {
      console.log(`   !! UNEXPLAINED — no Phase-3-consistent survivor found. Investigate before shipping.`);
    } else {
      console.log(`   INTO   ${fmtEv(x.survivor)}`);
      console.log(`   place: ${x.wouldBePlace?.id ?? "(none)"} "${x.wouldBePlace?.name ?? ""}"  provisional=${x.wouldBePlace?.provisional ?? "n/a"}`);
      console.log(`   instant: ${new Date(instantOf(x.lost)).toISOString()}`);
      console.log(`   explained via: ${x.status === "place" ? "PLACE pass" : "TITLE fallback (pass 2)"}`);
      if (x.status === "place") console.log(`   title-similarity: ${x.similarity.toFixed(3)}  (veto is ${TITLE_VETO})`);
    }
    console.log();
  }

  if (d.changedUid.length) {
    console.error(`--- CHANGED UID (FAIL — same title+instant, different UID; a makeUid() input moved) ---`);
    for (const x of d.changedUid) console.error(`  ${x.lost.UID} -> ${x.gained.UID}  "${titleOf(x.lost)}"`);
    console.error();
  }
  if (d.gained.length) {
    console.error(`--- GAINED events (FAIL) ---`);
    for (const g of d.gained) console.error(`  ${g.UID}  "${titleOf(g)}"`);
    console.error();
  }

  console.log(`--- verdict ---`);
  console.log(`merges: ${d.absorbed.length}  (${d.explained.length} explained, ${d.unexplained.length} unexplained)`);
  console.log(`provisional-place merges: ${d.absorbed.filter((x) => x.wouldBePlace?.provisional).length}`);
  console.log(`provisional-place structural-risk groups: ${d.provisionalRisk.length}`);

  const bound = exceedsBound(d, maxMerges);
  const fail = isFailing(d, maxMerges);

  if (bound) {
    console.error(`\nFAIL: ${d.absorbed.length} merges exceeds the bound of ${maxMerges}.`);
    console.error(`Either the registry gained a bad alias, or raise the bound deliberately.`);
  }
  if (d.unexplained.length) console.error(`\nFAIL: ${d.unexplained.length} unexplained loss(es) — read them above.`);
  if (d.gained.length) console.error(`FAIL: ${d.gained.length} gained event(s) — Phase 3 must not add events on a diff run.`);
  if (d.changedUid.length) console.error(`FAIL: ${d.changedUid.length} changed UID(s).`);

  if (!fail) console.log(`\nWithin bound (${d.absorbed.length}/${maxMerges}). A human must still confirm every line above.`);
  return fail;
}

// --- CLI entry point ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [baselinePath, newPath] = process.argv.slice(2);
  const maxMerges = Number(process.argv[4] ?? 20);
  if (!baselinePath || !newPath) {
    console.error("Usage: tsx scripts/merge-diff.mjs <baseline.ics> <new.ics> [maxMerges]");
    process.exit(2);
  }
  const a = parseIcs(baselinePath);
  const b = parseIcs(newPath);
  const d = diff(a, b);
  const fail = printReport(d, maxMerges);
  process.exit(fail ? 1 : 0);
}
