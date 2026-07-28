import { describe, it, expect } from "vitest";
import { normalizeVenueKey, isSentinelVenue, parseVenueString, resolvePlace } from "../src/place-resolve.js";
import { buildPlaceIndex } from "../src/place-registry.js";

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

// Fixture note: nameAliases below list every OBSERVED corpus variant verbatim — including the two
// compound "name + address" forms — exactly as a human curator pastes them from `places:propose`
// output. resolvePlace does exact normalized-map lookup only (no fuzzy/substring matching), so a
// compound string only resolves once its literal form is a claimed alias; this mirrors how the
// shipped registry (src/places.ts) already carries "Bent Paddle Taproom 1832 W Michigan St." as a
// nameAlias for the same reason.
const IDX = buildPlaceIndex([
  {
    id: "bent-paddle-taproom", name: "Bent Paddle Taproom",
    nameAliases: [
      "Bent Paddle Brewing",
      "Bent Paddle Taproom // 1832 W Michigan St. // Duluth",
      "Bent Paddle Taproom 1832 W Michigan St.",
    ],
    addressAliases: ["1832 W Michigan St"],
    address: { city: "Duluth", state: "MN" }, provenance: { source: "manual" as const },
  },
]);

describe("resolvePlace", () => {
  it("resolves every corpus variant of one venue to the same id", () => {
    const variants = [
      "Bent Paddle Brewing",
      "Bent Paddle Taproom // 1832 W Michigan St. // Duluth",
      "Bent Paddle Taproom 1832 W Michigan St.",
      "1832 W Michigan St",
    ];
    const ids = variants.map((v) => resolvePlace(v, IDX)?.id);
    expect(ids).toEqual(Array(4).fill("bent-paddle-taproom"));
    expect(resolvePlace("Bent Paddle Brewing", IDX)?.provisional).toBe(false);
  });

  it("returns undefined for a sentinel — the false-merge guard", () => {
    for (const s of ["See listing", "Not specified", "Sign in to download the location", ""]) {
      expect(resolvePlace(s, IDX)).toBeUndefined();
    }
    expect(resolvePlace(undefined, IDX)).toBeUndefined();
  });

  it("mints a provisional place for an unregistered real venue", () => {
    const p = resolvePlace("Wild State Cider", IDX);
    expect(p).toEqual({ id: "~wild-state-cider", name: "Wild State Cider", provisional: true });
  });

  it("gives a provisional place a stable id across calls and across spelling variants", () => {
    expect(resolvePlace("Wild State Cider", IDX)?.id).toBe(resolvePlace("wild  state   cider", IDX)?.id);
  });

  it("resolves an away-game venue by its name, not the packed city prefix", () => {
    expect(resolvePlace("Pueblo, CO, Massari Arena", IDX)?.id).toBe("~massari-arena");
  });
});
