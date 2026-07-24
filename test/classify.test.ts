import { describe, it, expect } from "vitest";
import { classifyEventType, isMultiDay, finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";

describe("classifyEventType", () => {
  it("maps titles to canonical types", () => {
    expect(classifyEventType("Live music tonight at Pizza Lucé")).toBe("live-music");
    expect(classifyEventType("City Council Meeting")).toBe("meeting");
    expect(classifyEventType("Intro to Paddling — beginner class")).toBe("class");
    expect(classifyEventType("Lincoln Park Farmers Market")).toBe("market");
    expect(classifyEventType("Homegrown Music Festival")).toBe("festival");
    expect(classifyEventType("Bulldogs Hockey vs. Denver")).toBe("sports");
  });
  it("falls back to community when nothing matches", () => {
    expect(classifyEventType("Neighborhood gathering")).toBe("community");
  });
  it("uses categories as a hint", () => {
    expect(classifyEventType("Untitled", ["live music"])).toBe("live-music");
  });
});

describe("isMultiDay", () => {
  it("is false for a same-day event", () => {
    expect(isMultiDay("2026-08-10T16:00:00-05:00", "2026-08-10T20:00:00-05:00")).toBe(false);
  });
  it("is true when the span crosses days, or it recurs", () => {
    expect(isMultiDay("2026-08-10T16:00:00-05:00", "2026-09-14T20:00:00-05:00")).toBe(true);
    expect(isMultiDay("2026-08-10T16:00:00-05:00", undefined, "FREQ=WEEKLY;COUNT=4")).toBe(true);
  });
});

describe("finalizeEvent", () => {
  it("classifies a still-default event and derives multiDay", () => {
    const e = finalizeEvent(makeEvent({ title: "Live music at the Rex" }));
    expect(e.eventType).toBe("live-music");
    expect(e.multiDay).toBe(false);
  });
  it("does not override an explicit eventType", () => {
    const e = finalizeEvent(makeEvent({ title: "Anything", eventType: "meeting" }));
    expect(e.eventType).toBe("meeting");
  });
});
