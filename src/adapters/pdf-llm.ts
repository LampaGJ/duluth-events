import type { DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";

/**
 * PDF -> LLM extraction adapter (confidence: LOW) — STUB.
 *
 * For the sources that have no feed at all and only publish PDFs (City Parks & Rec seasonal
 * brochure, Duluth Public Library press-release PDFs). Planned pipeline:
 *   1. fetch the PDF bytes (native fetch)
 *   2. extract text  (recommended: `unpdf` — lightweight, Node-friendly; add as a dep)
 *   3. LLM structured-extraction of text -> DuluthEvent[] validated against DuluthEventSchema,
 *      forced through `extractionMethod: "pdf-llm-extract"` so the schema caps confidence at "low"
 *      (a brochure guess can never validate as high-confidence — that's the anti-fabrication gate).
 *   4. carry `source.notes` with the brochure edition/date so stale seasons are visible.
 *
 * This is the highest-value NEXT step (it's the only way the Parks/Library events reach the feed),
 * but it requires an LLM API integration + key, so it is intentionally left as a typed stub that
 * returns [] rather than fabricating events. Wire it when the LLM extraction step is approved.
 */
export const importPdfLlm: Adapter = async (source: SourceDef): Promise<DuluthEvent[]> => {
  logger.warn(
    { source: source.name },
    "pdf-llm adapter is a stub — needs PDF text extraction + LLM structuring (see src/adapters/pdf-llm.ts); no events emitted yet",
  );
  return [];
};
