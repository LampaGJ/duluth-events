import { writeFile } from "node:fs/promises";
import { runPipeline } from "./pipeline.js";
import { buildFeed } from "./feed.js";
import { logger } from "./logger.js";

/** Run the pipeline once and write the full merged feed to a file (default: duluth-events.ics). */
const out = process.argv[2] ?? "duluth-events.ics";
const { events, stats } = await runPipeline();
const ics = buildFeed(events);
await writeFile(out, ics, "utf8");
logger.info({ ...stats, out, bytes: ics.length }, `wrote ${out}`);
