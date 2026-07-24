import { describe, it, expect } from "vitest";
import { dedupe } from "../src/dedupe.js";
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
