import { DuluthEventSchema, type DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";
import { DEFAULT_TZ, makeUid, nowIso, parseClockTime, safeTimezone, toIsoOffset, wallTimeToIso } from "../normalize.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Route a JSON URL through SCRAPER_PROXY on a residential IP, stripping any render flag (render is
 *  only for HTML pages — a JSON endpoint should return raw JSON). Used for datacenter-IP-blocked
 *  sources (e.g. duluthart.org 422s CI IPs) via a per-source `viaProxy` flag. */
function jsonProxyUrl(proxy: string, url: string): string {
  let base = proxy.replace(/[?&](render|render_js|js_render)=true/gi, (m) => (m[0] === "?" ? "?" : ""));
  base = base.replace(/\?&/, "?").replace(/&&+/g, "&");
  return base.includes("{url}") ? base.replace("{url}", encodeURIComponent(url)) : base + encodeURIComponent(url);
}

async function fetchJson<T>(url: string, viaProxy = false, retries = 1): Promise<T> {
  const proxy = viaProxy ? process.env.SCRAPER_PROXY?.trim() : undefined;
  const target = proxy ? jsonProxyUrl(proxy, url) : url;
  const res = await fetch(target, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json, */*" }, redirect: "follow" });
  if (!res.ok) {
    // Retry once on transient / rate / bot-throttle responses.
    if (retries > 0 && (res.status === 422 || res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500));
      return fetchJson<T>(url, viaProxy, retries - 1);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // A proxy may wrap JSON in an HTML viewer; salvage the JSON body.
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`non-JSON response for ${url}`);
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>|<br\s*\/?>/gi, " ") // block ends -> space
    .replace(/<[^>]+>/g, "") // inline tags (b, i, a, span…) -> nothing, so "Star</b>'s" stays "Star's"
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;|&rsquo;|&#8217;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Legistar (Granicus) Web API — City of Duluth public meetings. confidence: high.
// https://webapi.legistar.com/v1/duluth-mn/events
// ---------------------------------------------------------------------------

interface LegistarEvent {
  EventId: number;
  EventBodyName?: string | null;
  EventDate?: string | null; // "2026-07-27T00:00:00"
  EventTime?: string | null; // "6:00 PM"
  EventLocation?: string | null;
  EventInSiteURL?: string | null;
  EventAgendaFile?: string | null;
  EventComment?: string | null;
}

export function mapLegistarEvent(raw: LegistarEvent, source: SourceDef, retrievedAt: string): DuluthEvent | null {
  if (!raw.EventDate || !raw.EventBodyName) return null;
  const datePart = raw.EventDate.slice(0, 10);
  const [y, mo, d] = datePart.split("-").map(Number);
  if (!y || !mo || !d) return null;

  const t = raw.EventTime ? parseClockTime(raw.EventTime) : null;
  const allDay = !t;
  const start = wallTimeToIso(y, mo, d, t?.hour ?? 0, t?.minute ?? 0, t?.second ?? 0);
  const venueName = raw.EventLocation?.trim() || "See agenda";
  const url = raw.EventInSiteURL && /^https?:\/\//i.test(raw.EventInSiteURL) ? raw.EventInSiteURL : undefined;

  const descParts: string[] = [];
  if (raw.EventComment?.trim()) descParts.push(raw.EventComment.trim());
  if (raw.EventAgendaFile) descParts.push(`Agenda: ${raw.EventAgendaFile}`);

  const candidate = {
    uid: makeUid(source.name, String(raw.EventId), raw.EventBodyName, start, venueName),
    title: `${raw.EventBodyName.trim()} — Public Meeting`,
    description: descParts.length ? descParts.join("\n") : undefined,
    start,
    allDay,
    timezone: DEFAULT_TZ,
    venueRaw: venueName,
    location: { city: "Duluth", state: "MN", inDuluth: true },
    categories: ["government", "public-meeting"],
    eventType: "meeting" as const,
    url,
    status: "confirmed" as const,
    source: {
      name: source.name,
      type: source.type,
      url: source.url,
      sourceEventId: String(raw.EventId),
      extractionMethod: "structured-api" as const,
      retrievedAt,
      confidence: source.confidence, // "high" — the government's own record
      verified: true,
    },
  };

  const parsed = DuluthEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logger.warn({ source: source.name, title: candidate.title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid event");
  return null;
}

async function legistarMapper(source: SourceDef): Promise<DuluthEvent[]> {
  const from = isoDaysAgo(30);
  const url = `${source.url}?$filter=EventDate+ge+datetime'${from}'&$orderby=EventDate&$top=200`;
  const rows = await fetchJson<LegistarEvent[]>(url, source.viaProxy);
  const retrievedAt = nowIso();
  return rows.map((r) => mapLegistarEvent(r, source, retrievedAt)).filter((e): e is DuluthEvent => e !== null);
}

// ---------------------------------------------------------------------------
// The Events Calendar REST API — Visit Duluth. confidence: medium (aggregator).
// https://visitduluth.com/wp-json/tribe/events/v1/events
// ---------------------------------------------------------------------------

interface TribeEvent {
  id: number;
  title?: string;
  description?: string;
  url?: string;
  start_date?: string; // "2026-07-25 19:00:00" (wall time in `timezone`)
  end_date?: string;
  timezone?: string;
  all_day?: boolean;
  venue?: { venue?: string; address?: string; city?: string } | unknown[];
  cost_details?: { currency_symbol?: string; values?: string[] };
  categories?: { name?: string }[];
}
interface TribeResponse {
  events?: TribeEvent[];
}

function parseTribeWall(dt: string, tz: string): string | null {
  const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return wallTimeToIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0"), tz);
}

function tribeCost(cd: TribeEvent["cost_details"]): DuluthEvent["cost"] {
  const values = (cd?.values ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (values.length === 0) return { kind: "unknown" };
  if (values.every((v) => v === 0)) return { kind: "free" };
  const priceMin = Math.min(...values);
  const priceMax = Math.max(...values);
  return { kind: "paid", priceMin, priceMax: priceMax === priceMin ? undefined : priceMax, currency: "USD" };
}

export function mapTribeEvent(raw: TribeEvent, source: SourceDef, retrievedAt: string): DuluthEvent | null {
  if (!raw.start_date || !raw.title) return null;
  const tz = safeTimezone(raw.timezone);
  const start = parseTribeWall(raw.start_date, tz);
  if (!start) return null;
  const end = raw.end_date ? parseTribeWall(raw.end_date, tz) : undefined;

  const venue = raw.venue && !Array.isArray(raw.venue) ? (raw.venue as { venue?: string; address?: string; city?: string }) : undefined;
  const venueName = venue?.venue?.trim() || "See listing";
  const url = raw.url && /^https?:\/\//i.test(raw.url) ? raw.url : undefined;

  const candidate = {
    uid: makeUid(source.name, String(raw.id), raw.title, start, venueName),
    title: stripHtml(raw.title),
    description: raw.description ? stripHtml(raw.description).slice(0, 1500) : undefined,
    start,
    end: end ?? undefined,
    allDay: raw.all_day === true,
    timezone: tz,
    venueRaw: venueName,
    location: {
      street: venue?.address?.trim() || undefined,
      city: venue?.city?.trim() || "Duluth",
      state: "MN",
      inDuluth: !/\bsuperior\b/i.test(venue?.city ?? ""),
    },
    cost: tribeCost(raw.cost_details),
    categories: (raw.categories ?? []).map((c) => c.name).filter((n): n is string => Boolean(n)),
    url,
    status: "confirmed" as const,
    source: {
      name: source.name,
      type: source.type,
      url: source.url,
      sourceEventId: String(raw.id),
      extractionMethod: "structured-api" as const,
      retrievedAt,
      confidence: source.confidence, // "medium" — deterministic, but an aggregator re-listing others
      verified: false,
    },
  };

  const parsed = DuluthEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logger.warn({ source: source.name, title: candidate.title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid event");
  return null;
}

async function tribeRestMapper(source: SourceDef): Promise<DuluthEvent[]> {
  const url = `${source.url}?per_page=50&start_date=${isoDaysAgo(0)}`;
  const body = await fetchJson<TribeResponse>(url, source.viaProxy);
  const retrievedAt = nowIso();
  return (body.events ?? []).map((r) => mapTribeEvent(r, source, retrievedAt)).filter((e): e is DuluthEvent => e !== null);
}

// ---------------------------------------------------------------------------
// Squarespace Events collection JSON — {events page}?format=json -> { upcoming: [...] }.
// confidence: source-dependent (a venue's own calendar = high).
// ---------------------------------------------------------------------------

interface SqEvent {
  id?: string | number;
  title?: string;
  body?: string;
  excerpt?: string;
  fullUrl?: string;
  startDate?: number; // epoch ms
  endDate?: number;
  location?: { addressTitle?: string; addressLine1?: string; addressLine2?: string; mapLat?: number; mapLng?: number };
  tags?: string[];
  categories?: string[];
}

export function mapSquarespaceEvent(raw: SqEvent, source: SourceDef, retrievedAt: string, origin: string): DuluthEvent | null {
  const title = raw.title?.trim();
  if (!title || typeof raw.startDate !== "number") return null;
  const loc = raw.location ?? {};
  const addr = [loc.addressTitle, loc.addressLine1, loc.addressLine2].filter(Boolean).join(" ");
  const superior = /\bsuperior\b/i.test(addr);
  const venueName = loc.addressTitle?.trim() || loc.addressLine2?.trim() || loc.addressLine1?.trim() || "See listing";
  const geo = typeof loc.mapLat === "number" && typeof loc.mapLng === "number" ? { lat: loc.mapLat, lon: loc.mapLng } : undefined;

  const candidate = {
    uid: makeUid(source.name, raw.id != null ? String(raw.id) : undefined, title, toIsoOffset(new Date(raw.startDate)), venueName),
    title,
    description: raw.excerpt || raw.body ? stripHtml(raw.excerpt || raw.body || "").slice(0, 1500) : undefined,
    start: toIsoOffset(new Date(raw.startDate)),
    end: typeof raw.endDate === "number" ? toIsoOffset(new Date(raw.endDate)) : undefined,
    timezone: DEFAULT_TZ,
    venueRaw: venueName,
    location: {
      street: loc.addressLine1?.trim() || undefined,
      city: superior ? "Superior" : "Duluth",
      state: superior ? "WI" : "MN",
      geo,
      inDuluth: !superior,
    },
    categories: [...(raw.tags ?? []), ...(raw.categories ?? [])].filter(Boolean),
    url: raw.fullUrl ? origin + raw.fullUrl : undefined,
    status: "confirmed" as const,
    source: {
      name: source.name,
      type: source.type,
      url: source.url,
      sourceEventId: raw.id != null ? String(raw.id) : undefined,
      extractionMethod: "structured-api" as const,
      retrievedAt,
      confidence: source.confidence,
      verified: false,
    },
  };

  const parsed = DuluthEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logger.warn({ source: source.name, title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid squarespace event");
  return null;
}

async function squarespaceMapper(source: SourceDef): Promise<DuluthEvent[]> {
  const origin = new URL(source.url!).origin;
  const body = await fetchJson<{ upcoming?: SqEvent[] }>(`${source.url}?format=json`, source.viaProxy);
  const retrievedAt = nowIso();
  return (body.upcoming ?? []).map((r) => mapSquarespaceEvent(r, source, retrievedAt, origin)).filter((e): e is DuluthEvent => e !== null);
}

// ---------------------------------------------------------------------------
// Eventeny convention schedule — POST /funcs/dashboard/events/programming/SessionRoute.php.
// confidence: high (the convention's own programming record).
//
// The /events/embed/?ev=…&type=schedule page renders no sessions server-side; its
// getFilteredSessions() posts a multipart form to SessionRoute.php and draws the JSON.
// No auth and no cookie are required, so this is a deterministic structured-API pull.
//
// Two shape facts drive the code below:
//   - `all_sessions` (flat id -> session) is COMPLETE; `list` (grouped by track) is NOT — a session
//     belonging to no track is absent from every group. Excalibur Con: 102 vs 100.
//   - `location` is a ROOM inside one building ("TTRPG Area", "Split Rock Room"), never an address.
//     It must not become venueRaw, because place resolution keys on venue identity and a room string
//     would either resolve to nothing or, worse, invent a venue. The venue comes from source.venue
//     and the room is carried in the description.
//
// TIME — read `start_calendar`/`end_calendar` (naive local wall time) against the response's
// `timezone`, and IGNORE the `start_time`/`end_time` epochs. Eventeny's epochs are internally
// inconsistent with its own rendering: for every one of Excalibur Con's 102 sessions the epoch sits
// a constant 4 hours behind the wall time it displays, which is not the America/Chicago offset
// (CDT = UTC-5) in either direction. Session 104513 renders "11:30 AM" while its epoch decodes to
// 10:30 CDT. Trusting the epoch would ship every convention session an hour early.
// ---------------------------------------------------------------------------

interface EventenySession {
  id?: string;
  title?: string;
  /** Naive LOCAL wall time, "2026-08-15T11:30:00" — authoritative. See epoch note above. */
  start_calendar?: string;
  end_calendar?: string;
  hide_end_time?: string; // "1" -> publisher declined to state an end
  location?: string; // room within the venue
  description?: string;
  track_title?: string;
  tags?: string; // comma-separated publisher tags
  access_type?: string;
  status?: string;
  active?: string;
}
interface EventenyResponse {
  all_sessions?: Record<string, EventenySession>;
  timezone?: string;
  success?: boolean;
  err_msg?: string;
}

/** Eventeny's window bounds are MM-DD-YYYY, not ISO. */
function eventenyDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${d.getUTCFullYear()}`;
}

/** "2026-08-15T11:30:00" (naive local) -> a resolved instant in `tz`. */
function parseEventenyWall(raw: string | undefined, tz: string): string | null {
  const m = raw?.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return wallTimeToIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0"), tz);
}

export function mapEventenySession(raw: EventenySession, source: SourceDef, retrievedAt: string, tz: string): DuluthEvent | null {
  const title = raw.title?.trim();
  if (!title) return null;
  // Only publicly-visible, live sessions. A cancelled or draft session is not an event.
  if (raw.active === "0" || (raw.status && raw.status !== "active")) return null;
  if (raw.access_type && raw.access_type !== "public") return null;

  const start = parseEventenyWall(raw.start_calendar, tz);
  if (!start) return null;
  // hide_end_time is the publisher saying "no stated end" — respect it rather than emitting one.
  const end = raw.hide_end_time === "1" ? undefined : (parseEventenyWall(raw.end_calendar, tz) ?? undefined);

  // The venue is the convention's building, declared on the source; `location` is a room inside it.
  const venueName = source.venue?.trim() || "See listing";
  const room = raw.location?.trim();

  const descParts: string[] = [];
  if (room) descParts.push(`Room: ${room}`);
  if (raw.description?.trim()) descParts.push(stripHtml(raw.description));
  const eventId = new URL(source.url!).searchParams.get("ev");

  const candidate = {
    uid: makeUid(source.name, raw.id, title, start, venueName),
    title: stripHtml(title),
    description: descParts.length ? descParts.join("\n").slice(0, 1500) : undefined,
    start,
    end,
    allDay: false,
    timezone: tz,
    venueRaw: venueName,
    location: { city: "Duluth", state: "MN", inDuluth: true },
    // Set explicitly so finalizeEvent keeps it: everything an Eventeny schedule publishes is a
    // convention session, and no title-level signal would recover that from prose.
    eventType: "convention" as const,
    // Publisher categories — track ("TTRPG") plus its own tags. Doctrine: these outrank our regex.
    categories: [raw.track_title?.trim(), ...(raw.tags ?? "").split(",").map((t) => t.trim())].filter(
      (c): c is string => Boolean(c),
    ),
    url: eventId && raw.id ? `${new URL(source.url!).origin}/events/schedule/?id=${eventId}&session=${raw.id}` : undefined,
    status: "confirmed" as const,
    source: {
      name: source.name,
      type: source.type,
      url: source.url,
      sourceEventId: raw.id,
      extractionMethod: "structured-api" as const,
      retrievedAt,
      confidence: source.confidence, // "high" — the convention's own schedule, first-party
      verified: true,
    },
  };

  const parsed = DuluthEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logger.warn({ source: source.name, title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid eventeny session");
  return null;
}

async function eventenyMapper(source: SourceDef): Promise<DuluthEvent[]> {
  const url = new URL(source.url!);
  const eventId = url.searchParams.get("ev");
  if (!eventId) throw new Error(`eventeny: source "${source.name}" url has no ?ev= event id`);

  // A convention schedule is published once and lives in a single weekend, so ask for a wide window
  // (yesterday .. +18 months) and let the response decide what exists. `track_filter` is left EMPTY
  // on purpose: an embed URL usually pins one track, and we want every track.
  const now = new Date();
  const params = new URLSearchParams({
    post_type: "fetch_filtered_list",
    view_group: "event",
    time_limit_min: eventenyDate(new Date(now.getTime() - 86400000)),
    time_limit_max: eventenyDate(new Date(now.getTime() + 550 * 86400000)),
    event_id: eventId,
    acct_id: "0",
    search: "",
    visibility_filter: "public",
    status_filter: "",
    track_filter: "",
    tag_filter: "",
    session_filter: "",
    guest_filter: "",
    agent_filter: "",
    handler_filter: "",
    location_filter: "",
  });

  const endpoint = `${url.origin}/funcs/dashboard/events/programming/SessionRoute.php`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json, */*", Referer: source.url! },
    body: params,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint} (event ${eventId})`);
  const body = (await res.json()) as EventenyResponse;
  if (body.success === false) throw new Error(`eventeny: ${body.err_msg ?? "request rejected"} (event ${eventId})`);

  const tz = safeTimezone(body.timezone);
  const retrievedAt = nowIso();
  // all_sessions, NOT list: a session with no track is missing from every group in `list`.
  return Object.values(body.all_sessions ?? {})
    .map((s) => mapEventenySession(s, source, retrievedAt, tz))
    .filter((e): e is DuluthEvent => e !== null);
}

// ---------------------------------------------------------------------------

/** Structured first-party JSON API adapter, dispatched by `source.mapper`. */
export const importStructuredApi: Adapter = async (source: SourceDef): Promise<DuluthEvent[]> => {
  if (!source.url) throw new Error(`structured-api: source "${source.name}" has no url`);
  switch (source.mapper) {
    case "legistar":
      return legistarMapper(source);
    case "tribe-rest":
      return tribeRestMapper(source);
    case "squarespace":
      return squarespaceMapper(source);
    case "eventeny":
      return eventenyMapper(source);
    default:
      throw new Error(`structured-api: source "${source.name}" has unknown mapper "${source.mapper ?? "(none)"}"`);
  }
};
