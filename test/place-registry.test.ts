import { describe, it, expect } from "vitest";
import { buildPlaceIndex, PLACE_INDEX, resolvePlace } from "../src/place-registry.js";
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
});
