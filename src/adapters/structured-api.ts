import { DuluthEventSchema, type DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";
import { DEFAULT_TZ, makeUid, nowIso, parseClockTime, safeTimezone, toIsoOffset, wallTimeToIso } from "../normalize.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json, */*" }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
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
    location: { venueName, city: "Duluth", state: "MN", inDuluth: true },
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
  const rows = await fetchJson<LegistarEvent[]>(url);
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
    location: {
      venueName,
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
  const body = await fetchJson<TribeResponse>(url);
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
    location: {
      venueName,
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
  const body = await fetchJson<{ upcoming?: SqEvent[] }>(`${source.url}?format=json`);
  const retrievedAt = nowIso();
  return (body.upcoming ?? []).map((r) => mapSquarespaceEvent(r, source, retrievedAt, origin)).filter((e): e is DuluthEvent => e !== null);
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
    default:
      throw new Error(`structured-api: source "${source.name}" has unknown mapper "${source.mapper ?? "(none)"}"`);
  }
};
