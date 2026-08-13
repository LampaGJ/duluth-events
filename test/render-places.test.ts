import { describe, it, expect } from "vitest";
import { renderPlaces } from "../src/render-places.js";
import { renderIndex, type Row } from "../src/render-index.js";
import { PLACES } from "../src/places.js";
import { placeSpecs } from "../src/feeds-config.js";

const BASE = "https://example.test/duluth-events";

/** Every place feed with a count, mirroring the shape build.ts assembles. */
const rowsWithCounts = (count: (id: string) => number): Row[] =>
  placeSpecs().map((s) => ({
    title: s.title,
    desc: s.desc,
    count: count(s.file.replace(/^place\/|\.ics$/g, "")),
    file: s.file,
    group: s.group,
  }));

describe("venue directory", () => {
  it("lists EVERY registered place, including ones with no events", () => {
    // The bug this page exists to fix: 62 of 77 venue feeds were served but unreachable, because
    // the landing page lists only the busiest 15 and hides zero-count feeds entirely.
    const html = renderPlaces(rowsWithCounts(() => 0), BASE);
    for (const p of PLACES) {
      expect(html, `missing place ${p.id}`).toContain(`/feeds/place/${p.id}.ics`);
    }
  });

  it("gives every place a subscribe link and an .ics link", () => {
    const html = renderPlaces(rowsWithCounts(() => 1), BASE);
    for (const p of PLACES) {
      expect(html).toContain(`webcal://example.test/duluth-events/feeds/place/${p.id}.ics`);
      expect(html).toContain(`${BASE}/feeds/place/${p.id}.ics`);
    }
  });

  it("shows each place's real event count, not a placeholder", () => {
    const html = renderPlaces(rowsWithCounts((id) => (id === PLACES[0]!.id ? 42 : 0)), BASE);
    expect(html).toContain("42");
  });

  it("escapes venue names that contain HTML-significant characters", () => {
    // Real registry names include apostrophes ("Wussow's") and ampersands; an unescaped & would
    // produce invalid markup on a page listing every venue we have.
    const html = renderPlaces(rowsWithCounts(() => 0), BASE);
    expect(html).not.toMatch(/&(?!amp;|lt;|gt;|#)/);
  });

  it("is reachable from the landing page", () => {
    // A directory nobody can find is the same bug one level up.
    const rows = rowsWithCounts(() => 3);
    const index = renderIndex(rows, 14, "2026-07-31T00:00:00.000Z", BASE);
    expect(index).toContain(`${BASE}/places.html`);
  });

  it("states the total and the how-many-are-live count honestly", () => {
    const html = renderPlaces(rowsWithCounts((id) => (id === PLACES[0]!.id ? 5 : 0)), BASE);
    expect(html).toContain(`${PLACES.length} in all`);
    expect(html).toContain("1 with events");
  });

  it("carries the same derived attribution as the landing page", () => {
    // This page publishes the same venue addresses, so it owes the same credits.
    const html = renderPlaces(rowsWithCounts(() => 0), BASE);
    expect(html).toContain("OpenStreetMap");
  });
});
