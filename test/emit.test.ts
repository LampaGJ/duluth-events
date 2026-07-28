import { describe, it, expect } from "vitest";
import { emitFeed, formatCost } from "../src/emit.js";
import { FeedMetaSchema } from "../src/schema.js";
import { makeEvent } from "./factory.js";
import { finalizeEvent } from "../src/classify.js";

/** Unfold RFC 5545 line folding (CRLF + space/tab) so we can match logical lines. */
const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, "");

const META = FeedMetaSchema.parse({ generatedAt: "2026-04-20T09:00:00-05:00" });

describe("emitFeed", () => {
  const meta = META;

  it("emits a valid VCALENDAR carrying the event, its cost, and its provenance", () => {
    const ics = unfold(emitFeed([makeEvent({ cost: { kind: "free" }, categories: ["music"] })], meta));
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:Homegrown Kickoff Show");
    expect(ics).toContain("X-SOURCE-CONFIDENCE:high");
    expect(ics).toContain("X-COST:Free");
    expect(ics).toContain("CATEGORIES:music");
    expect(ics).toMatch(/Source: Perfect Duluth Day/);
  });

  it("emits REFRESH-INTERVAL / X-PUBLISHED-TTL so calendar clients auto-refresh", () => {
    const ics = unfold(emitFeed([makeEvent()], meta));
    expect(ics).toMatch(/X-PUBLISHED-TTL/);
  });

  it("records fuzzy-merge corroborators as X-ALSO-LISTED-IN", () => {
    const e = makeEvent();
    const withAlso = { ...e, alsoListedIn: [{ ...e.source, name: "DoDuluth" }] };
    const ics = unfold(emitFeed([withAlso], meta));
    expect(ics).toContain("X-ALSO-LISTED-IN:DoDuluth");
  });
});

describe("formatCost", () => {
  it("renders each cost kind", () => {
    expect(formatCost({ kind: "free" })).toBe("Free");
    expect(formatCost({ kind: "unknown" })).toBe("Not specified");
    expect(formatCost({ kind: "donation", note: "suggested $5" })).toBe("Donation (suggested $5)");
    expect(formatCost({ kind: "paid", priceMin: 10, priceMax: 15, currency: "USD" })).toBe("$10–$15");
    expect(formatCost({ kind: "paid", priceMin: 20, currency: "USD" })).toBe("$20");
  });
});

describe("place properties", () => {
  it("emits place id, name, and provisional flag when resolved", () => {
    const ics = unfold(emitFeed([finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe" }))], META));
    expect(ics).toContain("X-PLACE-ID:wussows-concert-cafe");
    expect(ics).toContain("X-PLACE-NAME:Wussow's Concert Cafe");
    expect(ics).toContain("X-PLACE-PROVISIONAL:false");
  });

  it("emits nothing when the venue is a sentinel", () => {
    const ics = unfold(emitFeed([finalizeEvent(makeEvent({ venueRaw: "See listing" }))], META));
    expect(ics).not.toContain("X-PLACE-ID");
  });

  it("marks an unregistered venue provisional with a ~-prefixed id", () => {
    const ics = unfold(emitFeed([finalizeEvent(makeEvent({ venueRaw: "Wild State Cider" }))], META));
    expect(ics).toContain("X-PLACE-ID:~wild-state-cider");
    expect(ics).toContain("X-PLACE-PROVISIONAL:true");
  });

  // formatLocation changed both signature and semantics in the AddressSchema migration
  // (Loc -> DuluthEvent; loc.venueName -> e.place?.name ?? e.venueRaw; loc.room -> e.place?.room).
  // Nothing asserted on LOCATION before this, so dropping the canonical name or the street silently
  // passed. NB: e.place?.room is inert today — no adapter populates PlaceRefSchema.room, exactly as
  // none populated the old location.room. It is reserved, not covered.
  it("renders LOCATION as the canonical place name plus the stated address", () => {
    const ics = unfold(
      emitFeed([finalizeEvent(makeEvent({ venueRaw: "Bent Paddle Brewing", location: { city: "Duluth", state: "MN", street: "1832 W Michigan St" } }))], META),
    );
    // Canonical registry name, NOT the raw "Bent Paddle Brewing" the source claimed, then
    // street, then the city line. Commas inside the value are RFC 5545 escaped.
    expect(ics).toContain("LOCATION:Bent Paddle Brewing Co. — Brewery + Taproom\\, 1832 W Michigan St\\, Duluth\\, MN");
  });

  it("falls back to venueRaw in LOCATION when the venue resolves to no place", () => {
    const ics = unfold(emitFeed([finalizeEvent(makeEvent({ venueRaw: "See listing", location: { city: "Duluth", state: "MN" } }))], META));
    expect(ics).toContain("LOCATION:See listing\\, Duluth\\, MN");
  });

  it("wraps a long X-PLACE-NAME with RFC 5545 line folding, and unfold() recovers the logical line", () => {
    const longName = "Greater Downtown Duluth Multi-Purpose Community Event and Gathering Center";
    const raw = emitFeed([finalizeEvent(makeEvent({ venueRaw: longName }))], META);
    // Prove this test actually exercises folding rather than passing vacuously: the RAW
    // (unfolded) output must NOT contain the logical line unbroken.
    expect(raw).not.toContain(`X-PLACE-NAME:${longName}`);
    const ics = unfold(raw);
    expect(ics).toContain(`X-PLACE-NAME:${longName}`);
  });
});
