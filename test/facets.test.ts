import { describe, it, expect } from "vitest";
import {
  deriveAccess,
  deriveAlcohol,
  deriveAudience,
  deriveCostTier,
  deriveGeoScope,
  derivePublicAdmission,
  deriveRegistration,
  deriveSetting,
  deriveTimeOfDay,
  deriveWeekend,
  deriveInstitutionalNotice,
  extractLeadingCity,
  extractTicketUrl,
  parseAgeBand,
} from "../src/facets.js";
import { decodeEntities, cleanText, unescapeIcsText } from "../src/normalize.js";

/**
 * Every assertion below quotes a phrase that actually occurs in the deployed corpus
 * (public/feeds/all.ics, 549 events, 2026-07-24). See docs/tagging-rubrics.md.
 */

describe("decodeEntities", () => {
  it("decodes the forms the sources actually emit", () => {
    expect(decodeEntities("Food &amp; Drink")).toBe("Food & Drink");
    expect(decodeEntities("Whole Foods Co-op &#8211; Hillside")).toBe("Whole Foods Co-op – Hillside");
    expect(decodeEntities("Wussow&#8217;s Concert Cafe")).toBe("Wussow’s Concert Cafe");
  });
  it("resolves double encoding", () => {
    expect(decodeEntities("Arts &amp;amp; Culture")).toBe("Arts & Culture");
  });
  it("leaves unknown entities intact rather than mangling them", () => {
    expect(decodeEntities("A &notarealentity; B")).toBe("A &notarealentity; B");
  });
  it("cleanText collapses whitespace too", () => {
    expect(cleanText("  Food &amp;   Drink \n")).toBe("Food & Drink");
  });
});

describe("unescapeIcsText", () => {
  it("undoes each of the three RFC5545 escapes individually", () => {
    expect(unescapeIcsText("A\\,B")).toBe("A,B");
    expect(unescapeIcsText("A\\;B")).toBe("A;B");
    expect(unescapeIcsText("A\\\\B")).toBe("A\\B");
  });
  it("leaves unescaped text untouched", () => {
    expect(unescapeIcsText("no backslashes here")).toBe("no backslashes here");
  });
  it("composes with decodeEntities to resolve double-encoded text (PDD's Wussow's case)", () => {
    // Perfect Duluth Day emits `&amp;#8217\;s`: the escaped `;` masks the entity terminator, so
    // decodeEntities alone can't see it. unescapeIcsText must run FIRST.
    expect(decodeEntities(unescapeIcsText("Wussow&amp;#8217\\;s"))).toBe("Wussow’s");
  });
  it("is idempotent — a second pass over already-unescaped text is a no-op", () => {
    const once = unescapeIcsText("A\\;B\\,C\\\\D");
    expect(unescapeIcsText(once)).toBe(once);
  });
  it("ORDER MATTERS: decoding entities before unescaping leaves the entity intact, but unescaping first resolves it", () => {
    const raw = "Wussow&amp;#8217\\;s";
    // Wrong order: decodeEntities runs first, so the `\;` still masks the terminator and the
    // (double-encoded) entity survives undecoded.
    expect(decodeEntities(raw)).toBe("Wussow&#8217\\;s");
    // Right order: unescapeIcsText runs first, exposing the real `;` terminator so decodeEntities
    // resolves the entity.
    expect(decodeEntities(unescapeIcsText(raw))).toBe("Wussow’s");
  });
});

describe("R1 — age band", () => {
  it("parses the band forms in the corpus", () => {
    expect(parseAgeBand("Spanish Music Class for Kids 0-8, ages 3-5 welcome")).toEqual({ minAge: 3, maxAge: 5 });
    expect(parseAgeBand("ages 14 & under")).toEqual({ maxAge: 14 });
    expect(parseAgeBand("ages 5 and up")).toEqual({ minAge: 5 });
    expect(parseAgeBand("ages 10+ where archers learn how to shoot")).toEqual({ minAge: 10 });
    expect(parseAgeBand("This is a 21+ show")).toEqual({ minAge: 21 });
  });
  it("never reads a price or a year as an age", () => {
    expect(parseAgeBand("Admission $10+ at the door")).toEqual({});
    expect(parseAgeBand("Suggested donations of $5 per person or $10 per family")).toEqual({});
  });
});

describe("R1 — audience", () => {
  const aud = (hay: string, cats: string[] = []) => deriveAudience(hay, cats.map((c) => c.toLowerCase())).audience;

  it("tags explicit all-ages and family-friendly", () => {
    expect(aud("People of all ages and abilities are welcome")).toContain("all-ages");
    expect(aud("a family-friendly evening")).toContain("all-ages");
    expect(aud("Family Fun Cruise with the Vista Fleet", ["family-friendly"])).toContain("all-ages");
  });
  it("tags kids from a stated upper bound and from vocabulary", () => {
    expect(aud("Canta Conmigo Spanish Music Class for ages 0-8 & Caregivers")).toContain("kids");
    expect(aud("Storytime at the library")).toContain("kids");
  });
  it("tags adults-only only from a stated minimum, never from the venue", () => {
    expect(aud("This is an 18+ event")).toContain("adults-only");
    expect(aud("Live music at Bent Paddle Brewing")).not.toContain("adults-only");
  });
  it("lets an adults-only minimum override a stray all-ages phrase", () => {
    const a = aud("All ages of adults welcome — 21+ only after 9pm");
    expect(a).toContain("adults-only");
    expect(a).not.toContain("all-ages");
  });
  it("tags students from the UMD category", () => {
    expect(aud("The Main Event", ["student activities"])).toContain("students");
  });
});

describe("R2 — cost tier", () => {
  const unknown = { kind: "unknown" } as const;
  it("proves free only with an adjacency", () => {
    expect(deriveCostTier("No admission fee, FREE show! Seats are first come", unknown)).toBe("free");
    expect(deriveCostTier("This webinar is free and open to the public", unknown)).toBe("free");
    expect(deriveCostTier("The Alumni Book Club is free to attend", unknown)).toBe("free");
  });
  it("does not fire on incidental uses of the word 'free'", () => {
    // verbatim from the corpus — "…sparkling on a cloud free night!"
    expect(deriveCostTier("under the milky way, clearly visible and sparkling on a cloud free night", unknown)).toBe("unknown");
    expect(deriveCostTier("gluten free options available", unknown)).toBe("unknown");
  });
  it("prefers a stated price over a free mention", () => {
    expect(deriveCostTier("Free for members, $10 for non-members", unknown)).toBe("paid");
  });
  it("recognises donations", () => {
    expect(deriveCostTier("Suggested donations of $5 per person or $10 per family", unknown)).toBe("donation");
  });
  it("always defers to a price the source actually declared", () => {
    expect(deriveCostTier("no admission fee", { kind: "paid", priceMin: 15, currency: "USD" })).toBe("paid");
  });
});

describe("R3 — registration", () => {
  it("ranks drop-in above a register link", () => {
    expect(deriveRegistration("Drop-in welcome, no registration. Register online to save a seat.")).toBe("drop-in");
  });
  it("detects required", () => {
    expect(deriveRegistration("Registration is required; space is limited")).toBe("required");
    expect(deriveRegistration("Space is limited")).toBe("required");
  });
  it("detects an open sign-up and stays unknown when silent", () => {
    expect(deriveRegistration("REGISTER ONLINE!")).toBe("open");
    expect(deriveRegistration("An evening of music")).toBe("unknown");
  });
});

describe("R4 — setting", () => {
  it("reads virtual off the venue as well as the prose", () => {
    expect(deriveSetting("An online talk", "Virtual via Zoom - register at z.umn.edu/HazMaTON26")).toBe("virtual");
    expect(deriveSetting("HazMaTON Webinar: Plastic Paradox", "Duluth")).toBe("virtual");
  });
  it("reads outdoor from prose and park venues", () => {
    expect(deriveSetting("Movies in the Park — bring a lawn chair", "Leif Erikson Park")).toBe("outdoor");
    expect(deriveSetting("Concerts on the Pier", "Glensheen")).toBe("outdoor");
  });
  it("stays unknown rather than guessing indoor", () => {
    expect(deriveSetting("An evening of chamber music", "Weber Music Hall")).toBe("unknown");
  });
});

describe("R5 — access", () => {
  it("detects the stated accommodations", () => {
    expect(deriveAccess("The event features American Sign Language interpretation, amplification of primary speakers")).toContain("asl");
    expect(deriveAccess("Sensory Friendly Program: Earth, Moon, and Sun")).toContain("sensory-friendly");
    expect(deriveAccess("The venue is wheelchair accessible")).toContain("wheelchair");
  });
  it("returns nothing when the source is silent (silence is not inaccessibility)", () => {
    expect(deriveAccess("An evening of music")).toEqual([]);
  });
});

describe("R6 — geography", () => {
  it("extracts a leading city+state from a packed venue string", () => {
    expect(extractLeadingCity("Tempe, AZ, Mullett Arena")).toEqual({ city: "Tempe", state: "AZ", rest: "Mullett Arena" });
    expect(extractLeadingCity("St. Cloud, Minn., Herb Brooks National Hockey Center")).toEqual({
      city: "St. Cloud",
      state: "MN",
      rest: "Herb Brooks National Hockey Center",
    });
  });
  it("refuses venue names that merely contain a comma", () => {
    expect(extractLeadingCity("Lake Superior Estuarium, 3 Marina Drive")).toBeNull();
    expect(extractLeadingCity("Council Chambers-3rd Floor of City Hall")).toBeNull();
  });
  it("scopes cities correctly", () => {
    expect(deriveGeoScope("Duluth", "MN", "unknown")).toBe("duluth");
    expect(deriveGeoScope("Superior", "WI", "unknown")).toBe("twin-ports");
    expect(deriveGeoScope("Two Harbors", "MN", "unknown")).toBe("regional");
    expect(deriveGeoScope("Tempe", "AZ", "unknown")).toBe("distant");
  });
  it("gives a virtual event no geography at all", () => {
    expect(deriveGeoScope("Duluth", "MN", "virtual")).toBe("virtual");
  });
});

describe("R7 — timing", () => {
  const tz = "America/Chicago";
  it("buckets the local start hour", () => {
    expect(deriveTimeOfDay("2026-08-12T09:00:00-05:00", tz, false)).toBe("morning");
    expect(deriveTimeOfDay("2026-08-12T14:00:00-05:00", tz, false)).toBe("afternoon");
    expect(deriveTimeOfDay("2026-08-12T18:00:00-05:00", tz, false)).toBe("evening");
    expect(deriveTimeOfDay("2026-08-12T22:00:00-05:00", tz, false)).toBe("late-night");
    expect(deriveTimeOfDay("2026-08-12T00:00:00-05:00", tz, true)).toBe("all-day");
  });
  it("buckets in the event's own zone, not the machine's", () => {
    // 23:00 UTC on a summer day is 18:00 in Duluth — evening, not late-night.
    expect(deriveTimeOfDay("2026-08-12T23:00:00+00:00", tz, false)).toBe("evening");
  });
  it("detects the weekend", () => {
    expect(deriveWeekend("2026-08-15T10:00:00-05:00", tz)).toBe(true); // Saturday
    expect(deriveWeekend("2026-08-12T10:00:00-05:00", tz)).toBe(false); // Wednesday
  });
});

describe("R8/R9/R10 — venue, admission, notices", () => {
  it("infers alcohol from licensed-venue vocabulary but never an age", () => {
    expect(deriveAlcohol("Live Music in The Yard!", "Bent Paddle Brewing")).toBe(true);
    expect(deriveAlcohol("Sips on Superior Cocktail Cruise", "Vista Fleet")).toBe(true);
    expect(deriveAlcohol("Storytime", "Duluth Public Library")).toBe(false);
  });
  it("reads public vs restricted admission off the UMD categories", () => {
    expect(derivePublicAdmission(["open to the public"], "")).toBe("public");
    expect(derivePublicAdmission(["student activities"], "")).toBe("restricted");
    expect(derivePublicAdmission([], "An evening of music")).toBe("unknown");
  });
  it("flags academic-calendar rows that are not public events", () => {
    expect(deriveInstitutionalNotice("Final exams; last day of regular session", ["academic calendar"])).toBe(true);
    expect(deriveInstitutionalNotice("Faculty appointments begin", ["academic calendar"])).toBe(true);
    // a real event that merely also carries the category must NOT be suppressed
    expect(deriveInstitutionalNotice("HazMaTON Webinar: Plastic Paradox", ["academic calendar", "open to the public"])).toBe(false);
  });
});

describe("ticket URL extraction", () => {
  it("pulls the first ticketing link out of a description", () => {
    expect(extractTicketUrl("Get in at https://www.eventbrite.com/e/twin-cities_alumni_social_2026, see you there.")).toBe(
      "https://www.eventbrite.com/e/twin-cities_alumni_social_2026",
    );
  });
  it("returns undefined when there is no ticketing host", () => {
    expect(extractTicketUrl("More info at https://example.com/page")).toBeUndefined();
  });
});
