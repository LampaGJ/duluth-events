import { writeFile } from "node:fs/promises";
import { runPipeline } from "./pipeline.js";
import { logger } from "./logger.js";

/** Run the pipeline once and write the merged feed to a file (default: duluth-events.ics). */
const out = process.argv[2] ?? "duluth-events.ics";
const { ics, stats } = await runPipeline();
await writeFile(out, ics, "utf8");
logger.info({ ...stats, out, bytes: ics.length }, `wrote ${out}`);
