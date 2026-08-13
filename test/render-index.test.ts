import { describe, it, expect } from "vitest";
import { renderIndex, type Row } from "../src/render-index.js";
import { SPECS } from "../src/feeds-config.js";

const BASE = "https://example.test/duluth-events";

/** Extract just the "Start here" section's table body, so title order can be read off the markup. */
function startHereSection(html: string): string {
  const start = html.indexOf("<h2>Start here</h2>");
  const end = html.indexOf("<h2>", start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

/** renderIndex HTML-escapes titles (`&` -> `&amp;`, etc.) — match what actually lands in markup. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

describe("renderIndex row ordering", () => {
  // Deliberately assign counts that DISAGREE with curated order — if row order were driven by
  // count (descending), "This weekend" (100) would render before "Everything" (1). This makes the
  // test load-bearing: it fails under a count-based sort, not just under a shuffled/no-op one.
  const startHereRows: Row[] = [
    { title: "Everything", desc: "d", count: 1, file: "all.ics", group: "Start here" },
    { title: "This weekend", desc: "d", count: 100, file: "weekend.ics", group: "Start here" },
    { title: "Family & all-ages", desc: "d", count: 50, file: "family.ics", group: "Start here" },
    { title: "Free", desc: "d", count: 10, file: "free.ics", group: "Start here" },
    { title: "Drop-in", desc: "d", count: 5, file: "drop-in.ics", group: "Start here" },
  ];

  it("renders 'Start here' in feeds-config.ts curated array order, not count order", () => {
    // Guard against the fixture itself drifting out of sync with feeds-config.ts.
    const curatedTitles = SPECS.filter((s) => s.group === "Start here").map((s) => s.title);
    expect(startHereRows.map((r) => r.title)).toEqual(curatedTitles);

    const html = renderIndex(startHereRows, 15, "2026-07-28T00:00:00Z", BASE);
    const section = startHereSection(html);
    const positions = curatedTitles.map((t) => section.indexOf(esc(t)));
    expect(positions.every((p) => p !== -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("still sorts 'By venue' by count descending, independent of curated order elsewhere", () => {
    const rows: Row[] = [
      { title: "Quiet Venue", desc: "d", count: 1, file: "place/quiet-venue.ics", group: "By venue" },
      { title: "Busy Venue", desc: "d", count: 40, file: "place/busy-venue.ics", group: "By venue" },
      { title: "Medium Venue", desc: "d", count: 10, file: "place/medium-venue.ics", group: "By venue" },
    ];
    const html = renderIndex(rows, 15, "2026-07-28T00:00:00Z", BASE);
    const busy = html.indexOf("Busy Venue");
    const medium = html.indexOf("Medium Venue");
    const quiet = html.indexOf("Quiet Venue");
    expect(busy).toBeLessThan(medium);
    expect(medium).toBeLessThan(quiet);
  });
});
