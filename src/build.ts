import { mkdir, rm, writeFile } from "node:fs/promises";
import { runPipeline } from "./pipeline.js";
import { buildFeed, filterEvents } from "./feed.js";
import { SPECS, placeSpecs } from "./feeds-config.js";
import { renderIndex, type Row } from "./render-index.js";
import { renderPlaces } from "./render-places.js";
import { logger } from "./logger.js";

/**
 * Static-site generator for GitHub Pages. Runs the pipeline once, then writes a CURATED set of
 * pre-filtered `.ics` sub-feeds (static hosting can't filter by query param) plus a landing page.
 * A scheduled GitHub Action re-runs this and deploys `public/` to Pages. HTML rendering itself lives
 * in `render-index.ts`, which has no top-level side effects and so is unit-testable.
 */

const OUT = "public";
const BASE = (process.env.PAGES_BASE_URL ?? "https://lampagj.github.io/duluth-events").replace(/\/$/, "");

const { events, stats } = await runPipeline();

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/feeds/place`, { recursive: true });
await writeFile(`${OUT}/.nojekyll`, "");

const allSpecs = [...SPECS, ...placeSpecs()];
const rows: Row[] = [];
for (const spec of allSpecs) {
  await writeFile(`${OUT}/feeds/${spec.file}`, buildFeed(events, spec.filter), "utf8");
  rows.push({ title: spec.title, desc: spec.desc, count: filterEvents(events, spec.filter).length, file: spec.file, group: spec.group });
}
await writeFile(`${OUT}/index.html`, renderIndex(rows, Object.keys(stats.perSource).length, new Date().toISOString(), BASE), "utf8");
await writeFile(`${OUT}/places.html`, renderPlaces(rows, BASE), "utf8");

logger.info({ feeds: allSpecs.length, events: events.length, sources: Object.keys(stats.perSource).length, out: OUT }, "static site built");
