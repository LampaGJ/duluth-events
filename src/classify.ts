import type { DuluthEvent, EventType } from "./schema.js";

/**
 * Deterministic keyword classifier: title + categories -> canonical EventType.
 * First match wins, so rules are ordered most-specific first. Adapters that already KNOW the type
 * (Legistar meetings, rec1 classes) set it explicitly and skip this.
 */
const RULES: readonly [RegExp, EventType][] = [
  [/\b(concert|live music|open mic|karaoke|\bjam\b|acoustic|singer|songwriter|\bgig\b|\bband\b|\bdj\b|vinyl)\b/i, "live-music"],
  [/\b(theat(er|re)|comedy|improv|\bdance\b|ballet|opera|musical|\bplay\b|on stage|playhouse)\b/i, "performing-arts"],
  [/\b(film|movie|cinema|screening|documentary|zinema)\b/i, "film"],
  [/\b(gallery|exhibit|art walk|artist reception|painting|sculpture|\bart show\b)\b/i, "visual-arts"],
  [/\b(class|workshop|\bcamp\b|lesson|clinic|\bcourse\b|training|paddl|learn to|instruction)\b/i, "class"],
  [/\b(meeting|city council|commission|\bboard\b|committee|hearing|caucus|authority)\b/i, "meeting"],
  [/\b(farmers?\s*market|makers?\s*market|\bmarket\b|flea market|bazaar|craft fair)\b/i, "market"],
  [/\b(festival|\bfest\b|\bfair\b|homegrown|celebration|blues fest|winter village)\b/i, "festival"],
  [/\b(game|league|tournament|softball|hockey|frisbee|ultimate|\brace\b|\b5k\b|marathon|athletic|\bvs\.?\b)\b/i, "sports"],
  [/\b(story ?time|toddler|preschool|kids|children|family friendly|all ages family)\b/i, "family"],
  [/\b(tasting|brewery|\bwine\b|food truck|potluck|happy hour|dinner|brunch|\bco-?op\b)\b/i, "food-drink"],
  [/\b(lecture|\btalk\b|author|book club|\breading\b|seminar|planetarium|university|library program)\b/i, "education"],
];

export function classifyEventType(title: string, categories: readonly string[] = [], fallback: EventType = "community"): EventType {
  const hay = [title, ...categories].join(" ");
  for (const [re, type] of RULES) if (re.test(hay)) return type;
  return fallback;
}

/** Multi-day when the event spans more than one calendar day, or recurs. */
export function isMultiDay(startIso: string, endIso?: string, rrule?: string): boolean {
  if (rrule) return true;
  if (!endIso) return false;
  return startIso.slice(0, 10) !== endIso.slice(0, 10);
}

/** Fill eventType (only if still the default "other") and always recompute multiDay. */
export function finalizeEvent(e: DuluthEvent): DuluthEvent {
  const eventType = e.eventType !== "other" ? e.eventType : classifyEventType(e.title, e.categories);
  return { ...e, eventType, multiDay: isMultiDay(e.start, e.end, e.rrule) };
}
