import { describe, it, expect } from "vitest";
import { emitFeed } from "../src/emit.js";
import { finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";
import { FeedMetaSchema } from "../src/schema.js";

const meta = FeedMetaSchema.parse({ generatedAt: "2026-07-31T00:00:00-05:00" });

/** ICS escapes `;` as `\;`, so an undecoded entity surfaces as `&#038\;` — match either form. */
const ENTITY = /&(#\d+|#x[0-9a-f]+|[a-zA-Z]{2,8})\\?;/i;

describe("entity decoding at the emission boundary", () => {
  it("decodes numeric entities in the title a subscriber actually sees", () => {
    // Verbatim from the live corpus (Wild State Cider / Visit Duluth, tribe-rest sources).
    const ics = emitFeed([finalizeEvent(makeEvent({ title: "Lydia Boyum &#038; Ryan Lane" }))], meta);
    expect(ics).toContain("Lydia Boyum & Ryan Lane");
    expect(ics).not.toMatch(/Boyum &#038/);
  });

  it("decodes curly-quote entities", () => {
    const ics = emitFeed([finalizeEvent(makeEvent({ title: "Book Signing: &#8220;Remember the Main&#8221; by Meg Gorzycki" }))], meta);
    expect(ics).toContain("“Remember the Main”");
  });

  it("decodes named entities in categories", () => {
    const ics = emitFeed([finalizeEvent(makeEvent({ title: "X", categories: ["Arts &amp; Culture", "Entertainment"] }))], meta);
    const cats = /^CATEGORIES:(.*)$/m.exec(ics.replace(/\r\n[ \t]/g, ""))![1]!;
    expect(cats).toContain("Arts & Culture");
    expect(cats).not.toContain("&amp");
  });

  it("decodes entities in the description body", () => {
    const ics = emitFeed([finalizeEvent(makeEvent({ title: "X", description: "Beer &amp; brats at the pub" }))], meta);
    expect(ics.replace(/\r\n[ \t]/g, "")).toContain("Beer & brats");
  });

  it("decodes entities in the venue line", () => {
    const ics = emitFeed([finalizeEvent(makeEvent({ title: "X", venueRaw: "Riverside Bar &#038; Grill" }))], meta);
    const loc = /^LOCATION:(.*)$/m.exec(ics.replace(/\r\n[ \t]/g, ""))![1]!;
    expect(loc).toContain("Riverside Bar & Grill");
  });

  it("emits no undecoded entity in ANY text field", () => {
    // The invariant, not just the cases above: nothing HTML-encoded reaches a calendar app.
    const ics = emitFeed(
      [
        finalizeEvent(makeEvent({ title: "A &#038; B", description: "C &amp; D", categories: ["E &amp; F"], venueRaw: "G &#038; H" })),
        finalizeEvent(makeEvent({ title: "Double &amp;#8217; encoded" })),
      ],
      meta,
    );
    const unfolded = ics.replace(/\r\n[ \t]/g, "");
    for (const line of unfolded.split(/\r?\n/)) {
      if (/^(SUMMARY|DESCRIPTION|LOCATION|CATEGORIES):/.test(line)) {
        expect(line, `undecoded entity survived: ${line}`).not.toMatch(ENTITY);
      }
    }
  });

  it("leaves an ampersand that was never an entity alone", () => {
    // Guard against an over-eager decoder mangling literal text.
    const ics = emitFeed([finalizeEvent(makeEvent({ title: "Rock & Roll at 5 & Dime" }))], meta);
    expect(ics).toContain("Rock & Roll at 5 & Dime");
  });
});
