import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AgeSchema, CostSchema, DuluthEventSchema, type DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";
import { DEFAULT_TZ, makeUid, nowIso, wallTimeToIso } from "../normalize.js";

/**
 * @displayName Curated Event File
 * @strategicPurpose Some real, public programming is published only as hand-written prose on a page
 *   with no feed, no JSON-LD and no stable markup — the Excalibur Con gaming schedule is the case
 *   that forced this. The doctrine's ladder (feed -> deterministic parse -> LLM) has no rung for
 *   "sentences a human wrote once for a single weekend", and a regex over prose would be a fragile
 *   guess dressed as an extraction. A transcribed file is the honest bottom rung: a human read it,
 *   the file records WHEN and FROM WHERE, and the confidence tier never claims more than that.
 * @tacticalObjective Read a reviewed JSON file of events, validate it, and emit normalized
 *   DuluthEvents whose provenance points at the page a human read.
 *
 * Fields beginning with `_` are documentation FOR THE NEXT READER (why this file exists, what was
 * corrected, what was deliberately omitted and why) and are ignored here. They are the audit trail
 * that makes a hand-transcribed source reviewable instead of merely asserted.
 */
const ManualEventSchema = z
  .object({
    /** Stable within the file — becomes the sourceEventId, so it must not be renamed casually. */
    id: z.string().min(1),
    title: z.string().min(1),
    /** Local calendar date, YYYY-MM-DD. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "date must be YYYY-MM-DD" }),
    /** Local wall-clock start, HH:MM. Required unless the entry is all-day. */
    start: z.string().regex(/^\d{2}:\d{2}$/, { error: "start must be HH:MM" }).optional(),
    end: z.string().regex(/^\d{2}:\d{2}$/, { error: "end must be HH:MM" }).optional(),
    /** Last day of a run — for an all-day entry spanning the weekend. */
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "endDate must be YYYY-MM-DD" }).optional(),
    allDay: z.boolean().default(false),
    /** Room inside the source's venue. Never the venue itself — see SourceDef.venue. */
    room: z.string().optional(),
    /** Overrides SourceDef.venue for the odd off-site entry (a con afterparty at a hotel bar). */
    venue: z.string().optional(),
    description: z.string().optional(),
    cost: CostSchema.optional(),
    age: AgeSchema.optional(),
    categories: z.array(z.string()).default([]),
  })
  .refine((e) => e.allDay || e.start !== undefined, {
    error: "a timed entry needs `start`; set allDay:true when the publisher states no time",
    path: ["start"],
  });

const ManualFileSchema = z.looseObject({ events: z.array(ManualEventSchema).min(1) });

export type ManualEvent = z.infer<typeof ManualEventSchema>;

function toIso(date: string, clock: string | undefined, tz: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = (clock ?? "00:00").split(":").map(Number);
  return wallTimeToIso(y!, mo!, d!, h!, mi!, 0, tz);
}

export function mapManualEvent(raw: ManualEvent, source: SourceDef, retrievedAt: string, tz = DEFAULT_TZ): DuluthEvent | null {
  const venueName = raw.venue?.trim() || source.venue?.trim() || "See listing";
  const start = toIso(raw.date, raw.allDay ? undefined : raw.start, tz);
  // An all-day run ends at the START of the day after its last day, per the ICS convention that a
  // DTEND is exclusive; a timed entry ends only if the publisher stated an end.
  const end = raw.allDay
    ? raw.endDate
      ? toIso(new Date(Date.parse(`${raw.endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10), undefined, tz)
      : undefined
    : raw.end
      ? toIso(raw.date, raw.end, tz)
      : undefined;

  const descParts: string[] = [];
  if (raw.room) descParts.push(`Room: ${raw.room}`);
  if (raw.description) descParts.push(raw.description);

  const candidate = {
    uid: makeUid(source.name, raw.id, raw.title, start, venueName),
    title: raw.title,
    description: descParts.length ? descParts.join("\n") : undefined,
    start,
    end,
    allDay: raw.allDay,
    timezone: tz,
    venueRaw: venueName,
    location: { city: "Duluth", state: "MN", inDuluth: true },
    cost: raw.cost,
    age: raw.age,
    categories: raw.categories,
    eventType: source.eventType,
    status: "confirmed" as const,
    source: {
      name: source.name,
      type: source.type,
      url: source.url,
      sourceEventId: raw.id,
      extractionMethod: "manual" as const,
      retrievedAt,
      // Never above `medium`: a human read a page once, and the page can change under us silently.
      confidence: source.confidence,
      verified: false,
      notes: source.notes,
    },
  };

  const parsed = DuluthEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logger.warn({ source: source.name, title: raw.title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid manual event");
  return null;
}

/** Curated, hand-transcribed events from a reviewed JSON file under `data/manual/`. */
export const importManual: Adapter = async (source: SourceDef): Promise<DuluthEvent[]> => {
  if (!source.file) throw new Error(`manual: source "${source.name}" has no file`);
  const parsed = ManualFileSchema.safeParse(JSON.parse(await readFile(source.file, "utf8")));
  if (!parsed.success) {
    // Loud, not soft: a malformed curated file is an authoring mistake, and silently shipping zero
    // events would look exactly like "the convention posted nothing".
    throw new Error(`manual: ${source.file} failed validation — ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  }
  const retrievedAt = nowIso();
  return parsed.data.events.map((e) => mapManualEvent(e, source, retrievedAt)).filter((e): e is DuluthEvent => e !== null);
};
