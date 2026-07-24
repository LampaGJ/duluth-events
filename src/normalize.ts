import { createHash } from "node:crypto";

export const DEFAULT_TZ = "America/Chicago";

/**
 * A JS Date (an instant) -> ISO-8601 with the offset of `tz` at that instant, computed natively via
 * Intl (no date library needed). Correct across DST because the offset is derived from the instant.
 */
export function toIsoOffset(d: Date, tz: string = DEFAULT_TZ): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) map[p.type] = p.value;
  const g = (k: string): string => map[k] ?? "00";

  // Wall-clock time in `tz`, re-interpreted as if it were UTC, minus the true instant = the offset.
  const asUtc = Date.UTC(Number(g("year")), Number(g("month")) - 1, Number(g("day")), Number(g("hour")), Number(g("minute")), Number(g("second")));
  const offsetMin = Math.round((asUtc - d.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}${sign}${oh}:${om}`;
}

/** Now, as an ISO-8601 string with offset in the default zone. */
export function nowIso(tz: string = DEFAULT_TZ): string {
  return toIsoOffset(new Date(), tz);
}

/** Offset in minutes east of UTC of `tz` at a given instant (negative for the Americas). */
export function tzOffsetMinutes(instant: Date, tz: string = DEFAULT_TZ): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) m[p.type] = p.value;
  const n = (k: string): number => Number(m[k] ?? "0");
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Wall-clock components in `tz` -> ISO-8601 with that zone's offset. This is the inverse of
 * toIsoOffset: given "7pm in Chicago" produce "…T19:00:00-05:00". Resolves the offset from the
 * instant, so it's DST-correct (except the ~1h DST gap, which is acceptable for event listings).
 */
export function wallTimeToIso(year: number, month: number, day: number, hour: number, minute: number, second = 0, tz: string = DEFAULT_TZ): string {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const off = tzOffsetMinutes(new Date(wallAsUtc), tz);
  return toIsoOffset(new Date(wallAsUtc - off * 60000), tz);
}

/** Return `tz` if it's a valid IANA zone Intl accepts, else the default (some feeds send "UTC+0"). */
export function safeTimezone(tz: string | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Parse a clock string ("6:00 PM", "6 pm", "19:00", "19:00:00") -> parts, or null if unparseable. */
export function parseClockTime(s: string): { hour: number; minute: number; second: number } | null {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const second = m[3] ? Number(m[3]) : 0;
  const ap = m[4]?.toLowerCase();
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/** kebab-ish slug for building UIDs / keys. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build a stable UID. Prefer the source's native id; otherwise hash the identity tuple so the same
 * event yields the same UID across refreshes (keeps calendar clients from duplicating).
 */
export function makeUid(sourceName: string, sourceEventId: string | undefined, title: string, startIso: string, venue: string): string {
  const base = sourceEventId ? sourceEventId : createHash("sha1").update([title, startIso, venue].join("|")).digest("hex").slice(0, 16);
  return `${slug(sourceName)}:${base}@duluth-events`;
}
