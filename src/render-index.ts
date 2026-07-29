import { GROUPS, type Group } from "./feeds-config.js";

/**
 * Landing-page HTML rendering. Split out of `build.ts` so it can be unit-tested without running the
 * live pipeline — `build.ts` is a top-level script (`await runPipeline()` at module scope), so
 * importing it for a test would hit all 14+ live sources on every test run.
 */

export interface Row {
  title: string;
  desc: string;
  count: number;
  file: string;
  group: Group;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderIndex(rows: Row[], sourceCount: number, builtAt: string, base: string): string {
  const webcalBase = base.replace(/^https?:\/\//, "webcal://");
  // An empty sub-feed is a dead link, not a feature. Suppress it from the page; the file still
  // ships, so a subscriber whose bookmark predates the emptiness keeps working.
  const shown = rows.filter((r) => r.count > 0);
  // 77 place feeds cannot all be listed and stay scannable — cap "By venue" to the busiest, with the
  // rest still on disk (see venueNote below) so an existing bookmark keeps resolving.
  const BY_VENUE_LIMIT = 15;
  // Sort is scoped to the "By venue" branch ONLY. Every other group keeps its curated order from
  // feeds-config.ts — e.g. "Start here" is deliberately Everything -> This weekend -> Family &
  // all-ages -> Free -> Drop-in, "the feeds most people actually want" in that order, not by count.
  // Do not hoist `.sort(...)` out of this ternary to apply to every group — that silently discards
  // every curated ordering in feeds-config.ts in favor of count-descending everywhere. Guarded by
  // "renders every non-venue group in feeds-config.ts array order, not count order" below.
  const capped = GROUPS.flatMap((g) => {
    const rowsInGroup = shown.filter((r) => r.group === g);
    return g === "By venue" ? [...rowsInGroup].sort((a, b) => b.count - a.count).slice(0, BY_VENUE_LIMIT) : rowsInGroup;
  });
  const venueTotal = shown.filter((r) => r.group === "By venue").length;
  const venueNote =
    venueTotal > BY_VENUE_LIMIT
      ? `Showing the ${BY_VENUE_LIMIT} busiest of ${venueTotal} venue feeds; all are on disk at <code>/feeds/place/&lt;id&gt;.ics</code>.`
      : "";
  const sections = GROUPS.filter((g) => capped.some((r) => r.group === g))
    .map((g) => {
      const items = capped
        .filter((r) => r.group === g)
        .map(
          (r) => `      <tr>
        <td><strong>${esc(r.title)}</strong><br><span class="d">${esc(r.desc)}</span></td>
        <td class="n">${r.count}</td>
        <td class="l"><a href="${webcalBase}/feeds/${r.file}">Subscribe</a> · <a href="${base}/feeds/${r.file}">.ics</a></td>
      </tr>`,
        )
        .join("\n");
      return `  <h2>${esc(g)}</h2>\n  <table>\n    <tbody>\n${items}\n    </tbody>\n  </table>`;
    })
    .join("\n");
  const hidden = rows.length - shown.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Duluth Events — subscribable calendar feeds</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin-bottom: .2rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: #888; margin: 2rem 0 .2rem; }
  .sub { color: #666; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: .55rem .4rem; border-top: 1px solid #8884; vertical-align: top; }
  .d { color: #777; font-size: .88em; }
  .n { text-align: right; font-variant-numeric: tabular-nums; color: #777; white-space: nowrap; }
  .l { white-space: nowrap; }
  a { color: #06c; }
  code { background: #8881; padding: .1em .3em; border-radius: 3px; }
  footer { margin-top: 2.5rem; color: #888; font-size: .85em; }
</style>
</head>
<body>
  <h1>Duluth Events</h1>
  <p class="sub">Public Duluth-area events from ${sourceCount} sources, normalized into one subscribable calendar. Pick a feed, click <strong>Subscribe</strong> (opens your calendar app), or use the <code>.ics</code> URL.</p>
${sections}
  <footer>
    <p>Every event keeps its origin, confidence, type and facets (<code>X-SOURCE-*</code>, <code>X-EVENT-TYPE</code>, <code>X-AUDIENCE</code>, <code>X-COST-TIER</code>, <code>X-ACCESS</code>, …).</p>
    <p><strong>Tags are derived from what the source actually said.</strong> A missing tag means the publisher was silent, not that the answer is no — an event absent from <em>Free</em> may still be free, and one absent from <em>Wheelchair access stated</em> may still be accessible. Rubrics: <code>docs/tagging-rubrics.md</code>.</p>
    ${venueNote ? `<p>${venueNote}</p>` : ""}
    <p>Venue addresses derived from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © OpenStreetMap contributors, ODbL.</p>
    <p>${sourceCount} sources · ${capped.length} feeds${hidden > 0 ? ` (${hidden} currently empty, hidden)` : ""} · rebuilt every ~6 hours · last build ${esc(builtAt)}.</p>
  </footer>
</body>
</html>
`;
}
