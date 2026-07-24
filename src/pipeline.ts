import { SOURCES, type AdapterKind } from "./sources.js";
import type { Adapter } from "./adapters/types.js";
import { importIcs } from "./adapters/ical-import.js";
import { importStructuredApi } from "./adapters/structured-api.js";
import { importJsonLd } from "./adapters/jsonld.js";
import { importRec1 } from "./adapters/rec1.js";
import { importHtml } from "./adapters/html-scrape.js";
import { importPdfLlm } from "./adapters/pdf-llm.js";
import { dedupe } from "./dedupe.js";
import { finalizeEvent } from "./classify.js";
import type { DuluthEvent } from "./schema.js";
import { logger } from "./logger.js";

const ADAPTERS: Record<AdapterKind, Adapter> = {
  ical: importIcs,
  "structured-api": importStructuredApi,
  jsonld: importJsonLd,
  rec1: importRec1,
  html: importHtml,
  "pdf-llm": importPdfLlm,
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
  }

  const merged = dedupe(all);
  logger.info({ fetchedTotal: all.length, merged: merged.length, failures }, "pipeline complete");
  return { events: merged, stats: { fetchedTotal: all.length, merged: merged.length, perSource, failures } };
}
