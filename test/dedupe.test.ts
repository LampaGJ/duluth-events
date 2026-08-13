import { describe, it, expect } from "vitest";
import { dedupe } from "../src/dedupe.js";
import { finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";

describe("dedupe (fuzzy merge)", () => {
  it("merges the same event from two sources, keeping the highest-confidence copy as primary", () => {
    const pdd = makeEvent();
    const decc = makeEvent({
      uid: "the-decc:xyz@duluth-events",
      source: {
        name: "The DECC",
        type: "html-calendar",
        url: "https://decc.org/events-calendar/",
        extractionMethod: "html-scrape",
        retrievedAt: "2026-04-20T09:00:00-05:00",
        confidence: "medium",
      },
    });
    // DECC listed first to prove the sort (by confidence) not input order decides the primary.
    const out = dedupe([decc, pdd]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.name).toBe("Perfect Duluth Day"); // high beats medium
    expect(out[0]!.alsoListedIn.map((s) => s.name)).toContain("The DECC");
  });

  it("keeps distinct events (different titles, same day/venue) separate", () => {
    const a = makeEvent({ title: "Jazz Night" });
    const b = makeEvent({ uid: "perfect-duluth-day:def@duluth-events", title: "Punk Matinee" });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("passes a single event through untouched", () => {
    const out = dedupe([makeEvent()]);
    expect(out).toHaveLength(1);
    expect(out[0]!.alsoListedIn).toEqual([]);
  });

  it("dedupes corroborators by source name (no repeated X-ALSO-LISTED-IN)", () => {
    const doD = { name: "Do Duluth", type: "json-api" as const, url: "https://doduluth.com/wp-json/tribe/events/v1/events", extractionMethod: "structured-api" as const, retrievedAt: "2026-04-20T09:00:00-05:00", confidence: "medium" as const };
    const pdd = makeEvent();
    const doD1 = makeEvent({ uid: "a@x", source: doD });
    const doD2 = makeEvent({ uid: "b@x", source: doD }); // same event, same source, twice
    const out = dedupe([pdd, doD1, doD2]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.name).toBe("Perfect Duluth Day");
    expect(out[0]!.alsoListedIn.map((s) => s.name)).toEqual(["Do Duluth"]); // once, not twice
  });
});

/**
 * These two pin `fuzzyKey`'s `e.place?.name ?? e.venueRaw` branch — the ONE behavioural change in the
 * LocationSchema→AddressSchema migration, and the mechanism the whole Place epic exists to deliver.
 * Every test above builds fixtures straight from `makeEvent()` (no `place`, never finalized), so all
 * of them exercise only the `venueRaw` fallback: deleting `e.place?.name ??` outright left them all
 * green. Both cases below therefore run their fixtures through `finalizeEvent` first, which is what
 * `pipeline.ts` does before calling `dedupe`.
 */
describe("dedupe keys on resolved place identity", () => {
  const doDuluth = {
    name: "Do Duluth",
    type: "json-api" as const,
    url: "https://doduluth.com/wp-json/tribe/events/v1/events",
    extractionMethod: "structured-api" as const,
    retrievedAt: "2026-04-20T09:00:00-05:00",
    confidence: "medium" as const,
  };

  it("merges an address-only listing with a name listing of the same show (the Bent Paddle case)", () => {
    // The real corpus pair: "Buffalo Galaxy" on 2026-07-25 was published by one aggregator under the
    // venue's NAME and by another under its STREET ADDRESS ONLY. The two strings share not one token,
    // so no string-similarity threshold could ever merge them — only place identity can.
    const byName = finalizeEvent(makeEvent({ title: "Buffalo Galaxy", venueRaw: "Bent Paddle Brewing" }));
    const byAddress = finalizeEvent(makeEvent({ uid: "do-duluth:99@duluth-events", title: "Buffalo Galaxy", venueRaw: "1832 W Michigan St", source: doDuluth }));

    // Precondition, not the assertion under test: both raw forms resolve to one registered place.
    expect(byName.place?.id).toBe("bent-paddle-taproom");
    expect(byAddress.place?.id).toBe("bent-paddle-taproom");

    // NOT a diagnostic for fuzzyKey's `e.place?.name` branch: both events resolve to the same place
    // id at the same instant, cross-source, so pass 1 (place identity) merges this pair regardless of
    // what fuzzyKey does — dropping `e.place?.name ??` from fuzzyKey entirely still leaves this line
    // passing. This test instead pins pass 1's place-identity merge on its own (an address-only
    // listing and a name-only listing of one show, resolved to one place, correctly collapse). The
    // assertion that genuinely fails if `e.place?.name ??` is dropped from fuzzyKey is
    // test/place-dedupe.test.ts's "keeps fuzzyKey's place-identity branch load-bearing at a DIFFERENT
    // time on the same day" — same two venue strings, but at different clock times so only pass 2
    // (the title fallback, which is what fuzzyKey feeds) can merge them.
    const out = dedupe([byName, byAddress]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.name).toBe("Perfect Duluth Day"); // high beats medium
    expect(out[0]!.alsoListedIn.map((s) => s.name)).toEqual(["Do Duluth"]);
  });

  it("leaves sentinel venues on the venueRaw fallback, grouping exactly as before the rewrite", () => {
    const a = finalizeEvent(makeEvent({ title: "Community Potluck", venueRaw: "See listing" }));
    const b = finalizeEvent(makeEvent({ uid: "do-duluth:100@duluth-events", title: "Community Potluck", venueRaw: "See listing", source: doDuluth }));

    // A sentinel resolves to NO place, so the new key falls through to `venueRaw` — and for a
    // pure-ASCII, entity-free, paren-free, apostrophe-free string, normalizeVenueKey and the old raw
    // strip produce byte-identical output ("seelisting"). Sentinel grouping therefore cannot move.
    expect(a.place).toBeUndefined();
    expect(b.place).toBeUndefined();
    expect(dedupe([a, b])).toHaveLength(1); // same as the pre-migration key produced
  });
});

/**
 * Regression: a recurring same-day session series must survive pass 2. Measured against the live
 * Excalibur Con pull (2026-08-12) — 11 of 102 convention sessions were being deleted before the
 * `splitSameSourceSeries` refusal existed.
 */
describe("dedupe keeps a same-day session series intact", () => {
  const con = {
    name: "Excalibur Con",
    type: "json-api" as const,
    url: "https://www.eventeny.com/events/embed/?ev=24183&type=schedule",
    extractionMethod: "structured-api" as const,
    retrievedAt: "2026-08-12T09:00:00-05:00",
    confidence: "high" as const,
  };
  /** The real series: hourly sittings of one activity at one venue on one day. */
  const sitting = (hour: number) =>
    finalizeEvent(
      makeEvent({
        uid: `excalibur-con:artemis-${hour}@duluth-events`,
        title: "Artemis Experience",
        start: `2026-08-15T${String(hour).padStart(2, "0")}:30:00-05:00`,
        end: `2026-08-15T${String(hour + 1).padStart(2, "0")}:30:00-05:00`,
        venueRaw: "Duluth Entertainment Convention Center",
        source: con,
      }),
    );

  it("keeps all seven hourly sittings rather than collapsing them into one", () => {
    const series = [11, 12, 13, 14, 15, 16, 17].map(sitting);
    const out = dedupe(series);
    expect(out).toHaveLength(7);
    expect(new Set(out.map((e) => e.start)).size).toBe(7);
  });

  it("still folds two identical sittings at the SAME instant", () => {
    // Two tables of one game at one clock time are indistinguishable to a subscriber, so they merge.
    const out = dedupe([sitting(14), { ...sitting(14), uid: "excalibur-con:artemis-14b@duluth-events" }]);
    expect(out).toHaveLength(1);
  });

  it("still merges two sources stating different times for one event (no series present)", () => {
    // The split must not fire when no source repeats — this is pass 2's ordinary job and it stays.
    const mine = finalizeEvent(makeEvent({ title: "Homegrown Kickoff Show", start: "2026-05-01T19:00:00-05:00" }));
    const theirs = finalizeEvent(
      makeEvent({
        uid: "do-duluth:501@duluth-events",
        title: "Homegrown Kickoff Show",
        start: "2026-05-01T19:30:00-05:00",
        source: { ...con, name: "Do Duluth", confidence: "medium" as const },
      }),
    );
    expect(dedupe([mine, theirs])).toHaveLength(1);
  });
});
