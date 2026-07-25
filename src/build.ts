import { mkdir, rm, writeFile } from "node:fs/promises";
import { runPipeline } from "./pipeline.js";
import { buildFeed, filterEvents } from "./feed.js";
import { GROUPS, SPECS, type Group } from "./feeds-config.js";
import { logger } from "./logger.js";

/**
 * Static-site generator for GitHub Pages. Runs the pipeline once, then writes a CURATED set of
 * pre-filtered `.ics` sub-feeds (static hosting can't filter by query param) plus a landing page.
 * A scheduled GitHub Action re-runs this and deploys `public/` to Pages.
 */

const OUT = "public";
const BASE = (process.env.PAGES_BASE_URL ?? "https://lampagj.github.io/duluth-events").replace(/\/$/, "");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Row {
  title: string;
  desc: string;
  count: number;
  file: string;
  group: Group;
}

function renderIndex(rows: Row[], sourceCount: number, builtAt: string): string {
  const webcalBase = BASE.replace(/^https?:\/\//, "webcal://");
  // An empty sub-feed is a dead link, not a feature. Suppress it from the page; the file still
  // ships, so a subscriber whose bookmark predates the emptiness keeps working.
  const shown = rows.filter((r) => r.count > 0);
  const sections = GROUPS.filter((g) => shown.some((r) => r.group === g))
    .map((g) => {
      const items = shown
        .filter((r) => r.group === g)
        .map(
          (r) => `      <tr>
        <td><strong>${esc(r.title)}</strong><br><span class="d">${esc(r.desc)}</span></td>
        <td class="n">${r.count}</td>
        <td class="l"><a href="${webcalBase}/feeds/${r.file}">Subscribe</a> · <a href="${BASE}/feeds/${r.file}">.ics</a></td>
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
    <p>${sourceCount} sources · ${shown.length} feeds${hidden > 0 ? ` (${hidden} currently empty, hidden)` : ""} · rebuilt every ~6 hours · last build ${esc(builtAt)}.</p>
  </footer>
</body>
</html>
`;
}

const { events, stats } = await runPipeline();

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/feeds`, { recursive: true });
await writeFile(`${OUT}/.nojekyll`, "");

const rows: Row[] = [];
for (const spec of SPECS) {
  await writeFile(`${OUT}/feeds/${spec.file}`, buildFeed(events, spec.filter), "utf8");
  rows.push({ title: spec.title, desc: spec.desc, count: filterEvents(events, spec.filter).length, file: spec.file, group: spec.group });
}
await writeFile(`${OUT}/index.html`, renderIndex(rows, Object.keys(stats.perSource).length, new Date().toISOString()), "utf8");

logger.info({ feeds: SPECS.length, events: events.length, sources: Object.keys(stats.perSource).length, out: OUT }, "static site built");
