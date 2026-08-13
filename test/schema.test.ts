import { describe, it, expect } from "vitest";
import { SourceSchema } from "../src/schema.js";
import { makeEvent } from "./factory.js";

describe("DuluthEventSchema", () => {
  it("parses a valid event and applies defaults", () => {
    const e = makeEvent();
    expect(e.status).toBe("confirmed");
    expect(e.cost.kind).toBe("unknown");
    expect(e.timezone).toBe("America/Chicago");
    expect(e.location.city).toBe("Duluth");
    expect(e.location.inDuluth).toBe(true);
    expect(e.alsoListedIn).toEqual([]);
  });

  it("rejects an event whose end precedes its start", () => {
    expect(() => makeEvent({ start: "2026-05-01T22:00:00-05:00", end: "2026-05-01T19:00:00-05:00" })).toThrow();
  });

  it("rejects paid cost with priceMax < priceMin", () => {
    expect(() => makeEvent({ cost: { kind: "paid", priceMin: 20, priceMax: 10 } })).toThrow();
  });

  it("accepts a well-formed paid cost", () => {
    const e = makeEvent({ cost: { kind: "paid", priceMin: 10, priceMax: 15 } });
    expect(e.cost).toMatchObject({ kind: "paid", priceMin: 10, priceMax: 15, currency: "USD" });
  });
});

describe("SourceSchema confidence ceiling (anti-fabrication invariant)", () => {
  const at = "2026-04-20T09:00:00-05:00";

  it("caps pdf-llm-extract at low — a brochure guess cannot claim high confidence", () => {
    const base = { name: "Parks brochure", type: "pdf-brochure", extractionMethod: "pdf-llm-extract", retrievedAt: at } as const;
    expect(SourceSchema.safeParse({ ...base, confidence: "high" }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...base, confidence: "medium" }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...base, confidence: "low" }).success).toBe(true);
  });

  it("requires ics-import to be high", () => {
    const base = { name: "PDD", type: "ics-feed", extractionMethod: "ics-import", retrievedAt: at } as const;
    expect(SourceSchema.safeParse({ ...base, confidence: "medium" }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...base, confidence: "high" }).success).toBe(true);
  });

  it("allows html-scrape to be medium or low but not high", () => {
    const base = { name: "DECC", type: "html-calendar", extractionMethod: "html-scrape", retrievedAt: at } as const;
    expect(SourceSchema.safeParse({ ...base, confidence: "high" }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...base, confidence: "medium" }).success).toBe(true);
  });
});

import { PlaceSchema, PlaceRefSchema, AddressSchema, DuluthEventSchema } from "../src/schema.js";

describe("PlaceSchema", () => {
  it("accepts a fully specified place", () => {
    const p = PlaceSchema.parse({
      id: "bent-paddle-taproom",
      name: "Bent Paddle Taproom",
      nameAliases: ["bent paddle brewing", "bent paddle taproom"],
      addressAliases: ["1832 w michigan st"],
      address: { city: "Duluth", state: "MN", street: "1832 W Michigan St" },
      provenance: { source: "osm", ref: "way/123456", retrievedAt: "2026-07-28T00:00:00-05:00" },
    });
    expect(p.address.inDuluth).toBe(true);
    expect(p.rooms).toEqual([]);
  });

  it("rejects an id that is not a stable slug", () => {
    const base = {
      name: "X", nameAliases: [], addressAliases: [],
      address: { city: "Duluth", state: "MN" },
      provenance: { source: "manual" as const },
    };
    expect(() => PlaceSchema.parse({ ...base, id: "Bent Paddle" })).toThrow();
    expect(() => PlaceSchema.parse({ ...base, id: "" })).toThrow();
  });

  it("requires provenance — a machine-fetched address is not a hand-typed one", () => {
    expect(() =>
      PlaceSchema.parse({
        id: "x", name: "X", nameAliases: [], addressAliases: [],
        address: { city: "Duluth", state: "MN" },
      }),
    ).toThrow();
  });
});

describe("PlaceRefSchema", () => {
  it("defaults provisional to false", () => {
    expect(PlaceRefSchema.parse({ id: "x", name: "X" }).provisional).toBe(false);
  });
});

describe("DuluthEvent place fields", () => {
  it("accepts an event with no place at all (unresolved)", () => {
    const e = makeEvent();
    expect(e.place).toBeUndefined();
  });

  it("carries the source's raw venue claim alongside the resolved place", () => {
    const e = makeEvent({ venueRaw: "Bent Paddle Brewing", place: { id: "bent-paddle-taproom", name: "Bent Paddle Taproom" } });
    expect(e.venueRaw).toBe("Bent Paddle Brewing");
    expect(e.place?.provisional).toBe(false);
  });
});
