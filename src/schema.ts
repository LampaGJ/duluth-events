import { z } from "zod";

/**
 * Duluth Events — canonical event contract.
 *
 * @displayName Duluth Event
 * @strategicPurpose The single normalized shape every heterogeneous source (PDD iCal feed,
 *   UMD LiveWhale, the City Parks & Rec seasonal PDF brochure, manual entries) is mapped INTO
 *   before we emit one merged, subscribable ICS feed. It is the trust boundary: an event that
 *   does not validate against this schema never reaches the feed.
 * @tacticalObjective Capture every discrete event with enough structured detail (when, where,
 *   who hosts, what it costs, age policy, category) to (a) round-trip to a fully-detailed RFC 5545
 *   VEVENT and (b) carry per-event PROVENANCE so a low-confidence PDF-LLM extraction is never
 *   presented with the same authority as a direct ICS import.
 *
 * iCal note: RFC 5545 VEVENT has no native COST / HOST / AGE / TICKET fields. Those are carried as
 * (1) machine-readable X- properties AND (2) a human-readable block appended to DESCRIPTION, so the
 * data survives in both feed-parsing clients and plain calendar apps. See ICAL_MAPPING in emit.ts.
 */

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/** WGS84 point for VEVENT GEO / X-APPLE-STRUCTURED-LOCATION. */
export const GeoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/**
 * Where the event happens.
 * @tacticalObjective Emit a clean VEVENT LOCATION string + optional GEO, and enforce the Duluth
 *   scope discipline: `inDuluth=false` marks an across-the-bridge (Superior, WI) or
 *   otherwise-adjacent venue so the merged feed can be filtered to Duluth-proper if desired.
 */
export const LocationSchema = z.object({
  venueName: z.string().min(1), // "NorShor Theatre", "Bayfront Festival Park"
  room: z.string().optional(), // "AMSOIL Arena", "Symphony Hall", "Teatro Zuccone"
  street: z.string().optional(),
  city: z.string().default("Duluth"),
  state: z.string().default("MN"),
  zip: z.string().optional(),
  geo: GeoSchema.optional(),
  /** false => Superior WI / Iron Range / North Shore etc. (adjacent, not Duluth proper). */
  inDuluth: z.boolean().default(true),
});

/**
 * Who runs it (VEVENT ORGANIZER needs a mailto CAL-ADDRESS; without an email we fall back to
 * X-HOST + a DESCRIPTION line rather than fabricating an address).
 */
export const OrganizerSchema = z.object({
  name: z.string().min(1), // "Duluth Public Library", "Zeitgeist Arts"
  email: z.email().optional(),
  url: z.url().optional(),
});

/**
 * Cost. Discriminated on `kind` so "free", "donation", "paid", and "unknown" are distinct,
 * checkable states — "unknown" means the source did not state a price (do NOT infer $0).
 *
 * NB: the `paid` branch's cross-field invariant (priceMax >= priceMin) is enforced by a top-level
 * .refine() on DuluthEventSchema, NOT here — z.discriminatedUnion requires plain ZodObject members,
 * and attaching a .refine() to the `paid` object would make it a ZodEffects and break the union.
 */
export const CostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("free") }),
  z.object({ kind: z.literal("donation"), note: z.string().optional() }), // "free-will donation"
  z.object({
    kind: z.literal("paid"),
    priceMin: z.number().nonnegative(),
    priceMax: z.number().nonnegative().optional(),
    currency: z.string().default("USD"),
    note: z.string().optional(), // "$10 adv / $15 door", "kids under 12 free"
  }),
  z.object({ kind: z.literal("unknown") }),
]);

/** Age policy (VEVENT has no native field -> X-AGE-RESTRICTION + DESCRIPTION line). */
export const AgeSchema = z.object({
  allAges: z.boolean().default(true),
  minAge: z.number().int().nonnegative().optional(), // 18, 21
  note: z.string().optional(), // "21+ after 9pm"
});

/**
 * Confidence ceiling per extraction method — the anti-fabrication invariant made STRUCTURAL.
 * A record only reaches `high` if it came straight from a first-party `.ics`; an LLM reading a
 * brochure is capped at `low`. Enforced by the SourceSchema refine below, so a caller cannot
 * label a PDF-LLM guess as high-confidence and have it validate.
 */
const CONFIDENCE_CEILING = {
  "ics-import": ["high"], // first-party .ics feed
  "structured-api": ["high", "medium"], // documented first-party JSON API (Legistar=high; aggregator REST=medium)
  jsonld: ["medium"], // spec'd schema.org Event JSON-LD embedded in a page
  manual: ["high", "medium"],
  "html-scrape": ["medium", "low"], // stable-selector template parse
  "pdf-parse": ["medium", "low"], // deterministic pdftotext + table/regex
  "pdf-llm-extract": ["low"], // LLM read prose — capped, correctness-checked
} as const satisfies Record<string, readonly ("high" | "medium" | "low")[]>;

/**
 * Provenance — the anti-fabrication core, inherited from agent-duluth-culture-history-expert.
 * @strategicPurpose Every emitted event knows exactly where it came from and how it was extracted,
 *   so the feed can never present a guessed/LLM-parsed event with the authority of a first-party
 *   feed. Downstream can filter by `confidence` or require `verified=true`.
 */
export const SourceSchema = z
  .object({
    name: z.string().min(1), // "Perfect Duluth Day"
    type: z.enum(["ics-feed", "html-calendar", "pdf-brochure", "json-api", "manual"]),
    url: z.url().optional(), // the source page or feed URL
    sourceEventId: z.string().optional(), // native id in the source (stable dedup/update key)
    extractionMethod: z.enum(["ics-import", "structured-api", "jsonld", "html-scrape", "pdf-parse", "pdf-llm-extract", "manual"]),
    retrievedAt: z.iso.datetime({ offset: true }),
    confidence: z.enum(["high", "medium", "low"]),
    verified: z.boolean().default(false),
    notes: z.string().optional(),
  })
  .refine((s) => (CONFIDENCE_CEILING[s.extractionMethod] as readonly ("high" | "medium" | "low")[]).includes(s.confidence), {
    error:
      "confidence exceeds the ceiling for this extractionMethod (ics-import must be high; pdf-llm-extract must be low; html-scrape/pdf-parse are medium|low; manual is high|medium)",
    path: ["confidence"],
  });

export type Source = z.infer<typeof SourceSchema>;

/**
 * Canonical event typification — the controlled vocabulary every entry (rec1 programs, live music,
 * meetings, …) is classified into, so users can subscribe to specific kinds via the feed URL.
 * Duration (single-day vs multi-day class/festival) is carried orthogonally by `multiDay`, so a
 * "single-day classes" sub-feed is `type=class&multiDay=false`.
 */
export const EVENT_TYPES = [
  "live-music",
  "performing-arts", // theater, comedy, dance
  "film",
  "visual-arts", // galleries, exhibits
  "class", // programs, workshops, camps, lessons (rec1)
  "meeting", // government / civic / board
  "market", // farmers market, makers market
  "festival",
  "sports", // leagues, games, athletics
  "family", // kids / all-ages family programming
  "food-drink",
  "education", // lectures, university talks, author events
  "community", // general community / civic events
  "other",
] as const;

export const EVENT_TYPE_SCHEMA = z.enum(EVENT_TYPES);
export type EventType = (typeof EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

export const DuluthEventSchema = z
  .object({
    /** Stable unique id -> VEVENT UID and cross-refresh dedup key. */
    uid: z.string().min(1),

    title: z.string().min(1), // SUMMARY
    description: z.string().optional(), // DESCRIPTION (human body; structured detail appended on emit)

    /** DTSTART / DTEND as ISO-8601 WITH offset; `timezone` carries the IANA zone for RRULE + display.
     *  `timezone` is AUTHORITATIVE: the emitter derives display/RRULE from it; the offset baked into
     *  `start`/`end` is the resolved instant. Do date math off the instant, never the raw offset text. */
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }).optional(),
    allDay: z.boolean().default(false),
    timezone: z.string().default("America/Chicago"),

    location: LocationSchema,
    organizer: OrganizerSchema.optional(),
    cost: CostSchema.default({ kind: "unknown" }),
    categories: z.array(z.string()).default([]), // free-form source CATEGORIES e.g. ["music","all-ages"]
    /** Canonical typification — the controlled vocabulary users subscribe/filter by. */
    eventType: EVENT_TYPE_SCHEMA.default("other"),
    /** true when the event spans more than one calendar day (a multi-week class, a festival run). */
    multiDay: z.boolean().default(false),
    age: AgeSchema.optional(),

    url: z.url().optional(), // canonical event page -> URL
    ticketUrl: z.url().optional(), // -> X-TICKET-URL + DESCRIPTION line
    imageUrl: z.url().optional(), // -> ATTACH;FMTTYPE=image/* or X-IMAGE

    status: z.enum(["confirmed", "tentative", "cancelled"]).default("confirmed"), // STATUS

    rrule: z.string().optional(), // raw RFC 5545 RRULE
    exdates: z.array(z.iso.datetime({ offset: true })).default([]), // EXDATE

    source: SourceSchema, // primary provenance (highest-confidence source after fuzzy merge)
    /** Fuzzy-merge corroborators: other sources this same event was also listed in (e.g. a show in
     *  both PDD and the venue's own feed). Primary stays `source`; these are recorded, not discarded. */
    alsoListedIn: z.array(SourceSchema).default([]),
    lastModified: z.iso.datetime({ offset: true }).optional(), // LAST-MODIFIED
  })
  .refine((e) => !e.end || new Date(e.end) >= new Date(e.start), {
    error: "end must be the same as or after start",
    path: ["end"],
  })
  .refine((e) => e.cost.kind !== "paid" || e.cost.priceMax === undefined || e.cost.priceMax >= e.cost.priceMin, {
    error: "priceMax must be >= priceMin",
    path: ["cost", "priceMax"],
  });

export type DuluthEvent = z.infer<typeof DuluthEventSchema>;

/** Feed-level (VCALENDAR) metadata for the emitted, subscribable ICS. */
export const FeedMetaSchema = z.object({
  name: z.string().default("Duluth Events — All Sources"), // X-WR-CALNAME
  prodId: z.string().default("-//duluth-events//Duluth Events//EN"),
  description: z.string().optional(), // X-WR-CALDESC
  timezone: z.string().default("America/Chicago"),
  ttlSeconds: z.number().int().positive().default(21600), // REFRESH-INTERVAL + X-PUBLISHED-TTL (6h)
  url: z.url().optional(), // published feed URL (the subscribe target)
  generatedAt: z.iso.datetime({ offset: true }),
});

export type FeedMeta = z.infer<typeof FeedMetaSchema>;
