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
  maxAge: z.number().int().nonnegative().optional(), // "ages 3-5", "ages 14 & under"
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
// Facets — the orthogonal axes
// ---------------------------------------------------------------------------

/**
 * @displayName Event Facets
 * @strategicPurpose `eventType` answers exactly one question — WHAT is it. Everything else a
 *   subscriber filters on (who it's for, what it costs, whether they can get in the door, whether
 *   it's even in town) is an INDEPENDENT question, and cramming those into a single enum is what
 *   left `family.ics` empty while 103 events carried an explicit age signal. Facets are
 *   multi-valued, orthogonal, and derived by named deterministic rubrics (docs/tagging-rubrics.md),
 *   so sub-feeds are a cross-product instead of a forever-growing enum.
 * @tacticalObjective Carry, per event, the audience / cost tier / registration / setting / access /
 *   admission / timing / recurrence signals that the rubrics could prove from the source text —
 *   each defaulting to an explicit "unknown" rather than a guess, so a filter can distinguish
 *   "we know this is free" from "the source never said".
 */

/** WHO it is for. Multi-valued: a program can be both `kids` and `all-ages`. */
export const AUDIENCES = [
  "all-ages", // explicitly "all ages" / "family friendly" / Family-Friendly category
  "kids", // stated upper bound <= 12, or storytime/toddler/preschool vocabulary
  "teen", // stated band overlapping 13–17, or teen/tween vocabulary
  "adults-only", // stated 18+ / 21+ minimum
  "students", // institutional student-life programming (UMD "Student Activities")
  "seniors", // 55+ / "older adults"
] as const;
export const AUDIENCE_SCHEMA = z.enum(AUDIENCES);
export type Audience = (typeof AUDIENCES)[number];

/** HOW MUCH. Mirrors `cost.kind` but is also inferable from prose when the source has no field. */
export const COST_TIERS = ["free", "donation", "paid", "unknown"] as const;
export type CostTier = (typeof COST_TIERS)[number];

/** HOW you get in. `open` = attend by just showing up; `drop-in` = explicitly no registration. */
export const REGISTRATIONS = ["required", "drop-in", "open", "unknown"] as const;
export type Registration = (typeof REGISTRATIONS)[number];

/** WHERE, physically. `virtual` is not a place — it must never count as Duluth-proper. */
export const SETTINGS = ["indoor", "outdoor", "virtual", "unknown"] as const;
export type Setting = (typeof SETTINGS)[number];

/** WHERE, geographically — replaces the boolean `inDuluth` for anything finer than in/out. */
export const GEO_SCOPES = ["duluth", "twin-ports", "regional", "distant", "virtual"] as const;
export type GeoScope = (typeof GEO_SCOPES)[number];

/** Stated accommodations. Absence means the source was silent, NOT that the event is inaccessible. */
export const ACCESS_FEATURES = ["wheelchair", "asl", "sensory-friendly"] as const;
export const ACCESS_FEATURE_SCHEMA = z.enum(ACCESS_FEATURES);
export type AccessFeature = (typeof ACCESS_FEATURES)[number];

/** WHEN, bucketed from the local start hour. */
export const TIMES_OF_DAY = ["morning", "afternoon", "evening", "late-night", "all-day"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export const FacetsSchema = z.object({
  audience: z.array(AUDIENCE_SCHEMA).default([]),
  costTier: z.enum(COST_TIERS).default("unknown"),
  registration: z.enum(REGISTRATIONS).default("unknown"),
  setting: z.enum(SETTINGS).default("unknown"),
  geoScope: z.enum(GEO_SCOPES).default("duluth"),
  access: z.array(ACCESS_FEATURE_SCHEMA).default([]),
  timeOfDay: z.enum(TIMES_OF_DAY).default("all-day"),
  /** Saturday or Sunday in the event's own timezone. */
  weekend: z.boolean().default(false),
  /** Has an RRULE. Orthogonal to `multiDay` — weekly karaoke recurs but each night is one evening. */
  recurring: z.boolean().default(false),
  /** Alcohol is served / it is a licensed venue. Deliberately NOT an age inference. */
  alcohol: z.boolean().default(false),
  /** Anyone may attend, vs. restricted to an institution's own members/students. */
  publicAdmission: z.enum(["public", "restricted", "unknown"]).default("unknown"),
  /** Athletics only: is the team playing here or travelling. */
  homeAway: z.enum(["home", "away"]).optional(),
  /** An institutional calendar row that is not a public event ("Final exams", "Faculty appointments begin"). */
  institutionalNotice: z.boolean().default(false),
  /** Title says the date moved / the event was called off, while the source's STATUS still says confirmed. */
  rescheduled: z.boolean().default(false),
});

export type Facets = z.infer<typeof FacetsSchema>;

// ---------------------------------------------------------------------------
// Place entities
// ---------------------------------------------------------------------------

/**
 * @displayName Address
 * @strategicPurpose WHERE on earth an event happens, kept strictly separate from WHAT the venue is
 *   called. Conflating the two is why `venueName` ended up carrying strings like
 *   "Bismarck, ND, MDU Resources Community Bowl" and 59 out-of-state games shipped inside
 *   `duluth-proper.ics`.
 * @tacticalObjective Carry the geographic facts a feed consumer needs, and nothing else.
 */
export const AddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().default("Duluth"),
  state: z.string().default("MN"),
  zip: z.string().optional(),
  geo: GeoSchema.optional(),
  /** false => Superior WI / Iron Range / an away game. Derived from `city`, never hand-set. */
  inDuluth: z.boolean().default(true),
});
export type Address = z.infer<typeof AddressSchema>;

/**
 * Where the event happens, geographically. The venue's NAME lives on `place` (see PlaceRefSchema) —
 * keeping them separate is what stopped `venueName` carrying strings like
 * "Bismarck, ND, MDU Resources Community Bowl".
 */
export const LocationSchema = AddressSchema;

/** Where a registry fact came from. Required: a fetched address and a typed one are not the same. */
export const PlaceProvenanceSchema = z.object({
  source: z.enum(["osm", "web", "manual"]),
  ref: z.string().optional(), // OSM element id ("way/123456"), or the URL a fact came from
  retrievedAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * @displayName Place
 * @strategicPurpose The canonical venue entity. Cross-source dedupe keys on place identity because
 *   string similarity provably cannot separate true from false merges — venue-token similarity
 *   between CONFIRMED duplicate pairs ranges from 0.13 to 0.83.
 * @tacticalObjective Hold a hand-set stable id (it appears in feed URLs), every normalized alias
 *   that resolves to it, and a canonical address used to enrich events whose source gave none.
 */
export const PlaceSchema = z.object({
  /** Hand-set, stable, lowercase-kebab. Appears in feed URLs, so it must never move. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "place id must be lowercase-kebab (it appears in feed URLs)" }),
  name: z.string().min(1),
  /** Pre-normalized name forms — see normalizeVenueKey(). Resolution is an O(1) lookup, not fuzzy. */
  nameAliases: z.array(z.string()).default([]),
  /** Pre-normalized address forms. This is how an address-only listing merges with a name-only one. */
  addressAliases: z.array(z.string()).default([]),
  address: AddressSchema,
  /** Subdivisions: "The Yard", "AMSOIL Arena", "Council Chambers". Declarative; inert until an adapter populates room. */
  rooms: z.array(z.string()).default([]),
  /** Forward hook for Institution (issue #3): a name, deliberately not yet a reference. */
  operator: z.string().optional(),
  provenance: PlaceProvenanceSchema,
});
export type Place = z.infer<typeof PlaceSchema>;
/** Hand-authored registry input — defaults not yet applied. See PLACES in places.ts. */
export type PlaceInput = z.input<typeof PlaceSchema>;

/**
 * What an event carries. `provisional` = auto-derived from an unregistered string: usable for
 * dedupe, but never given a public feed URL, because no stability promise can be made about it.
 */
export const PlaceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  room: z.string().optional(),
  provisional: z.boolean().default(false),
});
export type PlaceRef = z.infer<typeof PlaceRefSchema>;

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
    /** The source's LITERAL venue string, preserved as provenance and used as the resolution input. */
    venueRaw: z.string().optional(),
    /** Resolved canonical venue. Absent = unresolved (a sentinel, or a string we declined to guess at). */
    place: PlaceRefSchema.optional(),
    organizer: OrganizerSchema.optional(),
    cost: CostSchema.default({ kind: "unknown" }),
    categories: z.array(z.string()).default([]), // free-form source CATEGORIES e.g. ["music","all-ages"]
    /** Canonical typification — the controlled vocabulary users subscribe/filter by. */
    eventType: EVENT_TYPE_SCHEMA.default("other"),
    /** true when the event spans more than one calendar day (a multi-week class, a festival run). */
    multiDay: z.boolean().default(false),
    age: AgeSchema.optional(),
    /** Orthogonal deterministic facets — see FacetsSchema. Derived in finalizeEvent().
     *  `.prefault` (not `.default`): the fallback is INPUT to be parsed, so every nested field
     *  default inside FacetsSchema is applied rather than requiring a fully-built object here. */
    facets: FacetsSchema.prefault({}),

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

// ---------------------------------------------------------------------------
// Reference geodata — vendored City of Duluth ArcGIS layers (committed, offline)
// ---------------------------------------------------------------------------
//
// Field order in every object below is DELIBERATE and matched byte-for-byte by
// `scripts/fetch-arcgis.mjs`'s object-construction order: z.object().parse() rebuilds its output
// key-by-key in SCHEMA declaration order (verified empirically — Zod does not preserve input key
// order), so a mismatch here would silently break the idempotency round-trip test
// (`test/reference-data.test.ts`) even though every individual field still parses correctly. If you
// add/reorder a field, update the fetcher's builder function to match.

/**
 * @displayName Trail Use
 * @strategicPurpose The source's eight loose Y/N/"Yes"/"No" columns (Hiking, MountainBiking,
 *   XCountrySkiing, Snowmobile, Accessible, Horseback, ATV, Adaptive) are one axis — WHAT a trail
 *   permits — logically independent of `Season` (WHEN it's usable). Modeling them as a uniform
 *   array instead of eight boolean fields makes "does this trail permit X" one lookup instead of
 *   eight differently-named properties, and means a ninth activity column added upstream extends
 *   the `activity` union without reshaping every consumer.
 * @tacticalObjective One permitted/not-permitted fact per activity, boolean-normalized from the
 *   source's inconsistent string encodings ("Y"/"N" for six columns, "Yes"/"No" for `Adaptive`) —
 *   see `Trail.raw` for the untouched source string this was derived from.
 */
export const TrailUseSchema = z.object({
  activity: z.enum(["hiking", "mountainBiking", "xcSkiing", "snowmobile", "accessible", "horseback", "atv", "adaptive"]),
  permitted: z.boolean(),
});
export type TrailUse = z.infer<typeof TrailUseSchema>;

/**
 * @displayName Trail
 * @strategicPurpose Vendors the City of Duluth's "Trails - All City" ArcGIS master layer (layer 14
 *   of `Parks/TrailsDuluthService`; layers 0-13 are filtered views over this same schema) as
 *   committed reference data, so trail identity/attributes are available offline and
 *   version-controlled rather than re-fetched live on every build.
 * @tacticalObjective Hold one normalized record per trail segment: the permitted-use axis (`uses`)
 *   separated from the season axis (`season`), human-legible field names in place of the source's
 *   misspelled/inconsistent columns (`Suface` -> `surface`), and the COMPLETE untouched source
 *   attributes under `raw` so no source value — including the ones this schema normalizes away
 *   from (e.g. `raw.Jurisdiction` may be "City" or "City of Duluth" for the same municipal
 *   authority; `raw.Adaptive` is "No" not "N") — is ever silently discarded.
 */
export const TrailSchema = z.object({
  /** Stable entity id: `GlobalID` lowercased with the `{}` braces stripped. Not the source's own
   *  casing/braces (see `globalId`) — normalized once here so every consumer sorts/keys the same way. */
  id: z.string().min(1),
  /** `GlobalID` exactly as ArcGIS returned it (e.g. "{D6440883-...}") — the source's stable UUID. */
  globalId: z.string().min(1),
  objectId: z.number().int(),
  /** 44/800 records have a null `Name` (unnamed trail segments — the layer models trail SEGMENTS,
   *  not named trails; a named trail is usually several segments sharing a `Name`). */
  name: z.string().min(1).nullable(),
  park: z.string().min(1).nullable(),
  /** Raw source string, NOT collapsed: "City" and "City of Duluth" both appear for what is very
   *  likely the same municipal authority, but nothing in the source data proves they're
   *  interchangeable, so this schema declines to invent that equivalence. */
  jurisdiction: z.string().min(1).nullable(),
  /** Raw two-letter source code (HK, BH, MP, XC, BK, MS, SM, CL, RD, HB, XL, DG, ...) — left as a
   *  plain string rather than an enum because the source's own layer description lists the codes as
   *  informal/evolving ("XB - XC and Moutain Biking (none yet)"), so a closed union would be a
   *  fabricated completeness guarantee this dataset doesn't back up. */
  type: z.string().min(1).nullable(),
  status: z.string().min(1).nullable(),
  /** Normalized from raw `Season` ("Summer"/"Winter"/"Both"/null): null (8/800 records) maps to
   *  "both" — the conservative choice, since defaulting to a single season would wrongly exclude a
   *  trail of unstated seasonality from a seasonal search. Raw value preserved at `raw.Season`. */
  season: z.enum(["summer", "winter", "both"]),
  /** `Suface` in the source (sic) — renamed on read; the misspelled raw key survives at `raw.Suface`. */
  surface: z.string().min(1).nullable(),
  rating: z.number().int().nullable(),
  /** The activity axis — see TrailUseSchema. Always all 8 activities, in a fixed order. */
  uses: z.array(TrailUseSchema),
  /** Forward hook for the Institution entity (issue #3) — deliberately a plain string, not a
   *  reference, until that entity exists. The literal source value `"None"` is normalized to
   *  `null` (raw preserved at `raw.PartnerOrganization`); every other value passes through verbatim. */
  partnerOrganization: z.string().min(1).nullable(),
  /** Trail length in miles (source `Mileage`). */
  mileage: z.number().nullable(),
  /** Trail length in the source's projected units (source `SHAPE.STLength()`); geometry itself is
   *  NOT vendored (`returnGeometry=false` — polylines would dominate this artifact) but is available
   *  live from the source service if a future consumer needs it. */
  shapeLength: z.number().nullable(),
  dateOpen: z.iso.datetime({ offset: true }).nullable(),
  constructionYear: z.number().int().nullable(),
  /** Source's own edit watermark for THIS record (epoch ms -> ISO). The artifact-level
   *  `sourceWatermark` in `TrailsArtifactSchema` is the max of this across every record — see there
   *  for why this replaces a wall-clock fetch timestamp. */
  lastEditedDate: z.iso.datetime({ offset: true }),
  /** The complete, untouched ArcGIS `attributes` object for this record (keys sorted alphabetically
   *  by the fetcher for determinism) — the full-fidelity escape hatch for every field this schema
   *  doesn't promote to a named property (`Traverse`, `Position`, `SHT`, `EMVAccess`, `CCT`,
   *  `VisibleRecMap`, `created_user`, `created_data`, `last_edited_user`, and the normalized-away
   *  originals of every field above). */
  raw: z.record(z.string(), z.unknown()),
});
export type Trail = z.infer<typeof TrailSchema>;

/** The committed `data/duluth-trails.json` envelope — one fetch, one layer, many trails. */
export const TrailsArtifactSchema = z
  .object({
    source: z.url(), // the layer's query endpoint
    layerId: z.number().int(),
    /** Max `last_edited_date` across all records, as ISO — the source's own change watermark. NEVER
     *  `Date.now()`: a wall-clock fetch timestamp would dirty this committed file on every re-run
     *  even when upstream data is unchanged, which is exactly the idempotency trap this field exists
     *  to avoid. This value only changes when the City actually edits a trail record. */
    sourceWatermark: z.iso.datetime({ offset: true }),
    recordCount: z.number().int().nonnegative(),
    trails: z.array(TrailSchema),
  })
  .refine((a) => a.recordCount === a.trails.length, { error: "recordCount must equal trails.length", path: ["recordCount"] });
export type TrailsArtifact = z.infer<typeof TrailsArtifactSchema>;

/**
 * @displayName Neighborhood
 * @strategicPurpose Vendors the City of Duluth's 31-neighborhood ArcGIS boundary layer as committed
 *   reference data. Joins to the `neighborhood` free-text field already present in
 *   `data/homegrown-venues.json` (that field is not always an exact match — e.g. "Downtown Duluth /
 *   Central Hillside" spans what this layer models as two separate neighborhoods — so the join is
 *   left to the consumer, not baked in here).
 * @tacticalObjective Hold one record per neighborhood polygon's non-geometric attributes.
 */
export const NeighborhoodSchema = z.object({
  /** Stable entity id: `GlobalID` lowercased (the source already omits `{}` braces for this layer,
   *  unlike Trail's `GlobalID` — normalized the same way regardless, so both entities key alike). */
  id: z.string().min(1),
  /** `GlobalID` exactly as ArcGIS returned it. */
  globalId: z.string().min(1),
  objectId: z.number().int(),
  /** The source's own integer neighborhood id (field `ID`) — distinct from `objectId`, which is an
   *  ArcGIS row identifier with no standalone meaning outside this service. */
  adminId: z.number().int(),
  name: z.string().min(1),
  /** Polygon area in the source's projected units (source `Shape__Area`); geometry itself is NOT
   *  vendored (`returnGeometry=false`) but is available live from the source service if needed. */
  shapeArea: z.number().nullable(),
  shapeLength: z.number().nullable(),
  lastEditedDate: z.iso.datetime({ offset: true }),
  /** The complete, untouched ArcGIS `attributes` object (keys sorted alphabetically), preserving
   *  `created_user`/`created_data`/`last_edited_user` and the un-normalized originals. */
  raw: z.record(z.string(), z.unknown()),
});
export type Neighborhood = z.infer<typeof NeighborhoodSchema>;

/** The committed `data/duluth-neighborhoods.json` envelope. */
export const NeighborhoodsArtifactSchema = z
  .object({
    source: z.url(),
    layerId: z.number().int(),
    sourceWatermark: z.iso.datetime({ offset: true }),
    recordCount: z.number().int().nonnegative(),
    neighborhoods: z.array(NeighborhoodSchema),
  })
  .refine((a) => a.recordCount === a.neighborhoods.length, { error: "recordCount must equal neighborhoods.length", path: ["recordCount"] });
export type NeighborhoodsArtifact = z.infer<typeof NeighborhoodsArtifactSchema>;
