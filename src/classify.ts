import type { DuluthEvent, EventType } from "./schema.js";
import { deriveFacets, extractLeadingCity, extractTicketUrl, haystack, normalizedCategories, parseAgeBand } from "./facets.js";
import { cleanText } from "./normalize.js";
import { resolvePlace } from "./place-registry.js";

/**
 * Deterministic typification: source categories first, then title/description vocabulary.
 *
 * @displayName Event Classifier
 * @strategicPurpose `eventType` answers ONE question — what kind of thing is this. Audience, cost,
 *   access and geography are facets (see facets.ts), not types, which is why "Family Fun Cruise" can
 *   be `food-drink` without becoming invisible to a family feed.
 * @tacticalObjective Assign the single best topical type, preferring a publisher's own structured
 *   category over our regex guess at their prose.
 */

// ---------------------------------------------------------------------------
// Stage 1 — source categories (the publisher already told us)
// ---------------------------------------------------------------------------

/**
 * Only categories whose meaning is UNAMBIGUOUS map to a type. The corpus is full of tempting but
 * mushy buckets — Visit Duluth's "Arts & Culture" covers a makers market, an orchestra and a train
 * ride; Do Duluth's "Sports & Live Entertainment" tags a folk singer — so those are deliberately
 * absent and left to the vocabulary stage.
 *
 * Audience categories ("Family-Friendly") map to a FACET, never to a type; that conflation is what
 * emptied family.ics.
 */
const CATEGORY_TYPE: Record<string, EventType> = {
  athletics: "sports",
  "sports and recreation": "sports",
  "board meetings": "meeting",
  "public-meeting": "meeting",
  government: "meeting",
  classes: "class",
  "art camps": "class",
  studio: "class",
  "music / concerts": "live-music",
  concerts: "live-music",
  music: "live-music",
  "performing arts": "performing-arts",
  "food &amp; drink": "food-drink", // pre-decode form, kept as a belt-and-braces alias
  "food & drink": "food-drink",
  "food and drink": "food-drink",
  "food & drinks": "food-drink",
  "research and education": "education",
  academics: "education",
  educational: "education",
};

// ---------------------------------------------------------------------------
// Stage 2 — title/description vocabulary
// ---------------------------------------------------------------------------

/**
 * Ordered most-specific first; first match wins. Every entry below was tightened against a real
 * corpus false positive:
 *   - bare `ultimate` typed "Rumours: The Ultimate Fleetwood Mac Tribute Show" as sports
 *   - bare `board` typed "Board Games" as a civic meeting
 *   - bare `university` typed 36 UMD away games as education
 *   - bare `camp` typed the documentary "Crip Camp" as a class
 * and the sports vocabulary was missing soccer/volleyball/football/basketball entirely, which is
 * why away games (titled "… at …", with no "vs") fell through to education.
 */
const RULES: readonly [RegExp, EventType][] = [
  [/\b(concerts?|live music|open mics?|karaoke|jam sessions?|acoustic|singers?|songwriters?|gigs?|bands?|\bdj\b|vinyl night)\b/i, "live-music"],
  [/\b(theat(?:er|re)s?|comedy|improv|dances?|ballet|opera|musicals?|on stage|playhouse|burlesque|storytelling)\b/i, "performing-arts"],
  [/\b(films?|movies?|cinema|screenings?|documentar(?:y|ies)|zinema|matinee)\b/i, "film"],
  [/\b(galler(?:y|ies)|exhibits?|exhibitions?|art walk|artist reception|opening reception|paintings?|sculptures?|art show|pottery|ceramics)\b/i, "visual-arts"],
  [/\b(workshops?|lessons?|clinics?|courses?|training|learn to|instruction|(?:summer|day|art|kids?|youth|science|music|sports?)\s+camps?|camps|class(?:es)?)\b/i, "class"],
  [/\b(city council|commissions?|committees?|hearings?|caucus|authority|board meetings?|board of|public meeting|town hall)\b/i, "meeting"],
  [/\b(farmers?\s*markets?|makers?\s*markets?|flea markets?|bazaar|craft fairs?|markets?)\b/i, "market"],
  [/\b(festivals?|fest|fairs?|homegrown|celebrations?|winter village|daze|parades?)\b/i, "festival"],
  [
    /\b(soccer|volleyball|football|basketball|baseball|softball|hockey|tennis|golf|wrestling|swimming|lacrosse|rugby|track (?:and|&) field|cross country|ultimate frisbee|games?|leagues?|tournaments?|invitationals?|races?|\d+k\b|marathons?|triathlons?|athletics?|vs\.?)\b/i,
    "sports",
  ],
  [/\b(story ?times?|toddlers?|pre-?school|storyfolk|kids? (?:program|activity|hour)|children'?s (?:program|hour))\b/i, "family"],
  [/\b(tastings?|brew(?:ery|eries|pub)|taprooms?|wine|food trucks?|potlucks?|happy hour|dinners?|brunch|co-?op|pancake breakfast|seafood boil)\b/i, "food-drink"],
  [/\b(lectures?|talks?|authors?|book clubs?|readings?|seminars?|planetarium|webinars?|symposi(?:um|a)|summits?|conferences?|in conversation)\b/i, "education"],
  // Civic/volunteer vocabulary claims `community` explicitly so the venue rubric below can't
  // out-vote it — "P7: Volunteer at Bentleyville" happens at Bayfront but is not a concert.
  [/\b(volunteers?|volunteering|clean-?ups?|blood drives?|job fairs?|career fairs?|open house|fundraisers?|food drives?|town cleanup|work day)\b/i, "community"],
];

// ---------------------------------------------------------------------------
// Stage 3 — venue function (the venue declares what happens there)
// ---------------------------------------------------------------------------

/**
 * R13 — VENUE FUNCTION. Half the residual `community` bucket is touring music billed under nothing
 * but the artist's name — "Buffalo Galaxy", "Judy Collins", "The Brothers Burn Mountain" — which no
 * title vocabulary can ever catch. The venue can: a booking at a concert cafe is a concert.
 *
 * Two tiers, both deterministic:
 *   (a) function words the venue puts in its OWN name (…Concert Cafe, …Music Hall, …Theatre, …Arena)
 *   (b) a small registry of named Duluth rooms whose function is not in the name.
 * Applied AFTER title vocabulary, so an explicitly-titled event always wins over its room.
 */
const VENUE_FUNCTION: readonly [RegExp, EventType][] = [
  [/\b(concert cafe|music hall|amphitheater|amphitheatre|bandshell|nightclub|listening room)\b/i, "live-music"],
  [/\b(theat(?:er|re)|playhouse|opera house|auditorium)\b/i, "performing-arts"],
  [/\b(planetarium|library|observatory)\b/i, "education"],
  [/\b(gallery|art museum|art institute)\b/i, "visual-arts"],
  [/\b(arena|stadium|fieldhouse|field house|ice rink|ballpark|speedway|golf course|curling club)\b/i, "sports"],
  [/\b(brew(?:ery|ing|pub)|taproom|winery|distillery|co-?op)\b/i, "food-drink"],
];

/** Named Duluth-area rooms whose booking function is not visible in the venue string itself. */
const VENUE_REGISTRY: Record<string, EventType> = {
  norshor: "performing-arts",
  "teatro zuccone": "performing-arts",
  zeitgeist: "performing-arts",
  "sacred heart": "live-music",
  wussow: "live-music",
  "pier b": "live-music",
  "bayfront festival park": "live-music",
  "clyde iron": "live-music",
  amsoil: "sports",
  "symphony hall": "performing-arts",
  glensheen: "education",
};

export function classifyByVenue(venueName: string): EventType | undefined {
  const v = cleanText(venueName).toLowerCase();
  if (!v) return undefined;
  for (const [key, type] of Object.entries(VENUE_REGISTRY)) if (v.includes(key)) return type;
  for (const [re, type] of VENUE_FUNCTION) if (re.test(v)) return type;
  return undefined;
}

export function classifyEventType(title: string, categories: readonly string[] = [], fallback: EventType = "community", venueName = ""): EventType {
  for (const c of normalizedCategories(categories)) {
    const t = CATEGORY_TYPE[c];
    if (t) return t;
  }
  const hay = cleanText([title, ...categories].join(" "));
  for (const [re, type] of RULES) if (re.test(hay)) return type;
  return classifyByVenue(venueName) ?? fallback;
}

// ---------------------------------------------------------------------------
// Duration & recurrence — orthogonal, not the same question
// ---------------------------------------------------------------------------

/**
 * Multi-day means the event's OWN span crosses a calendar boundary. A weekly recurrence does not:
 * karaoke every Thursday is 52 single evenings, and folding RRULE in here put 8 such events into
 * multi-day.ics. Recurrence is carried separately as `facets.recurring`.
 */
export function isMultiDay(startIso: string, endIso?: string): boolean {
  if (!endIso) return false;
  return startIso.slice(0, 10) !== endIso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Location resolution
// ---------------------------------------------------------------------------

/**
 * Recover the true city when a source packed it into the venue string. UMD athletics writes away
 * games as `"Bismarck, ND, MDU Resources Community Bowl"` in the venue while the city field keeps
 * the default "Duluth" — which shipped 59 out-of-state games inside `duluth-proper.ics`.
 */
export function resolveLocation(loc: DuluthEvent["location"]): DuluthEvent["location"] {
  const found = extractLeadingCity(loc.venueName);
  if (!found) return loc;
  return {
    ...loc,
    venueName: found.rest || found.city,
    city: found.city,
    state: found.state,
    inDuluth: /^duluth$/i.test(found.city),
  };
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

/**
 * The one place an event becomes fully tagged: resolve location, assign the type, recompute
 * duration, derive every facet, and backfill `age`/`ticketUrl` when the source stated them in prose
 * but carried no field. Adapters that already KNOW the type (Legistar meetings, rec1 classes) set it
 * explicitly and keep it.
 */
export function finalizeEvent(e: DuluthEvent): DuluthEvent {
  const location = resolveLocation(e.location);
  const place = resolvePlace(e.venueRaw ?? e.location.venueName);
  const eventType = e.eventType !== "other" ? e.eventType : classifyEventType(e.title, e.categories, "community", [location.venueName, location.room].filter(Boolean).join(" "));
  const withLoc: DuluthEvent = { ...e, location, eventType, multiDay: isMultiDay(e.start, e.end) };

  const facets = deriveFacets(withLoc, { isAthletics: eventType === "sports" });

  // Backfill `age` from prose when the source had no age field of its own.
  const band = e.age ? undefined : parseAgeBand(haystack(withLoc));
  const age =
    e.age ??
    (band && (band.minAge !== undefined || band.maxAge !== undefined)
      ? { allAges: false, minAge: band.minAge, maxAge: band.maxAge }
      : facets.audience.includes("all-ages")
        ? { allAges: true }
        : undefined);

  return {
    ...withLoc,
    place,
    facets,
    age,
    ticketUrl: e.ticketUrl ?? extractTicketUrl(e.description ?? ""),
    status: e.status === "confirmed" && facets.rescheduled ? "tentative" : e.status,
  };
}
