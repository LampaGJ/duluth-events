import ical from "node-ical";
import { DuluthEventSchema, type DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";
import { makeUid, nowIso, toIsoOffset, DEFAULT_TZ } from "../normalize.js";
import { parseVenueString } from "../place-resolve.js";

/** Minimal shape of a node-ical VEVENT component (the library is loosely typed). */
interface VEventLike {
  type?: string;
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: Date;
  end?: Date;
  url?: string | { val?: string };
  categories?: string[];
  status?: string;
  datetype?: string;
  lastmodified?: Date;
  rrule?: { toString(): string };
}

function extractUrl(u: VEventLike["url"]): string | undefined {
  const raw = typeof u === "string" ? u : u?.val;
  return raw && /^https?:\/\//i.test(raw) ? raw : undefined;
}

/**
 * node-ical hands back an rrule.js object whose `.toString()` embeds a DTSTART line
 * (e.g. "DTSTART;TZID=…\nRRULE:FREQ=WEEKLY;COUNT=4"). We only want the bare RRULE value, else the
 * emitter ends up with a duplicate DTSTART. Pull out the RRULE line and strip its prefix.
 */
function extractRrule(rr: VEventLike["rrule"]): string | undefined {
  if (!rr) return undefined;
  const s = rr.toString();
  const line = s.split(/\r?\n/).find((l) => l.startsWith("RRULE:")) ?? s;
  const val = line.replace(/^RRULE:/, "").trim();
  return val.includes("FREQ=") ? val : undefined;
}

function mapStatus(s: string | undefined): DuluthEvent["status"] {
  switch ((s ?? "").toUpperCase()) {
    case "CANCELLED":
      return "cancelled";
    case "TENTATIVE":
      return "tentative";
    default:
      return "confirmed";
  }
}

/** Heuristic: an across-the-bridge venue (Superior, WI) is not Duluth-proper. */
function isInDuluth(location: string | undefined): boolean {
  if (!location) return true;
  return !/\bsuperior\b.*\b(wi|wisconsin)\b|\bsuperior,\s*wi\b/i.test(location);
}

/**
 * ICS-import adapter (confidence: high). Fetches a first-party `.ics` feed and maps each VEVENT
 * into a validated DuluthEvent. Invalid events are dropped with a warning rather than failing the
 * whole source, so one malformed VEVENT can't sink the feed.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Fetch raw iCalendar text with browser-ish headers. Isolated so a challenged source (e.g. PDD,
 * behind a Cloudflare JS challenge) can later be routed through a headless-browser fetcher without
 * touching the mapping logic. Throws a precise diagnostic on non-iCal responses.
 */
async function fetchIcsText(source: SourceDef): Promise<string> {
  const res = await fetch(source.url!, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/calendar, text/plain, */*" },
    redirect: "follow",
  });
  const body = await res.text();
  const looksLikeChallenge = /just a moment|cf-browser-verification|challenge-platform|cf-chl/i.test(body);
  if (!res.ok || looksLikeChallenge) {
    if (res.status === 403 || looksLikeChallenge) {
      throw new Error(`blocked (HTTP ${res.status}) — Cloudflare-style challenge; needs a headless-browser fetch`);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  if (!body.includes("BEGIN:VCALENDAR")) {
    throw new Error(`response was not iCalendar (content-type: ${res.headers.get("content-type") ?? "?"})`);
  }
  return body;
}

export const importIcs: Adapter = async (source: SourceDef): Promise<DuluthEvent[]> => {
  if (!source.url) throw new Error(`ical adapter: source "${source.name}" has no url`);

  const text = await fetchIcsText(source);
  const data = (await ical.async.parseICS(text)) as Record<string, VEventLike>;
  const retrievedAt = nowIso();
  const events: DuluthEvent[] = [];
  let dropped = 0;

  for (const comp of Object.values(data)) {
    if (comp?.type !== "VEVENT" || !comp.start || !comp.summary) continue;

    const allDay = comp.datetype === "date";
    const startIso = toIsoOffset(comp.start);
    const venueName = comp.location?.trim() || "Not specified";

    const candidate = {
      uid: makeUid(source.name, comp.uid, String(comp.summary), startIso, venueName),
      title: String(comp.summary).trim(),
      description: comp.description ? String(comp.description).trim() : undefined,
      start: startIso,
      end: comp.end ? toIsoOffset(comp.end) : undefined,
      allDay,
      timezone: DEFAULT_TZ,
      venueRaw: venueName,
      location: (() => {
        const { city, state } = parseVenueString(venueName);
        return { city: city ?? "Duluth", state: state ?? "MN", inDuluth: isInDuluth(comp.location) && !city };
      })(),
      categories: Array.isArray(comp.categories) ? comp.categories : [],
      url: extractUrl(comp.url),
      status: mapStatus(comp.status),
      rrule: extractRrule(comp.rrule),
      source: {
        name: source.name,
        type: source.type,
        url: source.url,
        sourceEventId: comp.uid ? String(comp.uid) : undefined,
        extractionMethod: "ics-import" as const,
        retrievedAt,
        confidence: source.confidence,
        verified: false,
      },
      lastModified: comp.lastmodified ? toIsoOffset(comp.lastmodified) : undefined,
    };

    const parsed = DuluthEventSchema.safeParse(candidate);
    if (parsed.success) {
      events.push(parsed.data);
    } else {
      dropped++;
      logger.warn({ source: source.name, title: candidate.title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid event");
    }
  }

  if (dropped) logger.warn({ source: source.name, dropped }, "some events failed validation");
  return events;
};
