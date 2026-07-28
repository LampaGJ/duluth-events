import { describe, it, expect } from "vitest";
import { buildPlaceIndex, PLACE_INDEX } from "../src/place-registry.js";
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
});
