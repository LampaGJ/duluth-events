import { describe, it, expect } from "vitest";
import { GROUPS, SPECS, placeSpecs } from "../src/feeds-config.js";
import { filterEvents } from "../src/feed.js";
import { finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";
import { PLACE_INDEX } from "../src/place-registry.js";

describe("feed catalog", () => {
  it("has no duplicate filenames", () => {
    // Two specs writing the same file silently overwrite each other — `family.ics` was produced
    // both by the audience feed and by the eventType loop, and the loser vanished.
    const files = SPECS.map((s) => s.file);
    expect(files).toEqual([...new Set(files)]);
  });

  it("puts every spec in a declared group", () => {
    for (const s of SPECS) expect(GROUPS).toContain(s.group);
  });

  it("names every file as a .ics", () => {
    for (const s of SPECS) expect(s.file).toMatch(/^[a-z0-9-]+\.ics$/);
  });

  it("gives every spec a description a subscriber can act on", () => {
    for (const s of SPECS) {
      expect(s.title.length).toBeGreaterThan(2);
      expect(s.desc.length).toBeGreaterThan(10);
    }
  });

  it("keeps family.ics keyed to the audience facet, not the eventType", () => {
    const family = SPECS.find((s) => s.file === "family.ics");
    expect(family?.filter.audience).toEqual(["all-ages", "kids"]);
    expect(family?.filter.types).toBeUndefined();

    const cruise = finalizeEvent(
      makeEvent({ title: "Family Fun Cruise with the Vista Fleet", categories: ["Entertainment", "Family-Friendly"], eventType: "other" }),
    );
    // It is a food-drink/community event by TYPE, yet must still reach the family feed.
    expect(cruise.eventType).not.toBe("family");
    expect(filterEvents([cruise], family!.filter)).toHaveLength(1);
  });

  it("excludes institutional notices from the everything feed", () => {
    const all = SPECS.find((s) => s.file === "all.ics");
    expect(all?.filter.institutionalNotice).toBe(false);
    const notice = finalizeEvent(makeEvent({ title: "Final exams; last day of regular session", categories: ["Academic Calendar"], eventType: "other" }));
    expect(filterEvents([notice], all!.filter)).toHaveLength(0);
    // …but it is still reachable, never discarded.
    expect(filterEvents([notice], SPECS.find((s) => s.file === "notices.ics")!.filter)).toHaveLength(1);
  });
});

describe("place feeds", () => {
  it("emits one spec per registered place, under a place/ path", () => {
    const specs = placeSpecs();
    expect(specs.length).toBe(PLACE_INDEX.all.length);
    for (const s of specs) expect(s.file).toMatch(/^place\/[a-z0-9-]+\.ics$/);
  });

  it("keys each spec's filename and filter to exactly one registered place id, with no duplicates or omissions", () => {
    // Not just a count match (77 == 77 would pass even if every spec pointed at the same place) —
    // this proves the SET of ids covered is exactly the registry's, one-to-one.
    const specIds = placeSpecs()
      .map((s) => s.file.match(/^place\/(.+)\.ics$/)?.[1])
      .sort();
    const registryIds = PLACE_INDEX.all.map((p) => p.id).sort();
    expect(specIds).toEqual(registryIds);
    for (const s of placeSpecs()) {
      const id = s.file.match(/^place\/(.+)\.ics$/)![1];
      expect(s.filter.placeId).toBe(id);
    }
  });

  it("filters to exactly that place", () => {
    const spec = placeSpecs().find((s) => s.file === "place/wussows-concert-cafe.ics")!;
    const here = finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe" }));
    const elsewhere = finalizeEvent(makeEvent({ venueRaw: "Lake Superior Estuarium" }));
    expect(filterEvents([here, elsewhere], spec.filter)).toHaveLength(1);
    expect(filterEvents([here, elsewhere], spec.filter)[0]!.place?.id).toBe("wussows-concert-cafe");
  });

  it("never emits a feed for a provisional place", () => {
    expect(placeSpecs().every((s) => !s.file.includes("~"))).toBe(true);
    // Direct proof, not just an id-shape inference: resolve a venue string that is guaranteed NOT
    // to be in the registry, confirm it comes back provisional, and confirm no place spec selects it.
    const provisional = finalizeEvent(makeEvent({ venueRaw: "Totally Unregistered Popup Space #4471" }));
    expect(provisional.place?.provisional).toBe(true);
    expect(provisional.place?.id.startsWith("~")).toBe(true);
    expect(placeSpecs().some((s) => filterEvents([provisional], s.filter).length > 0)).toBe(false);
  });

  it("keeps filenames unique across the whole catalog including place feeds", () => {
    const files = [...SPECS, ...placeSpecs()].map((s) => s.file);
    expect(files).toEqual([...new Set(files)]);
  });
});
