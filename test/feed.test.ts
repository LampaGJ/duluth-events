import { describe, it, expect } from "vitest";
import { filterEvents, parseFilter, buildFeed } from "../src/feed.js";
import { finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";

const music = finalizeEvent(makeEvent({ title: "Live music show", eventType: "live-music", source: { name: "Perfect Duluth Day", type: "html-calendar", url: "https://perfectduluthday.com/duluth-events/list/", extractionMethod: "jsonld", retrievedAt: "2026-07-20T09:00:00-05:00", confidence: "medium" } }));
const meeting = finalizeEvent(makeEvent({ uid: "legistar:1@duluth-events", title: "City Council", eventType: "meeting", source: { name: "Duluth City Meetings (Legistar)", type: "json-api", url: "https://webapi.legistar.com/v1/duluth-mn/events", extractionMethod: "structured-api", retrievedAt: "2026-07-20T09:00:00-05:00", confidence: "high" } }));
const multiClass = finalizeEvent(makeEvent({ uid: "rec1:2@duluth-events", title: "Pottery series", eventType: "class", start: "2026-08-01T18:00:00-05:00", end: "2026-08-29T20:00:00-05:00", source: { name: "Duluth Parks & Recreation", type: "json-api", url: "https://secure.rec1.com/MN/duluthparks/catalog", extractionMethod: "structured-api", retrievedAt: "2026-07-20T09:00:00-05:00", confidence: "medium" } }));
const all = [music, meeting, multiClass];

describe("filterEvents", () => {
  it("filters by type", () => {
    expect(filterEvents(all, { types: ["live-music"] })).toEqual([music]);
    expect(filterEvents(all, { types: ["live-music", "class"] }).length).toBe(2);
  });
  it("filters by source substring and confidence", () => {
    expect(filterEvents(all, { sources: ["legistar"] })).toEqual([meeting]);
    expect(filterEvents(all, { confidence: ["high"] })).toEqual([meeting]);
  });
  it("filters by multiDay (single-day vs multi-day)", () => {
    expect(filterEvents(all, { multiDay: true })).toEqual([multiClass]);
    expect(filterEvents(all, { multiDay: false }).length).toBe(2);
  });
});

describe("parseFilter", () => {
  it("parses comma lists and drops invalid types", () => {
    expect(parseFilter({ type: "live-music,concert,meeting" }).types).toEqual(["live-music", "meeting"]);
    expect(parseFilter({ source: "pdd,legistar" }).sources).toEqual(["pdd", "legistar"]);
    expect(parseFilter({ multiDay: "false" }).multiDay).toBe(false);
    expect(parseFilter({ inDuluth: "true" }).inDuluth).toBe(true);
  });
});

describe("buildFeed", () => {
  it("emits only the filtered events, tagged with X-EVENT-TYPE", () => {
    const ics = buildFeed(all, { types: ["meeting"] });
    expect(ics).toContain("X-EVENT-TYPE:meeting");
    expect(ics).not.toContain("Live music show");
    expect(ics).toContain("City Council");
  });
});
