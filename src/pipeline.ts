import { SOURCES, type AdapterKind } from "./sources.js";
import type { Adapter } from "./adapters/types.js";
import { importIcs } from "./adapters/ical-import.js";
import { importStructuredApi } from "./adapters/structured-api.js";
import { importJsonLd } from "./adapters/jsonld.js";
import { importHtml } from "./adapters/html-scrape.js";
import { importPdfLlm } from "./adapters/pdf-llm.js";
import { dedupe } from "./dedupe.js";
import { emitFeed } from "./emit.js";
import { FeedMetaSchema, type DuluthEvent } from "./schema.js";
import { nowIso } from "./normalize.js";
import { logger } from "./logger.js";

const ADAPTERS: Record<AdapterKind, Adapter> = {
  ical: importIcs,
  "structured-api": importStructuredApi,
  jsonld: importJsonLd,
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
  ics: string;
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
      const evs = await ADAPTERS[s.adapter](s);
      perSource[s.name] = evs.length;
      all.push(...evs);
      logger.info({ source: s.name, count: evs.length }, "fetched source");
    } catch (err) {
      failures.push(s.name);
      logger.error({ source: s.name, err: err instanceof Error ? err.message : String(err) }, "source failed");
    }
  }

  const merged = dedupe(all);
  const meta = FeedMetaSchema.parse({
    name: "Duluth Events — All Sources",
    description: "Aggregated Duluth, MN events from multiple sources. Each event carries its source and confidence.",
    generatedAt: nowIso(),
  });
  const ics = emitFeed(merged, meta);

  logger.info({ fetchedTotal: all.length, merged: merged.length, failures }, "pipeline complete");
  return { ics, stats: { fetchedTotal: all.length, merged: merged.length, perSource, failures } };
}
