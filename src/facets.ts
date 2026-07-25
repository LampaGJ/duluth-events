import {
  type AccessFeature,
  type Audience,
  type CostTier,
  type DuluthEvent,
  type Facets,
  type GeoScope,
  type Registration,
  type Setting,
  type TimeOfDay,
} from "./schema.js";
import { cleanText } from "./normalize.js";

/**
 * Deterministic facet derivation — the WHO / HOW MUCH / HOW / WHERE / WHEN axes that are
 * independent of `eventType`'s single WHAT.
 *
 * @displayName Facet Rubrics
 * @strategicPurpose Every rule here is a named, auditable rubric backed by a phrase that actually
 *   occurs in the corpus (counts cited in docs/tagging-rubrics.md). No rule may guess: when the
 *   source is silent the facet stays "unknown"/empty, because a subscriber filtering `costTier=free`
 *   must get events we can PROVE are free, not events nobody priced.
 * @tacticalObjective Turn one validated DuluthEvent into its Facets, using only its own title,
 *   description, source categories, location, and times — no network, no model, no I/O.
 */

/** The text every rubric matches against: title + description + categories, entity-decoded. */
export function haystack(e: Pick<DuluthEvent, "title" | "description" | "categories">): string {
  return cleanText([e.title, e.description ?? "", ...e.categories].join(" \n "));
}

/** Source categories, entity-decoded and lowercased, for exact-set membership tests. */
export function normalizedCategories(categories: readonly string[]): string[] {
  return categories.map((c) => cleanText(c).toLowerCase()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// R1 — AUDIENCE
// ---------------------------------------------------------------------------

/** Categories whose whole purpose is to declare an audience. */
const ALL_AGES_CATEGORIES = new Set(["family-friendly", "family friendly", "all ages", "all-ages"]);
const STUDENT_CATEGORIES = new Set(["student activities", "student life"]);
const ADULT_CATEGORIES = new Set(["adult event", "adult", "adults only", "21+"]);

/**
 * R1a — an explicit numeric age band. `ages 3-5`, `ages 5 and up`, `ages 14 & under`, bare `21+`.
 * The bare-`N+` form is guarded against `$20+` and `2026+` so a price or a year never reads as an age.
 */
export function parseAgeBand(text: string): { minAge?: number; maxAge?: number } {
  const range = text.match(/\bages?\s+(\d{1,2})\s*(?:-|–|—|to|thru|through)\s*(\d{1,2})\b/i);
  if (range) return { minAge: Number(range[1]), maxAge: Number(range[2]) };

  const under = text.match(/\bages?\s+(\d{1,2})\s*(?:and|&)\s*(?:under|younger|below)\b/i);
  if (under) return { maxAge: Number(under[1]) };

  const over = text.match(/\bages?\s+(\d{1,2})\s*(?:\+|(?:and|&)\s*(?:up|older|over|above))\b/i);
  if (over) return { minAge: Number(over[1]) };

  // Bare "21+" / "8+". Reject when preceded by $ or a digit (price, year, "10-14+").
  const bare = text.match(/(?<![$\d.\-–])\b(\d{1,2})\s*\+(?!\d)/);
  if (bare) return { minAge: Number(bare[1]) };

  return {};
}

/**
 * R1 — AUDIENCE. Multi-valued and derived in this order: explicit numeric band, then declared
 * categories, then vocabulary. A stated band always wins over vocabulary — "Spanish Music Class for
 * Kids 0-8" is `kids` because of the band, not because the word "kids" appears.
 */
export function deriveAudience(hay: string, cats: readonly string[]): { audience: Audience[]; minAge?: number; maxAge?: number } {
  const set = new Set<Audience>();
  const { minAge, maxAge } = parseAgeBand(hay);

  if (minAge !== undefined && minAge >= 18) set.add("adults-only");
  if (maxAge !== undefined && maxAge <= 12) set.add("kids");
  if (minAge !== undefined && maxAge !== undefined && minAge <= 17 && maxAge >= 13) set.add("teen");
  if (minAge !== undefined && minAge >= 55) set.add("seniors");

  for (const c of cats) {
    if (ALL_AGES_CATEGORIES.has(c)) set.add("all-ages");
    if (STUDENT_CATEGORIES.has(c)) set.add("students");
    if (ADULT_CATEGORIES.has(c)) set.add("adults-only");
  }

  // "all ages" is only claimed when stated; an adults-only minimum contradicts it and wins.
  if (/\ball[- ]ages\b|\bfamily[- ]friendly\b|\bfor the whole family\b/i.test(hay)) set.add("all-ages");
  if (/\bstory ?time\b|\btoddlers?\b|\binfants?\b|\bbabies\b|\bpre-?school\b|\bpre-?k\b|\bkids?\b|\bchildren\b/i.test(hay)) set.add("kids");
  if (/\bteens?\b|\btweens?\b|\byoung adults?\b/i.test(hay)) set.add("teen");
  if (/\bseniors?\b|\bolder adults?\b|\b55\s*\+/i.test(hay)) set.add("seniors");

  if (set.has("adults-only")) set.delete("all-ages");
  return { audience: [...set], minAge, maxAge };
}

// ---------------------------------------------------------------------------
// R2 — COST TIER
// ---------------------------------------------------------------------------

/**
 * R2 — COST TIER from prose, used only when the source carried no price field.
 *
 * "free" REQUIRES an adjacency: the corpus contains "a cloud free night" and "gluten free", so a
 * bare /\bfree\b/ is a false-positive generator. A price token beats a free mention (many listings
 * read "free for members, $10 otherwise"); an explicit donation beats both.
 */
const FREE_RE =
  /\bfree\s+(?:admission|entry|entrance|show|event|concert|and open|to attend|to the public|of charge|for all)\b|\b(?:admission|entry|entrance|parking|attendance)\s+is\s+free\b|\bno\s+(?:admission\s+)?(?:fee|charge|cost)\b|\bfree\s+and\s+open\s+to\s+the\s+public\b/i;
const DONATION_RE = /\b(?:suggested\s+)?donations?\b|\bpay\s+what\s+you\s+can\b|\bfree-?will\s+offering\b|\bdonation-?based\b/i;
const PRICE_RE = /\$\s?\d/;

export function deriveCostTier(hay: string, declared: DuluthEvent["cost"]): CostTier {
  if (declared.kind !== "unknown") return declared.kind;
  if (DONATION_RE.test(hay)) return "donation";
  if (PRICE_RE.test(hay)) return "paid";
  if (FREE_RE.test(hay)) return "free";
  return "unknown";
}

// ---------------------------------------------------------------------------
// R3 — REGISTRATION
// ---------------------------------------------------------------------------

/** R3 — how you get in. "drop-in"/"no registration" is a positive claim and outranks a register link. */
export function deriveRegistration(hay: string): Registration {
  if (/\bdrop[- ]in\b|\bno\s+registration\b|\bno\s+sign[- ]?up\b|\bregistration\s+not\s+required\b/i.test(hay)) return "drop-in";
  if (/\bregistration\s+(?:is\s+)?required\b|\bpre-?registration\s+required\b|\bmust\s+register\b|\brsvp\s+required\b|\bsign[- ]?up\s+required\b|\bregistration\s+is\s+necessary\b|\bspace\s+is\s+limited\b/i.test(hay))
    return "required";
  if (/\bregister\b|\bregistration\b|\brsvp\b|\bsign[- ]?up\b|\btickets?\s+(?:are\s+)?(?:required|available)\b/i.test(hay)) return "open";
  return "unknown";
}

// ---------------------------------------------------------------------------
// R4 — SETTING
// ---------------------------------------------------------------------------

const VIRTUAL_RE = /\bvirtual(?:ly)?\b|\bonline\b|\bzoom\b|\bwebinar\b|\blivestream(?:ed)?\b|\bremote\b|\bteams meeting\b|\bz\.umn\.edu\b/i;
const OUTDOOR_RE =
  /\boutdoors?\b|\brain or shine\b|\bweather permitting\b|\bin the park\b|\bon the (?:pier|beach|lawn|trail|water)\b|\btrailhead\b|\bcampground\b|\bbring (?:a )?(?:blanket|lawn chair)\b|\bfield trip\b|\bhike\b|\bpaddle\b/i;

/**
 * R4 — SETTING. Virtual is checked first and against the venue too, because "Virtual via Zoom" is a
 * venueName in the corpus; a Zoom row must never be filed under a physical geography.
 */
export function deriveSetting(hay: string, venue: string): Setting {
  if (VIRTUAL_RE.test(venue) || VIRTUAL_RE.test(hay)) return "virtual";
  if (OUTDOOR_RE.test(hay) || /\bpark\b|\bbeach\b|\btrail\b|\bgardens?\b|\bpoint\b/i.test(venue)) return "outdoor";
  return "unknown";
}

// ---------------------------------------------------------------------------
// R5 — ACCESS
// ---------------------------------------------------------------------------

/**
 * R5 — stated accommodations. Low-volume but perfectly deterministic, and the only way anyone can
 * currently find these events. Absence means the source was silent, never "inaccessible".
 */
export function deriveAccess(hay: string): AccessFeature[] {
  const out: AccessFeature[] = [];
  if (/\bwheelchair\b|\bADA[- ]accessible\b|\bfully accessible\b|\baccessible (?:venue|entrance|seating|parking|event)\b|\bmobility[- ]accessible\b/i.test(hay))
    out.push("wheelchair");
  if (/\bASL\b|\bsign language\b|\b(?:ASL[- ])?interpret(?:ed|ation|er)\b|\bCART\b|\bcaptioned\b/i.test(hay)) out.push("asl");
  if (/\bsensory[- ]friendly\b|\bsensory[- ]inclusive\b|\bquiet (?:hour|room|space)\b|\blow[- ]sensory\b/i.test(hay)) out.push("sensory-friendly");
  return out;
}

// ---------------------------------------------------------------------------
// R6 — GEOGRAPHY
// ---------------------------------------------------------------------------

/**
 * R6a — recover the real city from a venue string. UMD's athletics feed encodes away games as
 * `"<City>, <ST>, <Venue>"` inside venueName while the city field still says Duluth, which put 59
 * games in Tempe, Columbus and Burlington into `duluth-proper.ics`. A leading `City, ST` pair is
 * authoritative over the adapter's default.
 */
const US_STATES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split(" "),
);
/** Newspaper-style state abbreviations that appear in college feeds alongside postal codes. */
const AP_STATES: Record<string, string> = { minn: "MN", wis: "WI", mich: "MI", colo: "CO", neb: "NE", ill: "IL", ind: "IN", ariz: "AZ", ore: "OR", wash: "WA", penn: "PA", fla: "FL", calif: "CA", tenn: "TN", conn: "CT", mass: "MA", okla: "OK", kan: "KS", ala: "AL", ark: "AR", dak: "ND" };

export function extractLeadingCity(venue: string): { city: string; state: string; rest: string } | null {
  const m = cleanText(venue).match(/^([A-Za-z][A-Za-z .'-]{1,30}?),\s*([A-Za-z]{2,8})\.?(?:,\s*(.*))?$/);
  if (!m) return null;
  const [, city = "", raw = "", rest = ""] = m;
  const state = US_STATES.has(raw.toUpperCase()) ? raw.toUpperCase() : AP_STATES[raw.toLowerCase()];
  if (!state) return null;
  return { city: city.trim(), state, rest: rest.trim() };
}

/** Twin Ports + immediate ring — "local enough to drive to on a weeknight". */
const TWIN_PORTS = new Set(["superior", "proctor", "hermantown", "esko", "cloquet", "carlton", "duluth township", "rice lake", "canosia", "midway", "oliver", "lakeside"]);
/** The regional draw: Arrowhead / North Shore / Iron Range day trips. */
const REGIONAL = new Set(["two harbors", "silver bay", "grand marais", "hibbing", "virginia", "chisholm", "chisolm", "ely", "grand rapids", "moose lake", "bayfield", "ashland", "washburn", "fredenberg township", "toivola", "knife river", "barnum", "wrenshall", "sandstone"]);

/** R6b — geographic scope. `virtual` short-circuits: an online event has no geography. */
export function deriveGeoScope(city: string, state: string, setting: Setting): GeoScope {
  if (setting === "virtual") return "virtual";
  const c = cleanText(city).toLowerCase();
  if (c === "duluth") return "duluth";
  if (TWIN_PORTS.has(c)) return "twin-ports";
  if (REGIONAL.has(c)) return "regional";
  if (state === "MN" || state === "WI") return "regional";
  return "distant";
}

// ---------------------------------------------------------------------------
// R7 — TIMING
// ---------------------------------------------------------------------------

/** Local wall-clock parts of an ISO instant in the event's own timezone. */
function localParts(iso: string, tz: string): { hour: number; weekday: string } {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23", weekday: "short" });
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(d)) parts[p.type] = p.value;
  return { hour: Number(parts.hour ?? "0"), weekday: parts.weekday ?? "" };
}

/**
 * R7 — TIME OF DAY, bucketed from the local start hour. The corpus clusters hard at 17–19
 * (82+67+65 events), so `evening` is the single highest-value timing filter.
 */
export function deriveTimeOfDay(startIso: string, tz: string, allDay: boolean): TimeOfDay {
  if (allDay) return "all-day";
  const { hour } = localParts(startIso, tz);
  if (hour >= 21 || hour < 5) return "late-night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export function deriveWeekend(startIso: string, tz: string): boolean {
  const { weekday } = localParts(startIso, tz);
  return weekday === "Sat" || weekday === "Sun";
}

// ---------------------------------------------------------------------------
// R8 — VENUE / INSTITUTIONAL
// ---------------------------------------------------------------------------

/**
 * R8 — ALCOHOL. Licensed-venue and beverage vocabulary. Deliberately does NOT set an age: Minnesota
 * taprooms are routinely all-ages, and the corpus proves it — "Jumpsuit Mondays | Live Music in The
 * Yard!" at a brewery is tagged Family-Friendly by its own source.
 */
export function deriveAlcohol(hay: string, venue: string): boolean {
  const t = `${hay} ${venue}`;
  return /\bbrew(?:ery|eries|ing|pub)\b|\btaproom\b|\bdistiller(?:y|ies)\b|\bwiner(?:y|ies)\b|\bnightclub\b|\btavern\b|\bsaloon\b|\bpub\b|\bcocktails?\b|\bbeer\b|\bwine tasting\b|\bcash bar\b|\bhappy hour\b/i.test(t);
}

/** R9 — who may attend. UMD tags 56 events "Open to the Public" and 56 "Student Activities". */
export function derivePublicAdmission(cats: readonly string[], hay: string): Facets["publicAdmission"] {
  if (cats.includes("open to the public") || /\bopen to the public\b|\bfree and open to the public\b/i.test(hay)) return "public";
  if (cats.includes("student activities") || /\b(?:UMD )?students only\b|\bmembers only\b|\bstaff only\b|\binvitation only\b/i.test(hay)) return "restricted";
  return "unknown";
}

/**
 * R10 — institutional non-events. UMD's "Academic Calendar" category carries 31 rows like "Final
 * exams; last day of regular session" and "Faculty appointments begin" — real calendar entries, but
 * nothing a resident can attend. Flagged rather than dropped, so nothing is silently lost.
 */
const NOTICE_TITLE_RE =
  /\b(?:final exams?|last day|first day|no class(?:es)?|classes? (?:begin|end|resume)|faculty appointments?|registration (?:opens|begins|closes)|grades? due|commencement rehearsal|term (?:begins|ends)|break begins|holiday - no|university closed|semester (?:begins|ends))\b/i;

export function deriveInstitutionalNotice(title: string, cats: readonly string[]): boolean {
  return cats.includes("academic calendar") && NOTICE_TITLE_RE.test(title);
}

/** R11 — the title says the date moved / it was called off, while STATUS still reads CONFIRMED. */
export function deriveRescheduled(title: string): boolean {
  return /\bre-?scheduled\b|\bpostponed\b|\bnew date\b|\bdate changed\b|\bcancell?ed\b/i.test(title);
}

/**
 * R12 — HOME/AWAY for athletics. College feeds are rigidly consistent: "<Team> vs <Opponent>" is
 * home, "<Team> at <Opponent>" is away. Only meaningful when the event is athletics.
 */
export function deriveHomeAway(title: string, isAthletics: boolean): "home" | "away" | undefined {
  if (!isAthletics) return undefined;
  if (/\bvs\.?\b|\bversus\b/i.test(title)) return "home";
  if (/\bat\b/i.test(title)) return "away";
  return undefined;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** The first ticketing URL in the description — 56 corpus events carry one while `ticketUrl` is empty. */
const TICKET_HOST_RE = /https?:\/\/[^\s<>"')]*(?:eventbrite|ticketmaster|etix\.com|showclix|seetickets|axs\.com|tickets\.|ticketweb|universe\.com|brownpapertickets)[^\s<>"')]*/i;
export function extractTicketUrl(text: string): string | undefined {
  const m = cleanText(text).match(TICKET_HOST_RE);
  return m ? m[0].replace(/[.,;)]+$/, "") : undefined;
}

/** Derive every facet for one event. Pure: title/description/categories/location/times only. */
export function deriveFacets(e: DuluthEvent, opts: { isAthletics?: boolean } = {}): Facets {
  const hay = haystack(e);
  const cats = normalizedCategories(e.categories);
  const venue = cleanText([e.location.venueName, e.location.room, e.location.city].filter(Boolean).join(", "));

  const { audience } = deriveAudience(hay, cats);
  const setting = deriveSetting(hay, venue);
  const geoScope = deriveGeoScope(e.location.city, e.location.state, setting);

  return {
    audience,
    costTier: deriveCostTier(hay, e.cost),
    registration: deriveRegistration(hay),
    setting,
    geoScope,
    access: deriveAccess(hay),
    timeOfDay: deriveTimeOfDay(e.start, e.timezone, e.allDay),
    weekend: deriveWeekend(e.start, e.timezone),
    recurring: Boolean(e.rrule),
    alcohol: deriveAlcohol(hay, venue),
    publicAdmission: derivePublicAdmission(cats, hay),
    homeAway: deriveHomeAway(e.title, opts.isAthletics ?? false),
    institutionalNotice: deriveInstitutionalNotice(e.title, cats),
    rescheduled: deriveRescheduled(e.title),
  };
}
