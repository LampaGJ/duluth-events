import { describe, it, expect } from "vitest";
import { normalizeVenueKey, isSentinelVenue, parseVenueString } from "../src/place-resolve.js";

describe("normalizeVenueKey", () => {
  it("unescapes ICS, then decodes entities, then normalizes", () => {
    // Verbatim corpus strings. ICS escapes `;` as `\;`, which defeated entity decoding in the probe.
    expect(normalizeVenueKey("Vista Fleet Sightseeing &#038\\; Dining Cruises")).toBe("vista fleet sightseeing dining cruises");
    expect(normalizeVenueKey("Whole Foods Co-op &#8211; Hillside")).toBe("whole foods co op hillside");
    expect(normalizeVenueKey("Wussow&#8217;s Concert Cafe")).toBe("wussows concert cafe");
  });

  it("strips parenthetical room/building suffixes", () => {
    expect(normalizeVenueKey("Glensheen Mansion (G)")).toBe("glensheen mansion");
    expect(normalizeVenueKey("Marshall W. Alworth Planetarium (MWAP)")).toBe("marshall w alworth planetarium");
  });

  it("collapses punctuation and whitespace so variants converge", () => {
    expect(normalizeVenueKey("Bent Paddle Taproom // 1832 W Michigan St. // Duluth")).toBe(
      normalizeVenueKey("Bent Paddle Taproom 1832 W Michigan St Duluth"),
    );
  });

  it("is idempotent", () => {
    const once = normalizeVenueKey("Whole Foods Co-op &#8211; Hillside");
    expect(normalizeVenueKey(once)).toBe(once);
  });
});

describe("isSentinelVenue", () => {
  it("recognises every sentinel in the corpus", () => {
    for (const s of ["See listing", "Not specified", "See catalog", "See agenda", "Sign in to download the location"]) {
      expect(isSentinelVenue(s)).toBe(true);
    }
  });

  it("does not swallow a real venue", () => {
    expect(isSentinelVenue("Lake Superior Estuarium")).toBe(false);
    expect(isSentinelVenue("Bent Paddle Brewing")).toBe(false);
  });

  it("treats empty and whitespace as sentinel", () => {
    expect(isSentinelVenue("")).toBe(true);
    expect(isSentinelVenue("   ")).toBe(true);
  });
});

describe("parseVenueString", () => {
  it("splits an away-game venue into name and city — the 59-games regression", () => {
    expect(parseVenueString("Bismarck, ND, MDU Resources Community Bowl")).toEqual({
      name: "MDU Resources Community Bowl", city: "Bismarck", state: "ND",
    });
    expect(parseVenueString("Pueblo, CO, Massari Arena")).toEqual({
      name: "Massari Arena", city: "Pueblo", state: "CO",
    });
  });

  it("handles AP-style state abbreviations", () => {
    expect(parseVenueString("St. Cloud, Minn., Herb Brooks National Hockey Center")).toEqual({
      name: "Herb Brooks National Hockey Center", city: "St. Cloud", state: "MN",
    });
  });

  it("falls back to the city as the name when nothing follows it", () => {
    expect(parseVenueString("River Falls, WI")).toEqual({ name: "River Falls", city: "River Falls", state: "WI" });
  });

  it("leaves an ordinary venue untouched", () => {
    expect(parseVenueString("Lake Superior Estuarium")).toEqual({ name: "Lake Superior Estuarium" });
    expect(parseVenueString("Council Chambers-3rd Floor of City Hall")).toEqual({ name: "Council Chambers-3rd Floor of City Hall" });
  });
});
