import { describe, it, expect } from "vitest";
import { buildPlaceIndex, PLACE_INDEX, resolvePlace, resolvePlaceForEvent } from "../src/place-registry.js";
import { PLACES } from "../src/places.js";

const base = {
  address: { city: "Duluth", state: "MN" },
  provenance: { source: "manual" as const },
};

describe("buildPlaceIndex", () => {
  it("indexes name and address aliases separately", () => {
    const idx = buildPlaceIndex([
      { ...base, id: "bent-paddle-taproom", name: "Bent Paddle Taproom", nameAliases: ["bent paddle brewing"], addressAliases: ["1832 w michigan st"] },
    ]);
    expect(idx.byNameAlias.get("bent paddle brewing")?.id).toBe("bent-paddle-taproom");
    expect(idx.byAddressAlias.get("1832 w michigan st")?.id).toBe("bent-paddle-taproom");
    expect(idx.byNameAlias.get("1832 w michigan st")).toBeUndefined();
  });

  it("indexes the canonical name itself, so it need not be repeated as an alias", () => {
    const idx = buildPlaceIndex([{ ...base, id: "wussows", name: "Wussow's Concert Cafe", nameAliases: [], addressAliases: [] }]);
    expect(idx.byNameAlias.get("wussows concert cafe")?.id).toBe("wussows");
  });

  it("normalizes aliases on the way in, so the registry can hold readable forms", () => {
    const idx = buildPlaceIndex([{ ...base, id: "glensheen", name: "Glensheen", nameAliases: ["Glensheen Mansion (G)"], addressAliases: [] }]);
    expect(idx.byNameAlias.get("glensheen mansion")?.id).toBe("glensheen");
  });

  it("accepts a minimal entry that omits nameAliases/addressAliases/rooms entirely — the Task 9 paste ergonomics", () => {
    const idx = buildPlaceIndex([{ ...base, id: "minimal-venue", name: "Minimal Venue" }]);
    const place = idx.byNameAlias.get("minimal venue");
    expect(place?.id).toBe("minimal-venue");
    expect(place?.rooms).toEqual([]);
    expect(place?.nameAliases).toEqual([]);
    expect(place?.addressAliases).toEqual([]);
  });

  // --- fail-fast invariants: a broken registry must stop the build, not mis-resolve ---

  it("throws on a duplicate id", () => {
    expect(() =>
      buildPlaceIndex([
        { ...base, id: "dup", name: "A", nameAliases: [], addressAliases: [] },
        { ...base, id: "dup", name: "B", nameAliases: [], addressAliases: [] },
      ]),
    ).toThrow(/duplicate place id/i);
  });

  it("throws when two places claim the same name alias", () => {
    expect(() =>
      buildPlaceIndex([
        { ...base, id: "a", name: "A", nameAliases: ["shared venue"], addressAliases: [] },
        { ...base, id: "b", name: "B", nameAliases: ["shared venue"], addressAliases: [] },
      ]),
    ).toThrow(/alias .* claimed by/i);
  });

  it("throws when two places claim the same address alias", () => {
    expect(() =>
      buildPlaceIndex([
        { ...base, id: "a", name: "A", nameAliases: [], addressAliases: ["1 main st"] },
        { ...base, id: "b", name: "B", nameAliases: [], addressAliases: ["1 main st"] },
      ]),
    ).toThrow(/alias .* claimed by/i);
  });

  it("throws on a place that fails schema validation", () => {
    expect(() => buildPlaceIndex([{ ...base, id: "Not A Slug", name: "X", nameAliases: [], addressAliases: [] }])).toThrow();
  });

  it("rejects a sentinel used as an alias — sentinels must never resolve", () => {
    expect(() =>
      buildPlaceIndex([{ ...base, id: "a", name: "A", nameAliases: ["see listing"], addressAliases: [] }]),
    ).toThrow(/sentinel/i);
  });
});

describe("the shipped registry", () => {
  it("loads and validates", () => {
    expect(PLACE_INDEX.all.length).toBe(PLACES.length);
    expect(PLACE_INDEX.all.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = PLACE_INDEX.all.map((p) => p.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("resolves every observed Bent Paddle corpus variant to the same id", () => {
    // Confirms the flagship claim in place-resolve.ts's module doc: these three raw forms plus the
    // canonical address all converge on one identity — against the REAL shipped PLACE_INDEX, not a
    // test fixture. "Bent Paddle Taproom // 1832 W Michigan St. // Duluth" only resolves because
    // src/places.ts carries it verbatim as a nameAlias (I2 fix) — resolvePlace does no splitting of
    // a compound name+address string; it only ever does an exact normalized-map lookup.
    const variants = [
      "Bent Paddle Brewing",
      "Bent Paddle Taproom // 1832 W Michigan St. // Duluth",
      "Bent Paddle Taproom 1832 W Michigan St.",
      "1832 W Michigan St",
    ];
    for (const v of variants) expect(resolvePlace(v)?.id).toBe("bent-paddle-taproom");
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

  // I3: the fullKey fallback's own success path had zero coverage — every variant above resolves
  // via the FIRST lookup (parsed-name key), because none of them has a leading city prefix for
  // parseVenueString to strip, so key === fullKey and the fallback is never the thing that found the
  // hit. This is the one case where it diverges and does the work: an away-game venue whose alias is
  // the literal, un-split "City, ST, Venue" corpus string.
  //
  // The canonical `name` is deliberately DIFFERENT from the parsed venue name ("Massari Arena at CSU
  // Pueblo" vs. parsed "Massari Arena"). buildPlaceIndex self-registers every place's canonical name
  // as a byNameAlias key, so if `name` were literally "Massari Arena", the FIRST lookup (on
  // parsed.name's key "massari arena") would already hit via that self-alias and the fallback would
  // never be reached — which is exactly what happened in the prior version of this test (see the
  // round-2 fix report for the proof: removing the packed alias made no difference with that
  // fixture). With `name` differing, the first lookup key "massari arena" cannot match the
  // self-alias "massari arena at csu pueblo", so ONLY the fullKey re-normalization of the untouched
  // raw string ("pueblo co massari arena") — matched against the packed nameAlias below — can find
  // it. Removing that alias must make this test fail; see the fix report for the before/after run.
  it("resolves via the literal packed alias when a curator pasted the raw 'City, ST, Venue' string", () => {
    const awayIdx = buildPlaceIndex([
      {
        id: "massari-arena", name: "Massari Arena at CSU Pueblo",
        nameAliases: ["Pueblo, CO, Massari Arena"], // pasted verbatim, city prefix and all
        address: { city: "Pueblo", state: "CO" }, provenance: { source: "manual" as const },
      },
    ]);
    expect(resolvePlace("Pueblo, CO, Massari Arena", awayIdx)).toEqual({ id: "massari-arena", name: "Massari Arena at CSU Pueblo", provisional: false });
  });

  // --- Task 11b: city-shaped provisional places must never act as merge keys ------------------
  //
  // UMD away meets resolve to bare-city venue strings. All-day events all key on midnight, so
  // `instant | place.id` degenerates to "anything all-day in that city" once a place resolves at
  // all — the human ruling was to remove the risk class outright (treat a bare city like a
  // sentinel: resolve to no place) rather than lean on the title-similarity veto as the only guard.
  // Two shapes, two signals — see `isCityOnlyVenue`'s doc comment in place-registry.ts for why both
  // are needed: the ICS adapter's packed "City, ST" form (parseVenueString alone catches it, no
  // `locationCity` argument needed) and the JSON-LD adapter's bare-name form (only catchable by
  // comparing against the event's OWN, separately-sourced `location.city`).
  describe("city-only venues resolve to no place (Task 11b)", () => {
    it("the 6 real corpus city ids all resolve to undefined", () => {
      // Corpus spelling preserved verbatim, including "Lawerence" (misspelled in the source feed).
      // The packed "City, ST" forms need no locationCity — parseVenueString alone identifies them.
      expect(resolvePlace("River Falls, WI")).toBeUndefined();
      expect(resolvePlace("Sioux Falls, SD")).toBeUndefined();
      // The bare forms (no state, so extractLeadingCity never fires) need the location-city signal —
      // exactly what classify.ts's finalizeEvent threads through in production.
      expect(resolvePlace("Winona", PLACE_INDEX, "Winona")).toBeUndefined();
      expect(resolvePlace("Northfield", PLACE_INDEX, "Northfield")).toBeUndefined();
      expect(resolvePlace("Romeoville", PLACE_INDEX, "Romeoville")).toBeUndefined();
      expect(resolvePlace("Lawerence", PLACE_INDEX, "Lawerence")).toBeUndefined();
    });

    it("a bare city with NO locationCity argument still falls through to provisional — signal 2 is additive, not a regression on old callers", () => {
      // Without a location to compare against, "Winona" carries no evidence it's city-only, so the
      // OLD (pre-Task-11b) behavior is preserved for any 1- or 2-arg caller. This is the case Task
      // 11b's brief calls out: signal 1 alone cannot catch this shape.
      expect(resolvePlace("Winona")?.provisional).toBe(true);
    });

    it("a venue that merely CONTAINS a city name is unaffected — the restraint case", () => {
      // Over-matching here would silently unregister real venues. Neither is a real registry entry
      // in the fixture-scoped IDX, so both must still mint an ordinary provisional place — the exact
      // opposite of the city-only outcome (undefined).
      expect(resolvePlace("Duluth Grill", IDX, "Duluth")?.provisional).toBe(true);
      expect(resolvePlace("Superior Public Library", IDX, "Superior")?.provisional).toBe(true);
      // And against the REAL shipped registry, "Superior Public Library" is in fact registered —
      // proving the city-only check runs AFTER the registry lookup, never before it.
      expect(resolvePlace("Superior Public Library", PLACE_INDEX, "Superior")).toEqual({
        id: "superior-public-library", name: "Superior Public Library", provisional: false,
      });
    });

    it("a registered place legitimately named after a city still resolves — registry wins before any city-only check", () => {
      const cityNamedIdx = buildPlaceIndex([
        { ...base, id: "winona", name: "Winona", address: { city: "Winona", state: "MN" } },
      ]);
      expect(resolvePlace("Winona", cityNamedIdx, "Winona")).toEqual({ id: "winona", name: "Winona", provisional: false });
    });
  });
});

// --- Task 11b fix round 1: resolvePlaceForEvent is the sanctioned production entry point --------
//
// resolvePlace's locationCity is an OPTIONAL third argument — nothing in the type system stops a
// future finalize-style call site from writing `resolvePlace(e.venueRaw)` and silently reopening the
// exact risk class Task 11b closed. resolvePlaceForEvent has no third argument to forget: it always
// threads `e.location.city`. These tests pin that it actually does the threading (not just that it
// compiles), by exercising the SAME bare-city case the raw multi-arg form needs a third argument for.
describe("resolvePlaceForEvent", () => {
  it("threads e.location.city as the city-only signal, catching the bare-city form the 2-arg resolvePlace cannot", () => {
    const bareWinona = { venueRaw: "Winona", location: { city: "Winona", state: "MN", inDuluth: false } };
    expect(resolvePlaceForEvent(bareWinona)).toBeUndefined();
    // Precondition/contrast: the SAME venueRaw through the raw form with no third argument does NOT
    // catch it — proving the wrapper is doing real work (supplying the city), not just re-deriving
    // something the bare 1-arg call already gave you.
    expect(resolvePlace(bareWinona.venueRaw)?.provisional).toBe(true);
  });

  it("does not city-only a real venue that merely shares a location — the restraint case survives the wrapper", () => {
    const grill = { venueRaw: "Duluth Grill", location: { city: "Duluth", state: "MN", inDuluth: true } };
    expect(resolvePlaceForEvent(grill, IDX)?.provisional).toBe(true);
  });

  it("a registered place still resolves through the wrapper — registry wins before any city-only check", () => {
    expect(resolvePlaceForEvent({ venueRaw: "Bent Paddle Brewing", location: { city: "Duluth", state: "MN", inDuluth: true } }, IDX)).toEqual({
      id: "bent-paddle-taproom", name: "Bent Paddle Taproom", provisional: false,
    });
  });
});
