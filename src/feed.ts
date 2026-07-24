import { emitFeed } from "./emit.js";
import { FeedMetaSchema, EVENT_TYPES, type DuluthEvent, type EventType } from "./schema.js";
import { nowIso, slug } from "./normalize.js";

/** Sub-feed selection — the criteria a subscriber encodes in the feed URL. */
export interface FeedFilter {
  sources?: string[]; // match if a token is a substring of the source slug (e.g. "legistar", "pdd")
  types?: EventType[];
  confidence?: ("high" | "medium" | "low")[];
  multiDay?: boolean;
  inDuluth?: boolean;
}

const isEventType = (s: string): s is EventType => (EVENT_TYPES as readonly string[]).includes(s);

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
    return true;
  });
}

/** Human-readable calendar name reflecting the active filter (shows up in the subscriber's app). */
function feedName(f: FeedFilter): string {
  const bits: string[] = [];
  if (f.types?.length) bits.push(f.types.join("/"));
  if (f.sources?.length) bits.push(f.sources.join("/"));
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
