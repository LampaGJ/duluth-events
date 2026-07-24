import { mkdir, rm, writeFile } from "node:fs/promises";
import { runPipeline } from "./pipeline.js";
import { buildFeed, filterEvents, type FeedFilter } from "./feed.js";
import { EVENT_TYPES } from "./schema.js";
import { logger } from "./logger.js";

/**
 * Static-site generator for GitHub Pages. Runs the pipeline once, then writes a CURATED set of
 * pre-filtered `.ics` sub-feeds (static hosting can't filter by query param) plus a landing page.
 * A scheduled GitHub Action re-runs this and deploys `public/` to Pages.
 */

const OUT = "public";
const BASE = (process.env.PAGES_BASE_URL ?? "https://lampagj.github.io/duluth-events").replace(/\/$/, "");

interface FeedSpec {
  file: string;
  title: string;
  desc: string;
  filter: FeedFilter;
}

const SPECS: FeedSpec[] = [
  { file: "all.ics", title: "All Duluth events", desc: "Every source, every type.", filter: {} },
  ...EVENT_TYPES.map((t) => ({ file: `${t}.ics`, title: `Type: ${t}`, desc: `Only ${t} events.`, filter: { types: [t] } as FeedFilter })),
  { file: "single-day.ics", title: "Single-day only", desc: "Excludes multi-week / multi-day runs.", filter: { multiDay: false } },
  { file: "multi-day.ics", title: "Multi-day only", desc: "Multi-week classes, festival runs.", filter: { multiDay: true } },
  { file: "classes-single-day.ics", title: "Single-day classes", desc: "One-off classes & workshops.", filter: { types: ["class"], multiDay: false } },
  { file: "duluth-proper.ics", title: "Duluth proper", desc: "Excludes across-the-bridge (Superior, WI).", filter: { inDuluth: true } },
  { file: "high-confidence.ics", title: "High-confidence", desc: "First-party feeds & APIs only.", filter: { confidence: ["high"] } },
  { file: "corroborated.ics", title: "Corroborated", desc: "Confirmed by 2+ independent sources.", filter: { corroborated: true } },
];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderIndex(rows: { title: string; desc: string; count: number; file: string }[], sourceCount: number, builtAt: string): string {
  const webcalBase = BASE.replace(/^https?:\/\//, "webcal://");
  const items = rows
    .map(
      (r) => `      <tr>
        <td><strong>${esc(r.title)}</strong><br><span class="d">${esc(r.desc)}</span></td>
        <td class="n">${r.count}</td>
        <td class="l"><a href="${webcalBase}/feeds/${r.file}">Subscribe</a> · <a href="${BASE}/feeds/${r.file}">.ics</a></td>
      </tr>`,
    )
    .join("\n");
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
  .sub { color: #666; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
  td { padding: .55rem .4rem; border-top: 1px solid #8884; vertical-align: top; }
  .d { color: #777; font-size: .88em; }
  .n { text-align: right; font-variant-numeric: tabular-nums; color: #777; white-space: nowrap; }
  .l { white-space: nowrap; }
  a { color: #06c; }
  code { background: #8881; padding: .1em .3em; border-radius: 3px; }
  footer { margin-top: 2rem; color: #888; font-size: .85em; }
</style>
</head>
<body>
  <h1>Duluth Events</h1>
  <p class="sub">Public Duluth-area events from ${sourceCount} sources, normalized into one subscribable calendar. Pick a feed, click <strong>Subscribe</strong> (opens your calendar app), or use the <code>.ics</code> URL.</p>
  <table>
    <thead><tr><td><strong>Feed</strong></td><td class="n">Events</td><td class="l"></td></tr></thead>
    <tbody>
${items}
    </tbody>
  </table>
  <footer>
    Aggregated from public sources; each event keeps its origin, confidence, and type (<code>X-SOURCE-*</code>, <code>X-EVENT-TYPE</code>). Rebuilt every ~6 hours · last build ${esc(builtAt)}.
  </footer>
</body>
</html>
`;
}

const { events, stats } = await runPipeline();

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/feeds`, { recursive: true });
await writeFile(`${OUT}/.nojekyll`, "");

const rows: { title: string; desc: string; count: number; file: string }[] = [];
for (const spec of SPECS) {
  await writeFile(`${OUT}/feeds/${spec.file}`, buildFeed(events, spec.filter), "utf8");
  rows.push({ title: spec.title, desc: spec.desc, count: filterEvents(events, spec.filter).length, file: spec.file });
}
await writeFile(`${OUT}/index.html`, renderIndex(rows, Object.keys(stats.perSource).length, new Date().toISOString()), "utf8");

logger.info({ feeds: SPECS.length, events: events.length, sources: Object.keys(stats.perSource).length, out: OUT }, "static site built");
