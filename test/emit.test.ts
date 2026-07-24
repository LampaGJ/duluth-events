import { describe, it, expect } from "vitest";
import { emitFeed, formatCost } from "../src/emit.js";
import { FeedMetaSchema } from "../src/schema.js";
import { makeEvent } from "./factory.js";

/** Unfold RFC 5545 line folding (CRLF + space/tab) so we can match logical lines. */
const unfold = (s: string): string => s.replace(/\r\n[ \t]/g, "");

describe("emitFeed", () => {
  const meta = FeedMetaSchema.parse({ generatedAt: "2026-04-20T09:00:00-05:00" });

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
