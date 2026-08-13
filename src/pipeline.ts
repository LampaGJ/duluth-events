import { SOURCES, type AdapterKind } from "./sources.js";
import type { Adapter } from "./adapters/types.js";
import { importIcs } from "./adapters/ical-import.js";
import { importStructuredApi } from "./adapters/structured-api.js";
import { importJsonLd } from "./adapters/jsonld.js";
import { importRec1 } from "./adapters/rec1.js";
import { importHtml } from "./adapters/html-scrape.js";
import { importPdfLlm } from "./adapters/pdf-llm.js";
import { importManual } from "./adapters/manual.js";
import { dedupe } from "./dedupe.js";
import { finalizeEvent } from "./classify.js";
import type { DuluthEvent } from "./schema.js";
import { logger } from "./logger.js";
import { progress } from "./progress.js";

const ADAPTERS: Record<AdapterKind, Adapter> = {
  ical: importIcs,
  "structured-api": importStructuredApi,
  jsonld: importJsonLd,
  rec1: importRec1,
  html: importHtml,
  "pdf-llm": importPdfLlm,
  manual: importManual,
};

export interface PipelineStats {
  fetchedTotal: number;
  merged: number;
  perSource: Record<string, number>;
  failures: string[];
}

export interface PipelineResult {
  events: DuluthEvent[];
  stats: PipelineStats;
}

/** Ingest every enabled source -> normalize+validate (in the adapters) -> fuzzy-merge -> emit ICS. */
export async function runPipeline(): Promise<PipelineResult> {
  const enabled = SOURCES.filter((s) => s.enabled);
  const all: DuluthEvent[] = [];
  const perSource: Record<string, number> = {};
  const failures: string[] = [];

  // Heartbeat so a run past the two-minute mark can be polled from `reports/.progress/build.json`
  // instead of blocked on. Ticked AFTER each source settles, so `done` counts sources resolved
  // (fetched or failed) rather than sources attempted — a hung source shows as a stalled count,
  // which is exactly the signal worth having.
  const p = progress("build", { total: enabled.length });
  let settled = 0;
  // Emit at zero before the first fetch. Ticking only on completion means a slow first source (the
  // proxy-routed ones can take minutes) leaves NO snapshot on disk, and a missing file reads exactly
  // like a job that never started — the ambiguity this heartbeat exists to remove.
  p.tick(0, { source: null, events: 0, failures: 0 });

  for (const s of enabled) {
    try {
      logger.info({ source: s.name }, "fetching source");
      const evs = (await ADAPTERS[s.adapter](s)).map(finalizeEvent); // typify + derive multiDay
      perSource[s.name] = evs.length;
      all.push(...evs);
      logger.info({ source: s.name, count: evs.length }, "fetched source");
    } catch (err) {
      failures.push(s.name);
      logger.error({ source: s.name, err: err instanceof Error ? err.message : String(err) }, "source failed");
    }
    p.tick(++settled, { source: s.name, events: all.length, failures: failures.length });
  }

  const merged = dedupe(all);
  p.done({ fetchedTotal: all.length, merged: merged.length, failures: failures.length });
  logger.info({ fetchedTotal: all.length, merged: merged.length, failures }, "pipeline complete");
  return { events: merged, stats: { fetchedTotal: all.length, merged: merged.length, perSource, failures } };
}
