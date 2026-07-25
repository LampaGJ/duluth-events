import { describe, it, expect } from "vitest";
import { GROUPS, SPECS } from "../src/feeds-config.js";
import { filterEvents } from "../src/feed.js";
import { finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";

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
