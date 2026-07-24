import { describe, it, expect } from "vitest";
import { mapRec1Session } from "../src/adapters/rec1.js";
import { finalizeEvent } from "../src/classify.js";
import type { SourceDef } from "../src/sources.js";

const AT = "2026-07-20T09:00:00-05:00";
const src: SourceDef = {
  name: "Duluth Parks & Recreation",
  adapter: "rec1",
  url: "https://secure.rec1.com/MN/duluthparks/catalog",
  type: "json-api",
  confidence: "medium",
  enabled: true,
};
const group = { id: "352948", name: "Intro to Paddling", descriptionText: "Join UMD's RSOP to paddle the St. Louis River." };

// Real REC1 session shape (from getActivitySessions, 2026-07-23).
const session = (datesVal: string) => ({
  id: 4184725,
  text: "Intro to Canoeing (4455)",
  basicInfo: ["Registration: May 1-Aug 5", "Dates: Aug 10"],
  price: 0,
  features: [
    { name: "location", value: "Munger Landing" },
    { name: "ageGender", value: "8/up" },
    { name: "days", value: "Mon" },
    { name: "dates", value: datesVal },
    { name: "times", value: "4pm-8pm" },
  ],
});

describe("mapRec1Session", () => {
  it("maps a single-day program session to a class event", () => {
    const e = mapRec1Session(session("08/10/26"), group, src, AT)!;
    expect(e.title).toBe("Intro to Paddling");
    expect(e.start).toBe("2026-08-10T16:00:00-05:00");
    expect(e.end).toBe("2026-08-10T20:00:00-05:00");
    expect(e.eventType).toBe("class");
    expect(e.cost.kind).toBe("free");
    expect(e.location.venueName).toBe("Munger Landing");
    expect(e.age).toMatchObject({ allAges: false, minAge: 8 });
    expect(e.source.extractionMethod).toBe("structured-api");
    expect(finalizeEvent(e).multiDay).toBe(false);
  });

  it("spans a multi-week range as a multi-day event", () => {
    const e = mapRec1Session(session("08/10/26-09/14/26"), group, src, AT)!;
    expect(e.start).toBe("2026-08-10T16:00:00-05:00");
    expect(e.end).toBe("2026-09-14T20:00:00-05:00");
    expect(finalizeEvent(e).multiDay).toBe(true);
  });

  it("drops a session with no parseable date", () => {
    const s = session("");
    expect(mapRec1Session(s, group, src, AT)).toBeNull();
  });
});
