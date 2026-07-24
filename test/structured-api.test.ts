import { describe, it, expect } from "vitest";
import { mapLegistarEvent, mapTribeEvent } from "../src/adapters/structured-api.js";
import type { SourceDef } from "../src/sources.js";

const AT = "2026-07-20T09:00:00-05:00";

const legistarSource: SourceDef = {
  name: "Duluth City Meetings (Legistar)",
  adapter: "structured-api",
  mapper: "legistar",
  url: "https://webapi.legistar.com/v1/duluth-mn/events",
  type: "json-api",
  confidence: "high",
  enabled: true,
};

const visitDuluthSource: SourceDef = {
  name: "Visit Duluth",
  adapter: "structured-api",
  mapper: "tribe-rest",
  url: "https://visitduluth.com/wp-json/tribe/events/v1/events",
  type: "json-api",
  confidence: "medium",
  enabled: true,
};

describe("mapLegistarEvent", () => {
  it("maps a Legistar meeting to a high-confidence, verified event with the right local time", () => {
    const e = mapLegistarEvent(
      {
        EventId: 105,
        EventBodyName: "City Council",
        EventDate: "2026-07-27T00:00:00",
        EventTime: "6:00 PM",
        EventLocation: "Council Chambers",
        EventInSiteURL: "https://duluth-mn.legistar.com/MeetingDetail.aspx?ID=1",
        EventAgendaFile: "https://duluth-mn.legistar.com/agenda.pdf",
      },
      legistarSource,
      AT,
    );
    expect(e).not.toBeNull();
    expect(e!.title).toBe("City Council — Public Meeting");
    expect(e!.start).toBe("2026-07-27T18:00:00-05:00"); // 6PM CDT
    expect(e!.location.venueName).toBe("Council Chambers");
    expect(e!.source.extractionMethod).toBe("structured-api");
    expect(e!.source.confidence).toBe("high");
    expect(e!.source.verified).toBe(true);
    expect(e!.categories).toContain("public-meeting");
    expect(e!.description).toContain("Agenda:");
  });

  it("treats a meeting with no EventTime as all-day", () => {
    const e = mapLegistarEvent({ EventId: 2, EventBodyName: "Planning Commission", EventDate: "2026-08-01T00:00:00", EventTime: null }, legistarSource, AT);
    expect(e!.allDay).toBe(true);
  });

  it("drops a row missing a date or body name", () => {
    expect(mapLegistarEvent({ EventId: 3, EventBodyName: "X", EventDate: null }, legistarSource, AT)).toBeNull();
  });
});

describe("mapTribeEvent", () => {
  it("maps a tribe REST event with paid cost, venue, HTML-stripped description, and medium confidence", () => {
    const e = mapTribeEvent(
      {
        id: 42,
        title: "Vista Fleet Sunset Cruise",
        description: "<p>Board the <b>Vista Star</b>&#8217;s deck &amp; cruise.</p>",
        url: "https://visitduluth.com/event/cruise/",
        start_date: "2026-07-25 19:00:00",
        end_date: "2026-07-25 21:00:00",
        timezone: "America/Chicago",
        all_day: false,
        venue: { venue: "Vista Fleet", address: "323 Harbor Dr", city: "Duluth" },
        cost_details: { currency_symbol: "$", values: ["1", "22"] },
        categories: [{ name: "Tours" }, { name: "On the Water" }],
      },
      visitDuluthSource,
      AT,
    );
    expect(e).not.toBeNull();
    expect(e!.title).toBe("Vista Fleet Sunset Cruise");
    expect(e!.start).toBe("2026-07-25T19:00:00-05:00");
    expect(e!.end).toBe("2026-07-25T21:00:00-05:00");
    expect(e!.cost).toMatchObject({ kind: "paid", priceMin: 1, priceMax: 22 });
    expect(e!.location).toMatchObject({ venueName: "Vista Fleet", street: "323 Harbor Dr" });
    expect(e!.description).toContain("Vista Star's deck & cruise");
    expect(e!.categories).toEqual(["Tours", "On the Water"]);
    expect(e!.source.confidence).toBe("medium");
    expect(e!.source.extractionMethod).toBe("structured-api");
  });

  it("reads free and unknown cost correctly (unknown != free)", () => {
    const free = mapTribeEvent({ id: 1, title: "Free Talk", start_date: "2026-07-25 12:00:00", cost_details: { values: ["0"] } }, visitDuluthSource, AT);
    const unknown = mapTribeEvent({ id: 2, title: "Mystery", start_date: "2026-07-25 12:00:00" }, visitDuluthSource, AT);
    expect(free!.cost.kind).toBe("free");
    expect(unknown!.cost.kind).toBe("unknown");
  });
});
