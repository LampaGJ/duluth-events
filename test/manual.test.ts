import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { importManual, mapManualEvent } from "../src/adapters/manual.js";
import { SOURCES, type SourceDef } from "../src/sources.js";

const AT = "2026-08-12T09:00:00-05:00";

const gamingSource: SourceDef = {
  name: "Excalibur Con — Gaming Schedule (MNSWCA)",
  adapter: "manual",
  url: "https://mnswca.org/other-gaming-events",
  file: "data/manual/excalibur-con-gaming.json",
  venue: "Duluth Entertainment Convention Center",
  eventType: "convention",
  type: "manual",
  confidence: "medium",
  enabled: true,
};

describe("mapManualEvent", () => {
  it("maps a timed entry, putting the room in the description and the venue in venueRaw", () => {
    const e = mapManualEvent(
      { id: "swu", title: "Star Wars Unlimited Constructed Tournament", date: "2026-08-15", start: "12:00", room: "Level Up Gaming Pavilion", allDay: false, categories: ["tournament"] },
      gamingSource,
      AT,
    );
    expect(e).not.toBeNull();
    expect(e!.start).toBe("2026-08-15T12:00:00-05:00");
    expect(e!.end).toBeUndefined(); // the publisher stated no end — we do not invent one
    expect(e!.venueRaw).toBe("Duluth Entertainment Convention Center");
    expect(e!.description).toContain("Room: Level Up Gaming Pavilion");
    expect(e!.eventType).toBe("convention");
  });

  it("caps confidence at the source tier and never claims verification", () => {
    const e = mapManualEvent({ id: "x", title: "Anything", date: "2026-08-15", start: "12:00", allDay: false, categories: [] }, gamingSource, AT);
    expect(e!.source.confidence).toBe("medium");
    expect(e!.source.verified).toBe(false);
    expect(e!.source.extractionMethod).toBe("manual");
    // Provenance points at the page a human READ, so a subscriber can go check it.
    expect(e!.source.url).toBe("https://mnswca.org/other-gaming-events");
  });

  it("lets an entry override the venue for an off-site event", () => {
    const e = mapManualEvent(
      { id: "dd", title: "Drink and Draw", date: "2026-08-15", start: "20:00", venue: "Radisson Harborview Tiki Bar", allDay: false, categories: [] },
      gamingSource,
      AT,
    );
    expect(e!.venueRaw).toBe("Radisson Harborview Tiki Bar");
  });

  it("ends an all-day run on the day AFTER its last day, per the exclusive-DTEND convention", () => {
    const e = mapManualEvent(
      { id: "run", title: "Weekend Competition", date: "2026-08-15", endDate: "2026-08-16", allDay: true, categories: [] },
      gamingSource,
      AT,
    );
    expect(e!.allDay).toBe(true);
    expect(e!.start).toBe("2026-08-15T00:00:00-05:00");
    expect(e!.end).toBe("2026-08-17T00:00:00-05:00");
  });
});

describe("the curated Excalibur Con gaming file", () => {
  const source = SOURCES.find((s) => s.adapter === "manual" && s.file === "data/manual/excalibur-con-gaming.json")!;

  it("is registered, enabled, and never claims better than medium confidence", () => {
    expect(source).toBeDefined();
    expect(source.enabled).toBe(true);
    // A human read a page once and the page can change under us — `high` would be a false claim.
    expect(source.confidence).toBe("medium");
  });

  it("loads and every entry lands inside the convention weekend", async () => {
    const events = await importManual(source);
    expect(events.length).toBeGreaterThanOrEqual(21);
    for (const e of events) {
      // The source page's dates are a YEAR STALE; the file corrects them by weekday. If a future
      // edit ever re-applies or drops that shift, an event escapes the 2026-08-15/16 weekend and
      // this fails — which is the whole point of pinning it.
      expect(e.start.slice(0, 10) >= "2026-08-15").toBe(true);
      expect(e.start.slice(0, 10) <= "2026-08-16").toBe(true);
    }
  });

  it("carries the tournaments that the Eventeny schedule endpoint does not publish", async () => {
    const titles = (await importManual(source)).map((e) => e.title);
    expect(titles).toContain("Star Wars Unlimited Constructed Tournament");
    expect(titles).toContain("Disney Lorcana Tournament & Learn to Play");
    expect(titles).toContain("Nostalgix TCG Tournament");
    expect(titles).toContain("Ward the Card Game Tournament");
  });

  it("documents why it exists, what was corrected, and what was left out", () => {
    // The `_`-prefixed keys are the audit trail that makes a hand-transcribed source reviewable.
    // Losing them turns a documented transcription back into an unsourced assertion.
    const raw = JSON.parse(readFileSync(source.file!, "utf8"));
    expect(raw._source).toBe("https://mnswca.org/other-gaming-events");
    expect(raw._transcribedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(raw._dateCorrection.join(" ")).toMatch(/stale/i);
    expect(Object.keys(raw._omitted)).toContain("Artemis Spaceship Bridge Simulator");
  });
});
