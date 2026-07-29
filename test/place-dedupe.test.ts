import { describe, it, expect } from "vitest";
import { dedupe, fuzzyKey, titleSimilarity } from "../src/dedupe.js";
import { finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";
import type { DuluthEvent } from "../src/schema.js";

/**
 * Fixtures MUST go through `finalizeEvent` — that is where `resolvePlace` runs, and pass 1 of
 * `dedupe` reads nothing but `e.place`. A bare `makeEvent()` has no place and would silently test
 * only pass 2.
 */
const at = (over: Record<string, unknown>) =>
  finalizeEvent(makeEvent({ start: "2026-08-10T18:00:00-05:00", end: "2026-08-10T21:00:00-05:00", ...over }));

const src = (name: string) => ({
  name,
  type: "ics-feed" as const,
  extractionMethod: "ics-import" as const,
  retrievedAt: "2026-07-28T09:00:00-05:00",
  confidence: "high" as const,
});

/**
 * `finalizeEvent` OVERWRITES `place` with `resolvePlace(e.venueRaw)`, so a `place` passed into
 * `makeEvent` never survives. Any room-level fixture has to be stamped on AFTER finalization.
 */
const inRoom = (e: DuluthEvent, room: string): DuluthEvent => ({ ...e, place: { ...e.place!, room } });

describe("place-first dedupe", () => {
  it("merges the same instant + same place across different sources", () => {
    // Verbatim corpus pair — different titles, different venue spellings, one event.
    const a = at({ uid: "a", title: "High Key Mondays &#038; Industry Nights", venueRaw: "Bent Paddle Brewing", source: src("Visit Duluth") });
    const b = at({ uid: "b", title: "HighKey Mondays + Industry Night!", venueRaw: "Bent Paddle Taproom 1832 W Michigan St.", source: src("Do Duluth") });

    // Precondition, not the assertion: the two venue strings must land on one registered place, and
    // the two titles must NOT collide in pass 2's key — otherwise this would pass without pass 1.
    expect(a.place?.id).toBe("bent-paddle-taproom");
    expect(b.place?.id).toBe("bent-paddle-taproom");

    const merged = dedupe([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.alsoListedIn.map((s) => s.name)).toEqual(["Do Duluth"]);
  });

  it("NEVER merges two events sharing one sentinel venue string at the same instant", () => {
    // The false-merge case that would DELETE an event. Both venues are the SAME sentinel, so any
    // implementation that fell back to venue text instead of a resolved place would collapse them.
    const a = at({ uid: "a", title: "Fall Volunteer and Engagement Fair", venueRaw: "See listing", source: src("UMD Events") });
    const b = at({ uid: "b", title: "Two Harbors Fall Colors Tour", venueRaw: "See listing", source: src("North Shore Scenic Railroad") });
    expect(a.place).toBeUndefined();
    expect(b.place).toBeUndefined();
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("NEVER merges two events at a sentinel-shaped PROVISIONAL place — the ~location-tbd carry-forward", () => {
    // `SENTINELS` matches by prefix, so "Location TBD" (tbd is a SUFFIX) and "Multiple" slip through
    // and resolve to provisional places. Provisional places participate in pass 1, so the title veto
    // is the only guard left. All three strings are live in the corpus today.
    for (const venueRaw of ["Location TBD", "Multiple", "Multiple Locations"]) {
      const a = at({ uid: "a", title: "Fall Volunteer and Engagement Fair", venueRaw, source: src("Duluth Parks & Recreation") });
      const b = at({ uid: "b", title: "Two Harbors Fall Colors Tour", venueRaw, source: src("North Shore Scenic Railroad") });
      // Preconditions: these DO resolve (they are not caught as sentinels) and land on ONE place id.
      expect(a.place?.provisional).toBe(true);
      expect(a.place?.id).toBe(b.place?.id);
      expect(dedupe([a, b]), `${venueRaw} must not merge`).toHaveLength(2);
    }
  });

  it("NEVER merges two events at a city-only provisional place, even with IDENTICAL titles — Task 11b", () => {
    // Before Task 11b, "Winona" and "Winona, MN" both resolved to the SAME provisional place
    // (~winona), so two cross-source events sharing that place + instant would enter pass 1's
    // place-based merge, and identical titles score similarity=1 — comfortably above TITLE_VETO
    // (0.15) — so the veto would NOT have refused them. The city-only rule must refuse regardless of
    // title similarity, by removing the shared place identity outright (place resolves to
    // undefined), not by relying on the veto.
    //
    // The two venueRaw spellings deliberately differ ("Winona" bare vs "Winona, MN" packed) so pass
    // 2's fuzzyKey venue token ALSO differs ("winona" vs "winonamn") — this test is not passing
    // because pass 2 happens to coincide; it is testing that dedupe has NO path left to merge these
    // two events at all once the shared place identity is gone.
    const a = at({
      uid: "a", title: "Cross Country Invitational", venueRaw: "Winona",
      location: { city: "Winona", state: "MN" }, source: src("UMD Events"),
    });
    const b = at({
      uid: "b", title: "Cross Country Invitational", venueRaw: "Winona, MN",
      location: { city: "Duluth", state: "MN" }, source: src("Perfect Duluth Day"),
    });
    // Preconditions: both resolve to NO place (the behavior under test), and the veto would have
    // passed an identical-title pair had a shared place still existed.
    expect(a.place).toBeUndefined();
    expect(b.place).toBeUndefined();
    expect(titleSimilarity(a.title, b.title)).toBe(1);
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("never merges two events from the SAME source at one place and instant", () => {
    // Live corpus shape: Perfect Duluth Day lists two different shows at one venue at 18:00. The
    // titles clear the veto (0.25) and differ in pass 2's key, so ONLY the same-source refusal can
    // keep these apart.
    const a = at({ uid: "a", title: "Trivia Night Wednesday", venueRaw: "Wussow's Concert Cafe", source: src("Do Duluth") });
    const b = at({ uid: "b", title: "Open Mic Wednesday", venueRaw: "Wussow's Concert Cafe", source: src("Do Duluth") });
    expect(titleSimilarity(a.title, b.title)).toBeGreaterThan(0.15); // veto is NOT what refuses here
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("folds a source's own repeated listing, then still merges across sources", () => {
    // Live corpus shape: Perfect Duluth Day emits the planetarium show TWICE under one title while
    // UMD publishes the same show under its own title. The two PDD rows are one listing emitted
    // twice — pass 2's key already collapses them — so they must not be read as "PDD published two
    // different events" and veto the genuine cross-source merge.
    const pdd1 = at({ uid: "a", title: "Wonderstruck Wednesday Planetarium Show", venueRaw: "Marshall W. Alworth Planetarium (MWAP)", source: src("Perfect Duluth Day") });
    const pdd2 = at({ uid: "b", title: "Wonderstruck Wednesday Planetarium Show", venueRaw: "Marshall W. Alworth Planetarium (MWAP)", source: src("Perfect Duluth Day") });
    const umd = at({ uid: "c", title: "Wonderstruck Wednesday: Weird Worlds Planetarium", venueRaw: "Marshall W. Alworth Planetarium (MWAP)", source: src("UMD Events") });
    const out = dedupe([pdd1, pdd2, umd]);
    expect(out).toHaveLength(1);
    expect(out[0]!.alsoListedIn.map((s) => s.name)).toEqual(["UMD Events"]);
  });

  it("does NOT fold two same-source titles that merely share a 6-token prefix", () => {
    // The fold keys on the EXACT title, not `fuzzyKey` (which truncates to 6 title tokens). These two
    // DSSO programmes share their first six tokens and differ only in the soloist, so a fuzzyKey-based
    // fold would treat them as one listing — and then merge that phantom across sources, deleting TWO
    // events. Correct behaviour: the source stays repeated, refusal (b) fires, and pass 2 handles the
    // pair exactly as it does today (2 out, not 1).
    const dsso = "Duluth Superior Symphony Orchestra Summer Series";
    const a = at({ uid: "a", title: `${dsso}: Beethoven`, venueRaw: "Wussow's Concert Cafe", source: src("Perfect Duluth Day") });
    const b = at({ uid: "b", title: `${dsso}: Mozart`, venueRaw: "Wussow's Concert Cafe", source: src("Perfect Duluth Day") });
    const c = at({ uid: "c", title: `Summer Series with the ${dsso}`, venueRaw: "Wussow's Concert Cafe", source: src("Visit Duluth") });
    // Preconditions: the two PDD titles ARE fuzzyKey-identical (6-token truncation) while c's is not,
    // and c clears the veto against both — so the fold key is the only thing that can decide this case.
    expect(fuzzyKey(a)).toBe(fuzzyKey(b));
    expect(fuzzyKey(c)).not.toBe(fuzzyKey(a));
    expect(titleSimilarity(a.title, c.title)).toBeGreaterThan(0.15);
    expect(titleSimilarity(b.title, c.title)).toBeGreaterThan(0.15);
    expect(dedupe([a, b, c])).toHaveLength(2);
  });

  it("does NOT fold a source's two DIFFERENT titles — that refuses the whole group", () => {
    // Same shape as above but the repeated source published two genuinely different events (UMD's
    // men's and women's races at one meet). Refusing costs the cross-source merge with Z; merging
    // would delete a race. 3 in, 3 out.
    const umdMen = at({ uid: "a", title: "UMD Men's Cross Country at River Town Invitational", venueRaw: "Chester Bowl Chalet", source: src("UMD Events") });
    const umdWomen = at({ uid: "b", title: "UMD Women's Cross Country at River Town Invitational", venueRaw: "Chester Bowl Chalet", source: src("UMD Events") });
    const other = at({ uid: "c", title: "UMD Cross Country at River Town Invitational", venueRaw: "Chester Bowl Chalet", source: src("Visit Duluth") });
    expect(dedupe([umdMen, umdWomen, other])).toHaveLength(3);
  });

  it("refuses to merge when both sides state a DIFFERENT room", () => {
    const a = at({ uid: "a", title: "Chamber Orchestra Concert", venueRaw: "Wussow's Concert Cafe", source: src("X") });
    const b = at({ uid: "b", title: "Chamber Orchestra Concert Series", venueRaw: "Wussow's Concert Cafe", source: src("Y") });
    // Control: with no room stated these two DO merge, so the room is the only moving part below.
    expect(dedupe([a, b])).toHaveLength(1);
    expect(dedupe([inRoom(a, "Main"), inRoom(b, "Back")])).toHaveLength(2);
    // One side stating a room is not a conflict, only less specific — that must still merge.
    expect(dedupe([inRoom(a, "Main"), b])).toHaveLength(1);
  });

  it("merges provisional places too — dedupe does not require registration", () => {
    const a = at({ uid: "a", title: "Nordic Ski Swap Preview", venueRaw: "Chester Bowl Chalet", source: src("X") });
    const b = at({ uid: "b", title: "Nordic Ski Swap", venueRaw: "Chester Bowl Chalet", source: src("Y") });
    expect(a.place?.provisional).toBe(true); // precondition: genuinely unregistered
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it("VETOES a merge when titles are near-disjoint — the high-capacity-venue guard", () => {
    // Four unrelated events from four sources at one venue and instant. Real at DECC / AMSOIL /
    // a UMD building. `room` would discriminate but is populated on 0/584 events, so the title
    // veto is the only guard. A false merge here would DELETE three events.
    const evs = ["Symphony Rehearsal", "Craft Vendor Expo", "Job Fair Northland", "Roller Derby Bout"].map((t, i) =>
      at({ uid: `u${i}`, title: t, venueRaw: "Wussow's Concert Cafe", source: src(`Source ${i}`) }),
    );
    expect(dedupe(evs)).toHaveLength(4);
  });

  it("vetoes the WHOLE group when one member is disjoint, not just that member", () => {
    // Two real duplicates plus one unrelated event at the same venue and instant. Merging the pair
    // and keeping the third would be the tempting partial answer; it requires deciding WHICH pair,
    // i.e. using the title as a selector. Refuse everything instead: 3 in, 3 out.
    const a = at({ uid: "a", title: "Buffalo Galaxy at the Taproom", venueRaw: "Wussow's Concert Cafe", source: src("X") });
    const b = at({ uid: "b", title: "Buffalo Galaxy", venueRaw: "Wussow's Concert Cafe", source: src("Y") });
    const c = at({ uid: "c", title: "Toddler Story Hour", venueRaw: "Wussow's Concert Cafe", source: src("Z") });
    expect(dedupe([a, b])).toHaveLength(1); // control: the pair alone merges
    expect(dedupe([a, b, c])).toHaveLength(3);
  });

  it("still merges every confirmed duplicate pair — the veto must not become a selector", () => {
    // Lowest-scoring confirmed pair in the corpus. A 0.5 selector would reject this; the 0.15 veto
    // passes it. The score is asserted directly so a future threshold change fails HERE, loudly.
    const a = at({ uid: "a", title: "High Key Mondays &#038; Industry Nights", venueRaw: "Bent Paddle Brewing", source: src("Visit Duluth") });
    const b = at({ uid: "b", title: "HighKey Mondays + Industry Night!", venueRaw: "Bent Paddle Brewing", source: src("Do Duluth") });
    expect(titleSimilarity(a.title, b.title)).toBeGreaterThanOrEqual(0.25);
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it("does not merge the same place at DIFFERENT instants", () => {
    const a = at({ uid: "a", title: "Nordic Ski Swap Preview", venueRaw: "Wussow's Concert Cafe", source: src("X") });
    const b = at({ uid: "b", title: "Nordic Ski Swap", start: "2026-08-11T18:00:00-05:00", end: "2026-08-11T21:00:00-05:00", venueRaw: "Wussow's Concert Cafe", source: src("Y") });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("groups on the resolved INSTANT, not the offset text two sources happened to write", () => {
    // 18:00-05:00 and 23:00Z are the same moment. Keying on the raw string would miss this merge.
    // Titles differ in pass 2's key, so pass 1 is the only thing that can merge them.
    const a = at({ uid: "a", title: "Buffalo Galaxy at the Taproom", venueRaw: "Wussow's Concert Cafe", source: src("X") });
    const b = at({ uid: "b", title: "Buffalo Galaxy", start: "2026-08-10T23:00:00Z", end: "2026-08-11T02:00:00Z", venueRaw: "Wussow's Concert Cafe", source: src("Y") });
    expect(a.start).not.toBe(b.start);
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it("still merges via the title fallback when neither event has a place", () => {
    const a = at({ uid: "a", title: "Identical Title Here", venueRaw: "See listing", source: src("X") });
    const b = at({ uid: "b", title: "Identical Title Here", venueRaw: "See listing", source: src("Y") });
    // Sentinels give no place, so pass 1 skips them; pass 2's title key still applies.
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it("keeps fuzzyKey's place-identity branch load-bearing at a DIFFERENT time on the same day", () => {
    // Task 6's Bent Paddle test (address-listing vs name-listing, same instant) is now satisfied by
    // pass 1 alone, so it no longer proves `fuzzyKey` reads `e.place?.name`. Same day + same title +
    // DIFFERENT clock time is the case only pass 2 can merge, and only via the place name.
    const byName = at({ uid: "a", title: "Buffalo Galaxy", venueRaw: "Bent Paddle Brewing", source: src("X") });
    const byAddress = at({ uid: "b", title: "Buffalo Galaxy", start: "2026-08-10T19:30:00-05:00", end: "2026-08-10T22:00:00-05:00", venueRaw: "1832 W Michigan St", source: src("Y") });
    expect(byName.place?.id).toBe("bent-paddle-taproom");
    expect(byAddress.place?.id).toBe("bent-paddle-taproom");
    expect(dedupe([byName, byAddress])).toHaveLength(1);
  });
});

describe("titleSimilarity (veto scorer only — never a matcher)", () => {
  it("scores entity-encoded and punctuated spellings of one title well above the veto", () => {
    expect(titleSimilarity("High Key Mondays &#038; Industry Nights", "HighKey Mondays + Industry Night!")).toBeGreaterThanOrEqual(0.25);
  });

  it("scores unrelated titles below the veto even when they share a stray token", () => {
    // Both contain "Fall". This real corpus pair is the tightest measured non-duplicate: 0.125.
    const s = titleSimilarity("Fall Volunteer and Engagement Fair", "Two Harbors Fall Colors Tour");
    expect(s).toBeLessThan(0.15);
    expect(s).toBeGreaterThan(0); // it is a near-miss, not a trivially disjoint pair
  });

  it("is symmetric and returns 1 for identical titles", () => {
    expect(titleSimilarity("Zenith Bookstore Reading", "Zenith Bookstore Reading")).toBe(1);
    expect(titleSimilarity("A Night at the Opera", "Opera Night")).toBe(titleSimilarity("Opera Night", "A Night at the Opera"));
  });

  it("returns 0 — a VETO — when either title carries no scoring token", () => {
    // Deliberate divergence from the task brief's `return 1`. No tokens means no evidence the two
    // events are the same, and absent evidence must refuse. Identical no-token titles still merge
    // downstream via pass 2, whose key IS the title.
    expect(titleSimilarity("5K", "5K")).toBe(0);
    expect(titleSimilarity("", "Zenith Bookstore Reading")).toBe(0);
    expect(titleSimilarity("The Night Music", "Zenith Bookstore Reading")).toBe(0); // all-stopword title
  });

  it("pins the corroborator count when near-identical listings collapse", () => {
    // Four sources listing the SAME event. Titles overlap, so the veto does not fire and all four
    // collapse to one with three corroborators. Pins the count so a future widening is visible.
    const evs = ["Visit Duluth", "Do Duluth", "Perfect Duluth Day", "Duluth Reader"].map((s, i) =>
      at({ uid: `u${i}`, title: "Buffalo Galaxy Live at the Taproom", venueRaw: "Wussow's Concert Cafe", source: src(s) }),
    );
    const merged = dedupe(evs);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.alsoListedIn).toHaveLength(3);
  });
});
