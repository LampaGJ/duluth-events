import { describe, it, expect } from "vitest";
import { diff, instantOf, exceedsBound, isFailing, venueOf, cityOf } from "../scripts/merge-diff.mjs";

/**
 * `diff()` consumes the SAME flat property-map shape `parseIcs()` produces (see
 * scripts/verify-phase1.mjs), so fixtures are built directly as those maps rather than through real
 * ICS text — faster, and it keeps every fixture's intent legible at the call site. `LOCATION` values
 * below use real registry venues (e.g. "Wussow's Concert Cafe") so `resolvePlace()` — the actual
 * production function `diff()` calls, never a stub — resolves them exactly as the live pipeline
 * would.
 */
const ev = (over: Record<string, string | undefined>) => ({
  UID: "uid",
  DTSTART: "20260810T230000Z",
  SUMMARY: "Buffalo Galaxy Live at the Taproom",
  LOCATION: "Wussow's Concert Cafe",
  "X-SOURCE-NAME": "Source A",
  ...over,
});

describe("merge-diff: instantOf", () => {
  it("parses a timed UTC DTSTART", () => {
    expect(instantOf(ev({ DTSTART: "20260810T230000Z" }))).toBe(Date.parse("2026-08-10T23:00:00Z"));
  });

  it("parses a bare-DATE all-day DTSTART as that date's UTC midnight", () => {
    expect(instantOf(ev({ DTSTART: "20261023" }))).toBe(Date.parse("2026-10-23T00:00:00Z"));
  });

  it("returns null for a missing or malformed DTSTART", () => {
    expect(instantOf(ev({ DTSTART: undefined }))).toBeNull();
    expect(instantOf(ev({ DTSTART: "not-a-date" }))).toBeNull();
  });
});

/**
 * Item D (final review): `venueOf`/`cityOf`'s segment math was previously exercised only by
 * single-bare-segment fixtures ("Wussow's Concert Cafe") — the split is never invoked, so the review
 * mutation-proved that `venueOf` ignoring the split entirely, `cityOf` reading the LAST segment
 * instead of second-to-last, and `cityOf` returning `undefined` unconditionally ALL passed 208/208.
 *
 * `LOCATION` is `src/emit.ts`'s `formatLocation`: `[venue, room?, street?, cityLine].filter(Boolean)`
 * joined by ", ", where `cityLine` is itself `"${city}, ${state}${zip ? ' ' + zip : ''}"`. Because
 * `cityLine` is ONE array element that itself contains a comma, the FINAL joined string always has
 * state(+zip) as its last comma-segment and city as its second-to-last, regardless of how many
 * optional segments (room, street) preceded them — and regardless of whether the venue name itself
 * happens to contain a comma. These fixtures build real multi-segment LOCATION strings the way
 * `formatLocation` actually produces them, so the split is genuinely exercised.
 */
describe("merge-diff: venueOf / cityOf segment math (Task-11b M2)", () => {
  it("extracts venue and city from a full location: venue, room, street, city, state+zip", () => {
    const e = ev({ LOCATION: "AMSOIL Arena, Section 108, 350 Harbor Dr, Duluth, MN 55802" });
    expect(venueOf(e)).toBe("AMSOIL Arena");
    expect(cityOf(e)).toBe("Duluth");
  });

  it("still finds the city when zip is ABSENT (state alone is the last segment)", () => {
    const e = ev({ LOCATION: "AMSOIL Arena, Section 108, 350 Harbor Dr, Duluth, MN" });
    expect(venueOf(e)).toBe("AMSOIL Arena");
    expect(cityOf(e)).toBe("Duluth");
  });

  it("still finds venue and city when the STREET segment is missing (venue, city, state+zip)", () => {
    const e = ev({ LOCATION: "Bent Paddle Taproom, Duluth, MN 55807" });
    expect(venueOf(e)).toBe("Bent Paddle Taproom");
    expect(cityOf(e)).toBe("Duluth");
  });

  it("cityOf stays correct — indexing from the END — even when the VENUE NAME itself contains a comma", () => {
    // "Zenith Bookstore, Ltd." packs an extra comma into the venue segment. venueOf (indexes from the
    // START, documented as "just the first segment") is truncated by this — a known limitation, not
    // this test's subject. cityOf (indexes from the END) is unaffected by the extra leading segment,
    // which is exactly the property this fixture pins.
    const e = ev({ LOCATION: "Zenith Bookstore, Ltd., 505 W Superior St, Duluth, MN 55802" });
    expect(venueOf(e)).toBe("Zenith Bookstore"); // truncated at the comma — first segment only, by design
    expect(cityOf(e)).toBe("Duluth"); // unaffected by the extra segment; still second-to-last
  });

  it("cityOf returns undefined for a single bare segment (no comma at all) — not a false city", () => {
    const e = ev({ LOCATION: "Wussow's Concert Cafe" });
    expect(venueOf(e)).toBe("Wussow's Concert Cafe");
    expect(cityOf(e)).toBeUndefined();
  });
});

describe("merge-diff: diff() classification", () => {
  it("explains a PLACE-pass merge and reports the real titleSimilarity score", () => {
    const lost = ev({ UID: "lost", SUMMARY: "Buffalo Galaxy at the Taproom", "X-SOURCE-NAME": "Source A" });
    const survivor = ev({
      UID: "survivor",
      SUMMARY: "Buffalo Galaxy",
      "X-SOURCE-NAME": "Source B",
      "X-ALSO-LISTED-IN": "Source A",
      "X-PLACE-ID": "wussows-concert-cafe",
      "X-PLACE-NAME": "Wussow's Concert Cafe",
      "X-PLACE-PROVISIONAL": "false",
    });
    const d = diff([lost], [survivor]);
    expect(d.absorbed).toHaveLength(1);
    expect(d.explained).toHaveLength(1);
    expect(d.unexplained).toHaveLength(0);
    expect(d.absorbed[0]!.status).toBe("place");
    expect(d.absorbed[0]!.wouldBePlace?.id).toBe("wussows-concert-cafe");
    expect(d.absorbed[0]!.wouldBePlace?.provisional).toBe(false);
    expect(d.absorbed[0]!.similarity).toBeGreaterThan(0.15); // the real veto threshold
  });

  it("does NOT explain a same-place-same-instant loss whose credited source never touched the survivor", () => {
    // Same place + instant, but the survivor's provenance (primary + X-ALSO-LISTED-IN) never
    // mentions "Source A" — a coincidence, not evidence dedupe() actually merged this pair. Must
    // refuse to explain it rather than trust the place/instant match alone. Titles are deliberately
    // HIGH-similarity (same shape as the passing "explains a PLACE-pass merge" test above, well
    // clear of TITLE_VETO) and non-identical, so this fixture isolates the source-credit guard
    // specifically: if that guard were ever deleted, title similarity alone would let this pair
    // through as "explained", and it must not — while an identical-title pair would instead trip
    // the CHANGED-UID path (tested separately), which would mask this guard rather than prove it.
    const lost = ev({ UID: "lost", SUMMARY: "Buffalo Galaxy at the Taproom", "X-SOURCE-NAME": "Source A" });
    const survivor = ev({
      UID: "survivor",
      SUMMARY: "Buffalo Galaxy",
      "X-SOURCE-NAME": "Source B",
      "X-ALSO-LISTED-IN": "Source C",
      "X-PLACE-ID": "wussows-concert-cafe",
      "X-PLACE-NAME": "Wussow's Concert Cafe",
      "X-PLACE-PROVISIONAL": "false",
    });
    const d = diff([lost], [survivor]);
    expect(d.unexplained).toHaveLength(1);
    expect(d.explained).toHaveLength(0);
  });

  it("REJECTS a same-place-same-instant, credited-source pair below TITLE_VETO — real dedupe() could not have produced it", () => {
    // The corpus's own tightest confirmed non-duplicate (src/dedupe.ts's TITLE_VETO comment):
    // "Fall Volunteer and Engagement Fair" vs "Two Harbors Fall Colors Tour" scores 0.125, below the
    // 0.15 veto. Same place, same instant, and the survivor's X-ALSO-LISTED-IN even credits the lost
    // event's source — every OTHER signal says "explained" — but shipped dedupe() would have vetoed
    // this pair and left both events standing, so trusting the place/instant coincidence here would
    // be exactly the over-explaining failure mode that made phase1MergeExplanationKey unsafe to reuse.
    const lost = ev({ UID: "lost", SUMMARY: "Fall Volunteer and Engagement Fair", "X-SOURCE-NAME": "Source A" });
    const survivor = ev({
      UID: "survivor",
      SUMMARY: "Two Harbors Fall Colors Tour",
      "X-SOURCE-NAME": "Source B",
      "X-ALSO-LISTED-IN": "Source A",
      "X-PLACE-ID": "wussows-concert-cafe",
      "X-PLACE-NAME": "Wussow's Concert Cafe",
      "X-PLACE-PROVISIONAL": "false",
    });
    const d = diff([lost], [survivor]);
    expect(d.unexplained).toHaveLength(1);
    expect(d.explained).toHaveLength(0);
  });

  it("flags a GAINED event (present in new, absent from baseline) as a failure", () => {
    const survivor = ev({ UID: "keeps" });
    const gained = ev({ UID: "new-uid", SUMMARY: "Something Brand New" });
    const d = diff([survivor], [survivor, gained]);
    expect(d.gained).toHaveLength(1);
    expect(d.gained[0]!.UID).toBe("new-uid");
    expect(isFailing(d, 100)).toBe(true);
  });

  it("flags a CHANGED UID (same title+instant, different UID) distinctly from an ordinary gain", () => {
    const lost = ev({ UID: "old-uid", SUMMARY: "Renamed Event", DTSTART: "20260810T230000Z" });
    const gained = ev({ UID: "new-uid", SUMMARY: "Renamed Event", DTSTART: "20260810T230000Z" });
    const d = diff([lost], [gained]);
    expect(d.changedUid).toHaveLength(1);
    expect(d.changedUid[0]!.lost.UID).toBe("old-uid");
    expect(d.changedUid[0]!.gained.UID).toBe("new-uid");
    expect(d.gained).toHaveLength(0); // consumed by the rename match, not double-counted
    expect(d.absorbed).toHaveLength(0); // not counted as a merge either
    expect(isFailing(d, 100)).toBe(true);
  });

  it("flags an enabled source credited zero times in the new feed — the Do Duluth carry-forward", () => {
    // Task 10's own measurement ran with Do Duluth HTTP 500/503 for both fetches. It is the
    // highest-overlap aggregator, so its absence removes exactly the multi-member place-and-instant
    // groups where a false merge would occur — a clean diff from a degraded fetch is not evidence of
    // safety. This must show up in the TOOL'S output, not only be asserted in prose, so pin it here.
    const survivor = ev({ UID: "keeps", "X-SOURCE-NAME": "Perfect Duluth Day" });
    const d = diff([survivor], [survivor]);
    expect(d.missingSources).toContain("Do Duluth");
    // Perfect Duluth Day WAS credited (as the sole event's primary source), so it must not be
    // flagged — this is what proves the check reads real credited-source data, not a static list.
    expect(d.missingSources).not.toContain("Perfect Duluth Day");
  });

  it("flags a provisional-place structural-risk group even when nothing merged", () => {
    const a = ev({
      UID: "a",
      SUMMARY: "UMD Men's Cross Country at Winona State Classic",
      DTSTART: "20261023",
      "X-SOURCE-NAME": "UMD Events",
      "X-PLACE-ID": "~winona",
      "X-PLACE-NAME": "Winona",
      "X-PLACE-PROVISIONAL": "true",
    });
    const b = ev({
      UID: "b",
      SUMMARY: "UMD Women's Cross Country at Winona State Classic",
      DTSTART: "20261023",
      "X-SOURCE-NAME": "UMD Events",
      "X-PLACE-ID": "~winona",
      "X-PLACE-NAME": "Winona",
      "X-PLACE-PROVISIONAL": "true",
    });
    // Same baseline and new — nothing was absorbed — the risk group is a property of ONE feed, not
    // of a diff between two.
    const d = diff([a, b], [a, b]);
    expect(d.absorbed).toHaveLength(0);
    expect(d.provisionalRisk).toHaveLength(1);
    expect(d.provisionalRisk[0]!.crossSource).toBe(false);
  });
});

describe("merge-diff: the merge-count bound", () => {
  // Reference corpus (Task 10, on-disk snapshots): the incremental place-identity merge delta
  // measured 4 on both independent snapshots. The bound exists so a FUTURE registry edit that
  // suddenly collapses many more events trips this gate instead of shipping quietly.
  const survivors = (n: number) =>
    Array.from({ length: n }, (_, i) => ev({ UID: `s${i}`, DTSTART: `2026081${i}T230000Z` }));

  it("passes when absorbed count is at or under the bound", () => {
    const baseline = [...survivors(3), ev({ UID: "lost1" }), ev({ UID: "lost2" })];
    const now = survivors(3);
    const d = diff(baseline, now);
    expect(d.absorbed.length).toBeLessThanOrEqual(2);
    expect(exceedsBound(d, 2)).toBe(false);
  });

  it("fails when absorbed count exceeds the bound, independent of explained/unexplained status", () => {
    // Three UNPLACED, unrelated lost events (no LOCATION match survives) — deliberately unexplained,
    // so this proves the bound is checked REGARDLESS of the explained/unexplained split, not only as
    // a side effect of unexplained-loss failing on its own.
    const baseline = [
      ev({ UID: "l1", LOCATION: "", SUMMARY: "Alpha" }),
      ev({ UID: "l2", LOCATION: "", SUMMARY: "Beta" }),
      ev({ UID: "l3", LOCATION: "", SUMMARY: "Gamma" }),
    ];
    const d = diff(baseline, []);
    expect(d.absorbed).toHaveLength(3);
    expect(exceedsBound(d, 2)).toBe(true);
    expect(isFailing(d, 2)).toBe(true);
    // Raising the bound past the count alone would flip the verdict...
    expect(exceedsBound(d, 3)).toBe(false);
    // ...but these three are ALSO unexplained (no survivor at all), so isFailing stays true either
    // way — the bound is one independent failure reason among several, not the only one.
    expect(isFailing(d, 3)).toBe(true);
  });
});
