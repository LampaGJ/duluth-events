import type { DuluthEvent, Source } from "./schema.js";

const CONFIDENCE_RANK: Record<Source["confidence"], number> = { high: 3, medium: 2, low: 1 };

/**
 * Fuzzy key for cross-source dedup: same start-day + first ~6 title tokens + a venue token.
 * Intentionally loose so a show listed in both PDD and a venue feed collapses; tight enough that
 * two genuinely different events on the same day at the same venue stay distinct (different titles).
 */
export function fuzzyKey(e: DuluthEvent): string {
  const titleTokens = e.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  const day = e.start.slice(0, 10); // YYYY-MM-DD
  const venue = e.location.venueName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12);
  return `${day}|${titleTokens}|${venue}`;
}

/**
 * Merge duplicate events across sources. The highest-confidence copy becomes primary; the other
 * copies' `source` records are appended to the primary's `alsoListedIn` (provenance is preserved,
 * not discarded). Stable: ties keep first-seen order.
 */
export function dedupe(events: DuluthEvent[]): DuluthEvent[] {
  const groups = new Map<string, DuluthEvent[]>();
  for (const e of events) {
    const key = fuzzyKey(e);
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }

  const merged: DuluthEvent[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort((a, b) => CONFIDENCE_RANK[b.source.confidence] - CONFIDENCE_RANK[a.source.confidence]);
    const primary = sorted[0]!;
    const corroborators = sorted.slice(1).map((e) => e.source);
    merged.push({ ...primary, alsoListedIn: [...primary.alsoListedIn, ...corroborators] });
  }
  return merged;
}
