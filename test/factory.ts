import { DuluthEventSchema, type DuluthEvent } from "../src/schema.js";

/** Build a valid DuluthEvent for tests; pass overrides to vary fields. */
export function makeEvent(overrides: Record<string, unknown> = {}): DuluthEvent {
  return DuluthEventSchema.parse({
    uid: "perfect-duluth-day:abc@duluth-events",
    title: "Homegrown Kickoff Show",
    start: "2026-05-01T19:00:00-05:00",
    end: "2026-05-01T22:00:00-05:00",
    location: { venueName: "Pizza Lucé" },
    source: {
      name: "Perfect Duluth Day",
      type: "ics-feed",
      url: "https://perfectduluthday.com/duluth-events/?ical=1",
      extractionMethod: "ics-import",
      retrievedAt: "2026-04-20T09:00:00-05:00",
      confidence: "high",
    },
    ...overrides,
  });
}
