import { describe, it, expect } from "vitest";
import { classifyEventType, isMultiDay, finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";

describe("classifyEventType", () => {
  it("maps titles to canonical types", () => {
    expect(classifyEventType("Live music tonight at Pizza Lucé")).toBe("live-music");
    expect(classifyEventType("City Council Meeting")).toBe("meeting");
    expect(classifyEventType("Intro to Paddling — beginner class")).toBe("class");
    expect(classifyEventType("Lincoln Park Farmers Market")).toBe("market");
    expect(classifyEventType("Homegrown Music Festival")).toBe("festival");
    expect(classifyEventType("Bulldogs Hockey vs. Denver")).toBe("sports");
  });
  it("falls back to community when nothing matches", () => {
    expect(classifyEventType("Neighborhood gathering")).toBe("community");
  });
  it("uses categories as a hint", () => {
    expect(classifyEventType("Untitled", ["live music"])).toBe("live-music");
  });

  // --- corpus regressions (docs/tagging-rubrics.md) ---
  it("prefers an unambiguous source category over the title regex", () => {
    // 137 UMD athletics rows carry these categories; the away-game titles have no "vs".
    expect(classifyEventType("University of Minnesota Duluth Soccer at Michigan Tech", ["Athletics", "Sports and Recreation"])).toBe("sports");
    expect(classifyEventType("Anything at all", ["Board Meetings"])).toBe("meeting");
  });
  it("types away games as sports even without categories", () => {
    // sports vocabulary previously lacked soccer/volleyball/football -> 36 games fell through to education
    expect(classifyEventType("University of Minnesota Duluth Volleyball at Bemidji State University")).toBe("sports");
    expect(classifyEventType("University of Minnesota Duluth Football at Wayne State College")).toBe("sports");
    expect(classifyEventType("University of Minnesota Duluth Men's Cross Country at River Town Invitational")).toBe("sports");
  });
  it("decodes HTML entities in categories before matching", () => {
    expect(classifyEventType("Untitled", ["Food &amp; Drink"])).toBe("food-drink");
  });
  it("does not let an audience category become a type", () => {
    // "Family-Friendly" is a facet; keying the type to it is what emptied family.ics
    expect(classifyEventType("Sunset Dinner Cruise on Lake Superior", ["Family-Friendly", "Food &amp; Drink"])).toBe("food-drink");
  });
  it("resists the corpus false positives", () => {
    expect(classifyEventType("Rumours: The Ultimate Fleetwood Mac Tribute Show")).not.toBe("sports");
    expect(classifyEventType("Board Games")).not.toBe("meeting");
    expect(classifyEventType("Crip Camp: A Disability Revolution")).not.toBe("class");
  });
});

describe("isMultiDay", () => {
  it("is false for a same-day event", () => {
    expect(isMultiDay("2026-08-10T16:00:00-05:00", "2026-08-10T20:00:00-05:00")).toBe(false);
  });
  it("is true when the span crosses days", () => {
    expect(isMultiDay("2026-08-10T16:00:00-05:00", "2026-09-14T20:00:00-05:00")).toBe(true);
  });
  it("is NOT driven by recurrence — weekly karaoke is 52 single evenings", () => {
    const e = finalizeEvent(makeEvent({ title: "Karaoke", rrule: "FREQ=WEEKLY", start: "2026-08-10T22:00:00-05:00", end: "2026-08-11T02:00:00-05:00" }));
    expect(e.facets.recurring).toBe(true);
    const sameDay = finalizeEvent(makeEvent({ title: "Karaoke", rrule: "FREQ=WEEKLY", start: "2026-08-10T18:00:00-05:00", end: "2026-08-10T21:00:00-05:00" }));
    expect(sameDay.multiDay).toBe(false);
    expect(sameDay.facets.recurring).toBe(true);
  });
});

describe("away-game location (formerly resolveLocation)", () => {
  it("puts an out-of-state game outside Duluth proper", () => {
    const e = finalizeEvent(
      makeEvent({
        title: "University of Minnesota Duluth Volleyball at Colorado State University Pueblo",
        categories: ["Athletics", "Sports and Recreation"],
        venueRaw: "Pueblo, CO, Massari Arena",
        location: { city: "Duluth", state: "MN" },
      }),
    );
    expect(e.eventType).toBe("sports");
    expect(e.location.city).toBe("Pueblo");
    expect(e.location.state).toBe("CO");
    expect(e.location.inDuluth).toBe(false);
    expect(e.facets.geoScope).toBe("distant");
    expect(e.facets.homeAway).toBe("away");
    expect(e.place?.name).toBe("Massari Arena");
  });

  it("handles AP-style abbreviations", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "St. Cloud, Minn., Herb Brooks National Hockey Center", location: { city: "Duluth", state: "MN" } }));
    expect(e.location.city).toBe("St. Cloud");
    expect(e.location.state).toBe("MN");
  });

  it("leaves an ordinary venue's stated address alone", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "Lake Superior Estuarium", location: { city: "Superior", state: "WI", inDuluth: false } }));
    expect(e.location.city).toBe("Superior");
    expect(e.place?.id).toBe("lake-superior-estuarium");
  });
});

describe("finalizeEvent", () => {
  it("classifies a still-default event and derives multiDay", () => {
    const e = finalizeEvent(makeEvent({ title: "Live music at the Rex" }));
    expect(e.eventType).toBe("live-music");
    expect(e.multiDay).toBe(false);
  });
  it("does not override an explicit eventType", () => {
    const e = finalizeEvent(makeEvent({ title: "Anything", eventType: "meeting" }));
    expect(e.eventType).toBe("meeting");
  });
  it("keeps an out-of-town game out of Duluth proper", () => {
    const e = finalizeEvent(
      makeEvent({
        title: "University of Minnesota Duluth Volleyball at Colorado State University Pueblo",
        categories: ["Athletics", "Sports and Recreation"],
        venueRaw: "Pueblo, CO, Massari Arena",
        location: { city: "Duluth", state: "MN" },
      }),
    );
    expect(e.eventType).toBe("sports");
    expect(e.location.inDuluth).toBe(false);
    expect(e.facets.geoScope).toBe("distant");
    expect(e.facets.homeAway).toBe("away");
  });
  it("backfills age and ticketUrl the source only stated in prose", () => {
    const e = finalizeEvent(
      makeEvent({ title: "Kids Clay Camp", description: "For ages 6-10. Tickets at https://www.eventbrite.com/e/clay-123456 — space is limited." }),
    );
    expect(e.age).toEqual({ allAges: false, minAge: 6, maxAge: 10 });
    expect(e.ticketUrl).toBe("https://www.eventbrite.com/e/clay-123456");
    expect(e.facets.registration).toBe("required");
  });
  it("marks a rescheduled title tentative", () => {
    const e = finalizeEvent(makeEvent({ title: "Concerts on the Pier (Rescheduled date)" }));
    expect(e.facets.rescheduled).toBe(true);
    expect(e.status).toBe("tentative");
  });
});

describe("finalizeEvent place resolution", () => {
  it("resolves a registered venue and preserves the raw claim", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe" }));
    expect(e.place?.id).toBe("wussows-concert-cafe");
    expect(e.place?.provisional).toBe(false);
    expect(e.venueRaw).toBe("Wussow's Concert Cafe");
  });

  it("leaves place undefined for a sentinel venue", () => {
    expect(finalizeEvent(makeEvent({ venueRaw: "See listing" })).place).toBeUndefined();
  });
});
