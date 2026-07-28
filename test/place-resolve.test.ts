import { describe, it, expect } from "vitest";
import { normalizeVenueKey, isSentinelVenue, parseVenueString } from "../src/place-resolve.js";

describe("normalizeVenueKey", () => {
  it("unescapes ICS, then decodes entities, then normalizes", () => {
    // Verbatim corpus strings. ICS escapes `;` as `\;`, which defeated entity decoding in the probe.
    // &#038; decodes to a literal "&", which now folds to "and" (the ampersand-normalization gap
    // fix) rather than vanishing as stripped punctuation — see the "&"/"and" convergence tests below.
    expect(normalizeVenueKey("Vista Fleet Sightseeing &#038\\; Dining Cruises")).toBe("vista fleet sightseeing and dining cruises");
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

  it("transliterates accented Latin letters instead of dropping them — the truncated-key bug", () => {
    // Task 9b fixed the slug generator's OWN copy of this transliteration but not normalizeVenueKey,
    // so "lake-avenue-cafe" (the id) and "lake avenue caf" (the old matching key) disagreed.
    expect(normalizeVenueKey("Lake Avenue Café")).toBe("lake avenue cafe");
    expect(normalizeVenueKey("Lake Avenue Cafe")).toBe(normalizeVenueKey("Lake Avenue Café"));
    // NFD-decomposable accents plus the three that don't decompose (æ, ø, ß), upper- and lower-case.
    expect(normalizeVenueKey("Ändré's Bistro")).toBe("andres bistro");
    expect(normalizeVenueKey("Grønland Café & Bakehus")).toBe("gronland cafe and bakehus");
    expect(normalizeVenueKey("Straße Haus")).toBe("strasse haus");
  });

  it("folds & to and, so ampersand and spelled-out forms converge", () => {
    expect(normalizeVenueKey("Sports & Health Center")).toBe(normalizeVenueKey("Sports and Health Center"));
    expect(normalizeVenueKey("Sports & Health Center")).toBe("sports and health center");
  });

  it("strips a leading article, so 'The X' and 'X' converge", () => {
    expect(normalizeVenueKey("The Rex")).toBe(normalizeVenueKey("Rex"));
    expect(normalizeVenueKey("The Rex")).toBe("rex");
  });

  it("strips a trailing legal/company suffix, so Company/Co./bare-name converge", () => {
    expect(normalizeVenueKey("Bent Paddle Brewing Company")).toBe(normalizeVenueKey("Bent Paddle Brewing Co."));
    expect(normalizeVenueKey("Bent Paddle Brewing Company")).toBe(normalizeVenueKey("Bent Paddle Brewing"));
    expect(normalizeVenueKey("Bent Paddle Brewing Company")).toBe("bent paddle brewing");
  });

  it("does not orphan 'op' out of Co-op — trailing-suffix strip only ever touches the LAST token", () => {
    expect(normalizeVenueKey("Whole Foods Co-op")).toBe("whole foods co op");
    expect(normalizeVenueKey("Co-op Deli")).toBe("co op deli");
  });

  it("remains idempotent under every new step (accents, &, article, legal suffix)", () => {
    for (const raw of ["The Bent Paddle Brewing Co.", "Lake Avenue Café", "Sports & Health Center", "Whole Foods Co-op"]) {
      const once = normalizeVenueKey(raw);
      expect(normalizeVenueKey(once)).toBe(once);
    }
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

  it("still recognises sentinel-prefixed corpus variants", () => {
    expect(isSentinelVenue("See listing for details")).toBe(true);
    expect(isSentinelVenue("Not specified — check website")).toBe(true);
  });

  it("does not misclassify a real venue that merely starts with a sentinel word", () => {
    expect(isSentinelVenue("Various Stages at Bayfront")).toBe(false);
    expect(isSentinelVenue("TBD Skatepark")).toBe(false);
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
