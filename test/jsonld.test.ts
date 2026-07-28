import { describe, it, expect } from "vitest";
import { mapJsonLdEvent } from "../src/adapters/jsonld.js";
import type { SourceDef } from "../src/sources.js";

const AT = "2026-07-23T09:00:00-05:00";
const pdd: SourceDef = {
  name: "Perfect Duluth Day",
  adapter: "jsonld",
  url: "https://perfectduluthday.com/duluth-events/list/",
  type: "html-calendar",
  confidence: "medium",
  enabled: true,
};

// Real shape observed from PDD's embedded JSON-LD (2026-07-23).
const karaoke = {
  "@context": "http://schema.org",
  "@type": "Event",
  name: "Karaoke",
  description: "&lt;p&gt;The Flame Nightclub in Duluth hosts karaoke every Thursday night.&lt;/p&gt;\\n",
  image: "https://www.perfectduluthday.com/wp-content/uploads/2022/02/Flame-Karaoke.jpg",
  url: "https://www.perfectduluthday.com/the-event/karaoke-at-duluth-flame-2026-2026-07-23/",
  eventStatus: "https://schema.org/EventScheduled",
  startDate: "2026-07-23T22:00:00-05:00",
  endDate: "2026-07-24T02:00:00-05:00",
  location: { "@type": "Place", name: "Flame Nightclub Duluth", address: { "@type": "PostalAddress", streetAddress: "1 W Superior St", addressLocality: "Duluth", addressRegion: "MN" } },
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

describe("mapJsonLdEvent", () => {
  it("maps a schema.org Event with jsonld method, medium confidence, decoded description, free cost", () => {
    const e = mapJsonLdEvent(karaoke, pdd, AT);
    expect(e).not.toBeNull();
    expect(e!.title).toBe("Karaoke");
    expect(e!.start).toBe("2026-07-23T22:00:00-05:00");
    expect(e!.end).toBe("2026-07-24T02:00:00-05:00");
    expect(e!.venueRaw).toBe("Flame Nightclub Duluth");
    expect(e!.location).toMatchObject({ street: "1 W Superior St", city: "Duluth" });
    expect(e!.description).toBe("The Flame Nightclub in Duluth hosts karaoke every Thursday night.");
    expect(e!.cost.kind).toBe("free");
    expect(e!.imageUrl).toContain("Flame-Karaoke.jpg");
    expect(e!.source.extractionMethod).toBe("jsonld");
    expect(e!.source.confidence).toBe("medium");
  });

  it("reads a paid offer with a price range", () => {
    const e = mapJsonLdEvent({ ...karaoke, offers: [{ price: "10" }, { price: "20" }] }, pdd, AT);
    expect(e!.cost).toMatchObject({ kind: "paid", priceMin: 10, priceMax: 20 });
  });

  it("treats a date-only startDate as all-day", () => {
    const e = mapJsonLdEvent({ ...karaoke, startDate: "2026-08-01", endDate: undefined }, pdd, AT);
    expect(e!.allDay).toBe(true);
    expect(e!.start).toBe("2026-08-01T00:00:00-05:00");
  });

  it("drops an Event with no name or start", () => {
    expect(mapJsonLdEvent({ "@type": "Event", startDate: "2026-08-01T10:00:00-05:00" }, pdd, AT)).toBeNull();
  });
});
