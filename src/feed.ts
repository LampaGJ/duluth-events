import { emitFeed } from "./emit.js";
import {
  FeedMetaSchema,
  EVENT_TYPES,
  AUDIENCES,
  ACCESS_FEATURES,
  COST_TIERS,
  GEO_SCOPES,
  REGISTRATIONS,
  SETTINGS,
  TIMES_OF_DAY,
  type AccessFeature,
  type Audience,
  type CostTier,
  type DuluthEvent,
  type EventType,
  type GeoScope,
  type Registration,
  type Setting,
  type TimeOfDay,
} from "./schema.js";
import { nowIso, slug } from "./normalize.js";

/**
 * Sub-feed selection — the criteria a subscriber encodes in the feed URL.
 *
 * Array fields are OR-within / AND-across: `type=class&audience=kids` means "a class AND for kids",
 * while `audience=kids,all-ages` means "either". `access` is the exception — it is AND-within, since
 * asking for wheelchair+ASL means you need both.
 */
export interface FeedFilter {
  sources?: string[]; // match if a token is a substring of the source slug (e.g. "legistar", "pdd")
  types?: EventType[];
  confidence?: ("high" | "medium" | "low")[];
  multiDay?: boolean;
  inDuluth?: boolean;
  corroborated?: boolean; // confirmed by >=1 other source (alsoListedIn non-empty)

  // --- facets ---
  audience?: Audience[];
  /** Exclude events carrying any of these audience tags. `excludeAudience: ["adults-only"]` is the
   *  honest form of "suitable for kids" when a source states a 21+ door policy but never states
   *  "all ages" — absence of a restriction is weaker evidence than a claim, and is labelled as such. */
  excludeAudience?: Audience[];
  costTier?: CostTier[];
  registration?: Registration[];
  setting?: Setting[];
  geoScope?: GeoScope[];
  access?: AccessFeature[]; // AND-within: every requested accommodation must be present
  timeOfDay?: TimeOfDay[];
  weekend?: boolean;
  recurring?: boolean;
  alcohol?: boolean;
  publicAdmission?: ("public" | "restricted" | "unknown")[];
  homeAway?: "home" | "away";
  /** false excludes institutional non-events ("Final exams", "Faculty appointments begin"). */
  institutionalNotice?: boolean;
  /** Registered place id — see `place-registry.ts`. Never matches a provisional (`~`-prefixed) id
   *  via this filter alone; place feeds are only ever built from `PLACE_INDEX.all`. */
  placeId?: string;
}

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (s: string): s is T =>
    (allowed as readonly string[]).includes(s);

const isEventType = oneOf(EVENT_TYPES);

/** Parse a URL query object (Fastify request.query) into a FeedFilter. Unknown values are ignored. */
export function parseFilter(q: Record<string, unknown>): FeedFilter {
  const list = (v: unknown): string[] =>
    typeof v === "string"
      ? v
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      : [];
  const bool = (v: unknown): boolean | undefined => (v === undefined ? undefined : /^(1|true|yes)$/i.test(String(v)));

  const f: FeedFilter = {};
  const sources = list(q.source ?? q.sources);
  if (sources.length) f.sources = sources;
  const types = list(q.type ?? q.types).filter(isEventType);
  if (types.length) f.types = types;
  const conf = list(q.confidence).filter((c): c is "high" | "medium" | "low" => c === "high" || c === "medium" || c === "low");
  if (conf.length) f.confidence = conf;
  f.multiDay = bool(q.multiDay ?? q.multiday);
  f.inDuluth = bool(q.inDuluth ?? q.induluth);
  f.corroborated = bool(q.corroborated);

  const audience = list(q.audience).filter(oneOf(AUDIENCES));
  if (audience.length) f.audience = audience;
  const costTier = list(q.cost ?? q.costTier ?? q.costtier).filter(oneOf(COST_TIERS));
  if (costTier.length) f.costTier = costTier;
  const registration = list(q.registration).filter(oneOf(REGISTRATIONS));
  if (registration.length) f.registration = registration;
  const setting = list(q.setting).filter(oneOf(SETTINGS));
  if (setting.length) f.setting = setting;
  const geoScope = list(q.geo ?? q.geoScope ?? q.geoscope).filter(oneOf(GEO_SCOPES));
  if (geoScope.length) f.geoScope = geoScope;
  const access = list(q.access).filter(oneOf(ACCESS_FEATURES));
  if (access.length) f.access = access;
  const timeOfDay = list(q.time ?? q.timeOfDay ?? q.timeofday).filter(oneOf(TIMES_OF_DAY));
  if (timeOfDay.length) f.timeOfDay = timeOfDay;
  const admission = list(q.admission ?? q.publicAdmission ?? q.publicadmission).filter(oneOf(["public", "restricted", "unknown"] as const));
  if (admission.length) f.publicAdmission = admission;
  const ha = String(q.homeAway ?? q.homeaway ?? "").toLowerCase();
  if (ha === "home" || ha === "away") f.homeAway = ha;
  const place = String(q.place ?? q.placeId ?? q.placeid ?? "").trim();
  if (place) f.placeId = place;
  f.weekend = bool(q.weekend);
  f.recurring = bool(q.recurring);
  f.alcohol = bool(q.alcohol);
  f.institutionalNotice = bool(q.institutionalNotice ?? q.institutionalnotice ?? q.notices);
  return f;
}

export function filterEvents(events: DuluthEvent[], f: FeedFilter): DuluthEvent[] {
  return events.filter((e) => {
    if (f.sources?.length) {
      const s = slug(e.source.name);
      if (!f.sources.some((tok) => s.includes(tok))) return false;
    }
    if (f.types?.length && !f.types.includes(e.eventType)) return false;
    if (f.confidence?.length && !f.confidence.includes(e.source.confidence)) return false;
    if (f.multiDay !== undefined && e.multiDay !== f.multiDay) return false;
    if (f.inDuluth !== undefined && e.location.inDuluth !== f.inDuluth) return false;
    if (f.corroborated !== undefined && e.alsoListedIn.length >= 1 !== f.corroborated) return false;

    const x = e.facets;
    if (f.audience?.length && !f.audience.some((a) => x.audience.includes(a))) return false;
    if (f.excludeAudience?.length && f.excludeAudience.some((a) => x.audience.includes(a))) return false;
    if (f.costTier?.length && !f.costTier.includes(x.costTier)) return false;
    if (f.registration?.length && !f.registration.includes(x.registration)) return false;
    if (f.setting?.length && !f.setting.includes(x.setting)) return false;
    if (f.geoScope?.length && !f.geoScope.includes(x.geoScope)) return false;
    if (f.access?.length && !f.access.every((a) => x.access.includes(a))) return false; // AND-within
    if (f.timeOfDay?.length && !f.timeOfDay.includes(x.timeOfDay)) return false;
    if (f.publicAdmission?.length && !f.publicAdmission.includes(x.publicAdmission)) return false;
    if (f.weekend !== undefined && x.weekend !== f.weekend) return false;
    if (f.recurring !== undefined && x.recurring !== f.recurring) return false;
    if (f.alcohol !== undefined && x.alcohol !== f.alcohol) return false;
    if (f.homeAway !== undefined && x.homeAway !== f.homeAway) return false;
    if (f.institutionalNotice !== undefined && x.institutionalNotice !== f.institutionalNotice) return false;
    if (f.placeId !== undefined && e.place?.id !== f.placeId) return false;
    return true;
  });
}

/** Human-readable calendar name reflecting the active filter (shows up in the subscriber's app). */
function feedName(f: FeedFilter): string {
  const bits: string[] = [];
  if (f.types?.length) bits.push(f.types.join("/"));
  if (f.sources?.length) bits.push(f.sources.join("/"));
  if (f.audience?.length) bits.push(f.audience.join("/"));
  if (f.costTier?.length) bits.push(f.costTier.join("/"));
  if (f.access?.length) bits.push(f.access.join("+"));
  if (f.geoScope?.length) bits.push(f.geoScope.join("/"));
  if (f.setting?.length) bits.push(f.setting.join("/"));
  if (f.timeOfDay?.length) bits.push(f.timeOfDay.join("/"));
  if (f.weekend === true) bits.push("weekend");
  if (f.multiDay === false) bits.push("single-day");
  if (f.multiDay === true) bits.push("multi-day");
  return bits.length ? `Duluth Events — ${bits.join(", ")}` : "Duluth Events — All Sources";
}

/** Build an ICS document for a (possibly filtered) set of events. */
export function buildFeed(events: DuluthEvent[], filter: FeedFilter = {}): string {
  const selected = filterEvents(events, filter);
  const meta = FeedMetaSchema.parse({
    name: feedName(filter),
    description: "Aggregated Duluth, MN events. Each event carries its source, confidence, and type.",
    generatedAt: nowIso(),
  });
  return emitFeed(selected, meta);
}
