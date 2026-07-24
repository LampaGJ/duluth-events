import ical, { ICalEventStatus, type ICalCalendar } from "ical-generator";
import type { AgeSchema, CostSchema, DuluthEvent, FeedMeta, LocationSchema } from "./schema.js";
import type { z } from "zod";

type Cost = z.infer<typeof CostSchema>;
type Age = z.infer<typeof AgeSchema>;
type Loc = z.infer<typeof LocationSchema>;

/**
 * DuluthEvent -> RFC 5545 VEVENT property mapping:
 *   uid->UID  title->SUMMARY  description(+detail block)->DESCRIPTION  start/end/allDay->DTSTART/DTEND
 *   location->LOCATION(+GEO)  organizer.email->ORGANIZER else X-HOST  cost->X-COST + DESCRIPTION line
 *   categories->CATEGORIES  age->X-AGE-RESTRICTION  url->URL  ticketUrl->X-TICKET-URL  status->STATUS
 *   rrule->RRULE  source->X-SOURCE-* + "Source: …" DESCRIPTION line  lastModified->LAST-MODIFIED
 */

export function formatCost(cost: Cost): string {
  switch (cost.kind) {
    case "free":
      return "Free";
    case "donation":
      return `Donation${cost.note ? ` (${cost.note})` : ""}`;
    case "paid": {
      const range =
        cost.priceMax !== undefined && cost.priceMax !== cost.priceMin
          ? `$${cost.priceMin}–$${cost.priceMax}`
          : `$${cost.priceMin}`;
      const cur = cost.currency && cost.currency !== "USD" ? ` ${cost.currency}` : "";
      return `${range}${cur}${cost.note ? ` (${cost.note})` : ""}`;
    }
    case "unknown":
      return "Not specified";
  }
}

function formatAge(age: Age): string {
  if (age.allAges) return `All ages${age.note ? ` (${age.note})` : ""}`;
  const base = age.minAge !== undefined ? `${age.minAge}+` : "Restricted";
  return `${base}${age.note ? ` (${age.note})` : ""}`;
}

function formatLocation(loc: Loc): string {
  const cityLine = `${loc.city}, ${loc.state}${loc.zip ? ` ${loc.zip}` : ""}`;
  return [loc.venueName, loc.room, loc.street, cityLine].filter(Boolean).join(", ");
}

function mapStatus(s: DuluthEvent["status"]): ICalEventStatus {
  switch (s) {
    case "cancelled":
      return ICalEventStatus.CANCELLED;
    case "tentative":
      return ICalEventStatus.TENTATIVE;
    default:
      return ICalEventStatus.CONFIRMED;
  }
}

function buildDescription(e: DuluthEvent): string {
  const lines: string[] = [];
  if (e.description) lines.push(e.description.trim(), "");
  lines.push("— Details —");
  lines.push(`Cost: ${formatCost(e.cost)}`);
  if (e.organizer) lines.push(`Host: ${e.organizer.name}`);
  if (e.age) lines.push(`Ages: ${formatAge(e.age)}`);
  if (e.ticketUrl) lines.push(`Tickets: ${e.ticketUrl}`);
  if (e.url) lines.push(`More info: ${e.url}`);
  const s = e.source;
  lines.push(`Source: ${s.name}${s.url ? ` · ${s.url}` : ""} · confidence:${s.confidence} · retrieved ${s.retrievedAt.slice(0, 10)}`);
  if (e.alsoListedIn.length) lines.push(`Also listed in: ${e.alsoListedIn.map((x) => x.name).join(", ")}`);
  return lines.join("\n");
}

function buildXProps(e: DuluthEvent): { key: string; value: string }[] {
  const x: { key: string; value: string }[] = [
    { key: "X-EVENT-TYPE", value: e.eventType },
    { key: "X-MULTI-DAY", value: String(e.multiDay) },
    { key: "X-COST", value: formatCost(e.cost) },
    { key: "X-SOURCE-NAME", value: e.source.name },
    { key: "X-SOURCE-CONFIDENCE", value: e.source.confidence },
    { key: "X-EXTRACTION-METHOD", value: e.source.extractionMethod },
    { key: "X-IN-DULUTH", value: String(e.location.inDuluth) },
  ];
  if (e.source.url) x.push({ key: "X-SOURCE-URL", value: e.source.url });
  if (e.organizer && !e.organizer.email) x.push({ key: "X-HOST", value: e.organizer.name });
  if (e.age) x.push({ key: "X-AGE-RESTRICTION", value: formatAge(e.age) });
  if (e.ticketUrl) x.push({ key: "X-TICKET-URL", value: e.ticketUrl });
  if (e.alsoListedIn.length) x.push({ key: "X-ALSO-LISTED-IN", value: e.alsoListedIn.map((s) => s.name).join(", ") });
  return x;
}

/** Build the merged, subscribable ICS document from validated events. */
export function emitFeed(events: DuluthEvent[], meta: FeedMeta): string {
  // ical-generator wants prodId in {company, product, language} form; a raw string gets a stray
  // extra "-" prepended (=> "--//…"). Build it structurally instead.
  const cal: ICalCalendar = ical({
    name: meta.name,
    description: meta.description,
    prodId: { company: "duluth-events", product: "Duluth Events", language: "EN" },
  });
  cal.ttl(meta.ttlSeconds); // -> REFRESH-INTERVAL + X-PUBLISHED-TTL
  if (meta.url) cal.url(meta.url);

  const stamp = new Date(meta.generatedAt);

  for (const e of events) {
    const ev = cal.createEvent({
      id: e.uid,
      start: new Date(e.start),
      end: e.end ? new Date(e.end) : undefined,
      allDay: e.allDay,
      summary: e.title,
      description: buildDescription(e),
      location: {
        title: formatLocation(e.location),
        geo: e.location.geo ? { lat: e.location.geo.lat, lon: e.location.geo.lon } : undefined,
      },
      status: mapStatus(e.status),
      categories: e.categories.map((name) => ({ name })),
      stamp,
      x: buildXProps(e),
    });
    if (e.url) ev.url(e.url);
    if (e.organizer?.email) ev.organizer({ name: e.organizer.name, email: e.organizer.email });
    if (e.rrule) ev.repeating(e.rrule);
    if (e.lastModified) ev.lastModified(new Date(e.lastModified));
  }

  return cal.toString();
}
