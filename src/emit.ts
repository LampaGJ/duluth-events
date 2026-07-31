import ical, { ICalEventStatus, type ICalCalendar } from "ical-generator";
import type { AgeSchema, CostSchema, DuluthEvent, FeedMeta } from "./schema.js";
import type { z } from "zod";
import { decodeEntities } from "./normalize.js";

type Cost = z.infer<typeof CostSchema>;
type Age = z.infer<typeof AgeSchema>;

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

function formatLocation(e: DuluthEvent): string {
  const loc = e.location;
  const cityLine = `${loc.city}, ${loc.state}${loc.zip ? ` ${loc.zip}` : ""}`;
  return [e.place?.name ?? e.venueRaw, e.place?.room, loc.street, cityLine].filter(Boolean).join(", ");
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

  // Facets — machine-readable so a downstream consumer can re-filter without re-deriving.
  const f = e.facets;
  if (f.audience.length) x.push({ key: "X-AUDIENCE", value: f.audience.join(",") });
  x.push({ key: "X-COST-TIER", value: f.costTier });
  x.push({ key: "X-GEO-SCOPE", value: f.geoScope });
  x.push({ key: "X-TIME-OF-DAY", value: f.timeOfDay });
  x.push({ key: "X-WEEKEND", value: String(f.weekend) });
  x.push({ key: "X-RECURRING", value: String(f.recurring) });
  if (f.registration !== "unknown") x.push({ key: "X-REGISTRATION", value: f.registration });
  if (f.setting !== "unknown") x.push({ key: "X-SETTING", value: f.setting });
  if (f.access.length) x.push({ key: "X-ACCESS", value: f.access.join(",") });
  if (f.publicAdmission !== "unknown") x.push({ key: "X-PUBLIC-ADMISSION", value: f.publicAdmission });
  if (f.alcohol) x.push({ key: "X-ALCOHOL", value: "true" });
  if (f.homeAway) x.push({ key: "X-HOME-AWAY", value: f.homeAway });
  if (f.institutionalNotice) x.push({ key: "X-INSTITUTIONAL-NOTICE", value: "true" });
  if (f.rescheduled) x.push({ key: "X-RESCHEDULED", value: "true" });

  if (e.place) {
    x.push({ key: "X-PLACE-ID", value: e.place.id });
    x.push({ key: "X-PLACE-NAME", value: e.place.name });
    x.push({ key: "X-PLACE-PROVISIONAL", value: String(e.place.provisional) });
  }
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
      // Entities are decoded HERE, at the emission boundary, and nowhere upstream. Sources hand us
      // CMS-encoded text ("Lydia Boyum &#038; Ryan Lane"); `cleanText` already decodes it for every
      // MATCHING surface (classify/facets/place-resolve) but the stored model deliberately keeps the
      // publisher's bytes verbatim. An ICS file is not HTML, so an HTML entity that survives to a
      // subscriber's calendar app is displayed literally — decoding is a reformat of an encoding
      // artifact, not a change to what the publisher said. Doing it here rather than at ingestion
      // keeps dedupe's inputs byte-identical, so this cannot move a merge decision.
      summary: decodeEntities(e.title),
      description: decodeEntities(buildDescription(e)),
      location: {
        title: decodeEntities(formatLocation(e)),
        geo: e.location.geo ? { lat: e.location.geo.lat, lon: e.location.geo.lon } : undefined,
      },
      status: mapStatus(e.status),
      categories: e.categories.map((name) => ({ name: decodeEntities(name) })),
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
