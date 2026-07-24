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
