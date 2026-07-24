import { DuluthEventSchema, type DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";
import type { Adapter } from "./types.js";
import { logger } from "../logger.js";
import { DEFAULT_TZ, makeUid, nowIso, parseClockTime, wallTimeToIso } from "../normalize.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_GROUPS = 200; // safety cap; logged if hit (no silent truncation)

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}
const getJson = async <T>(url: string): Promise<T> => JSON.parse(await getText(url)) as T;

interface RecTab {
  id: string;
}
interface RecGroup {
  id: string;
  name?: string;
  descriptionText?: string;
}
interface RecSection {
  name?: string;
  groups?: RecGroup[];
}
interface RecFeature {
  name?: string;
  value?: string;
}
interface RecSession {
  id: number | string;
  text?: string;
  basicInfo?: string[];
  price?: number | string;
  features?: RecFeature[];
  canceled?: boolean;
}

const featVal = (fs: RecFeature[] | undefined, name: string): string | undefined => (fs ?? []).find((f) => f.name === name)?.value?.trim() || undefined;

function parseAge(s: string | undefined): DuluthEvent["age"] {
  if (!s) return undefined;
  if (/\ball\b|any age/i.test(s)) return { allAges: true, note: s };
  const m = s.match(/(\d+)/);
  return m ? { allAges: false, minAge: Number(m[1]), note: s } : { allAges: true, note: s };
}

/** Map one REC1 dated session (within a program group) to a DuluthEvent. */
export function mapRec1Session(sess: RecSession, group: RecGroup, source: SourceDef, retrievedAt: string): DuluthEvent | null {
  if (sess.canceled) return null;
  const fs = sess.features;
  const datesVal = featVal(fs, "dates") ?? "";
  const dateTokens = [...datesVal.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g)].map((m) => {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return { y, mo: Number(m[1]), d: Number(m[2]) };
  });
  if (dateTokens.length === 0) return null; // no parseable date -> not a calendar event
  const first = dateTokens[0]!;
  const last = dateTokens[dateTokens.length - 1]!;

  const timesVal = featVal(fs, "times") ?? "";
  const [t1, t2] = timesVal.split(/[-–]/).map((s) => s.trim());
  const st = t1 ? parseClockTime(t1) : null;
  const et = t2 ? parseClockTime(t2) : null;
  const allDay = !st;

  const start = wallTimeToIso(first.y, first.mo, first.d, st?.hour ?? 0, st?.minute ?? 0);
  const multiSpan = first.y !== last.y || first.mo !== last.mo || first.d !== last.d;
  const endDay = multiSpan ? last : first;
  const end = et
    ? wallTimeToIso(endDay.y, endDay.mo, endDay.d, et.hour, et.minute)
    : multiSpan
      ? wallTimeToIso(last.y, last.mo, last.d, st?.hour ?? 23, st?.minute ?? 59)
      : undefined;

  const venueName = featVal(fs, "location") ?? "See catalog";
  const price = typeof sess.price === "number" ? sess.price : Number(sess.price);
  const cost: DuluthEvent["cost"] = Number.isFinite(price) ? (price === 0 ? { kind: "free" } : { kind: "paid", priceMin: price, currency: "USD" }) : { kind: "unknown" };

  const descParts: string[] = [];
  if (group.descriptionText) descParts.push(String(group.descriptionText).replace(/\s+/g, " ").trim().slice(0, 800));
  if (Array.isArray(sess.basicInfo)) descParts.push(sess.basicInfo.join(" · "));
  const days = featVal(fs, "days");
  if (days && multiSpan) descParts.push(`Meets: ${days}`);

  const candidate = {
    uid: makeUid(source.name, String(sess.id), group.name ?? "program", start, venueName),
    title: (group.name ?? sess.text ?? "Program").trim(),
    description: descParts.join("\n") || undefined,
    start,
    end,
    allDay,
    timezone: DEFAULT_TZ,
    location: { venueName, city: "Duluth", state: "MN", inDuluth: !/\bsuperior\b/i.test(venueName) },
    cost,
    age: parseAge(featVal(fs, "ageGender")),
    eventType: "class" as const,
    categories: ["parks-rec"],
    url: source.url,
    status: "confirmed" as const,
    source: {
      name: source.name,
      type: source.type,
      url: source.url,
      sourceEventId: String(sess.id),
      extractionMethod: "structured-api" as const,
      retrievedAt,
      confidence: source.confidence,
      verified: false,
    },
  };

  const parsed = DuluthEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  logger.warn({ source: source.name, title: candidate.title, issues: parsed.error.issues.slice(0, 3) }, "dropped invalid rec1 event");
  return null;
}

/**
 * REC1/CivicRec adapter: bootstrap a session hash from the catalog HTML, enumerate tabs, take only
 * "Programs"-named sections (skips facility/rental tabs), then load each program group's dated
 * sessions via getActivitySessions -> one DuluthEvent per dated session (eventType "class").
 */
export const importRec1: Adapter = async (source: SourceDef): Promise<DuluthEvent[]> => {
  const base = source.url;
  if (!base) throw new Error(`rec1: source "${source.name}" has no url`);

  const html = await getText(base);
  const hash = html.match(/catalog\/(?:getTabsFiltersItemsCounts|getItems|getActivitySessions|[a-zA-Z]+)\/([a-f0-9]{32})/)?.[1] ?? html.match(/[a-f0-9]{32}/)?.[0];
  if (!hash) throw new Error("rec1: could not find catalog session hash in page");

  const tabsResp = await getJson<{ tabs?: RecTab[] }>(`${base}/getTabsFiltersItemsCounts/${hash}`);
  const tabIds = (tabsResp.tabs ?? []).map((t) => t.id).filter(Boolean);
  const retrievedAt = nowIso();
  const events: DuluthEvent[] = [];
  let groupCount = 0;
  let capped = false;

  for (const tabId of tabIds) {
    if (capped) break;
    let items: { sections?: RecSection[] };
    try {
      items = await getJson(`${base}/getItems/${hash}/${tabId}`);
    } catch {
      continue;
    }
    const programGroups = (items.sections ?? []).filter((s) => /program/i.test(s.name ?? "")).flatMap((s) => s.groups ?? []);
    for (const g of programGroups) {
      if (groupCount >= MAX_GROUPS) {
        capped = true;
        break;
      }
      groupCount++;
      try {
        const sessions = await getJson<{ items?: RecSession[] }>(`${base}/getActivitySessions/${hash}/${tabId}/${g.id}`);
        for (const s of sessions.items ?? []) {
          const e = mapRec1Session(s, g, source, retrievedAt);
          if (e) events.push(e);
        }
      } catch {
        /* one program failing shouldn't sink the source */
      }
    }
  }

  if (capped) logger.warn({ source: source.name, cap: MAX_GROUPS }, "rec1: hit the group cap; some programs were not fetched");
  return events;
};
