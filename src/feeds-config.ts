import { EVENT_TYPES } from "./schema.js";
import type { FeedFilter } from "./feed.js";
import { PLACE_INDEX } from "./place-registry.js";

/**
 * Landing-page grouping. Feeds are curated per group, not emitted as a blind cross-product: a
 * subscriber scans a page, and 200 combinatorial rows is the same as no page at all.
 */
export const GROUPS = ["Start here", "By kind", "Who it's for", "What it costs", "Getting in", "When", "Where", "By venue", "Provenance"] as const;
export type Group = (typeof GROUPS)[number];

export interface FeedSpec {
  file: string;
  title: string;
  desc: string;
  group: Group;
  filter: FeedFilter;
}

/**
 * Curated sub-feeds. Type feeds answer WHAT; facet feeds answer WHO / HOW MUCH / HOW / WHERE / WHEN
 * and are a cross-product over the same corpus — see docs/tagging-rubrics.md for each rubric.
 *
 * `family.ics` is deliberately keyed to the AUDIENCE facet, not `eventType: family`. Keying it to
 * the type is what left it empty while 103 events carried an explicit all-ages/age-band signal.
 */
export const SPECS: FeedSpec[] = [
  // --- start here: the feeds most people actually want ---
  { file: "all.ics", title: "Everything", desc: "Every source, every type — minus institutional notices.", group: "Start here", filter: { institutionalNotice: false } },
  { file: "weekend.ics", title: "This weekend", desc: "Saturday & Sunday.", group: "Start here", filter: { weekend: true, institutionalNotice: false } },
  { file: "family.ics", title: "Family & all-ages", desc: "Explicitly all-ages, family-friendly, or an age band reaching kids.", group: "Start here", filter: { audience: ["all-ages", "kids"] } },
  { file: "free.ics", title: "Free", desc: "Proven free — a stated $0 or an explicit free-admission phrase.", group: "Start here", filter: { costTier: ["free"] } },
  { file: "drop-in.ics", title: "Drop-in", desc: "No registration — just show up.", group: "Start here", filter: { registration: ["drop-in"] } },

  // --- by kind ---
  // `family` and `other` are excluded: `family.ics` above is the AUDIENCE feed (82 events vs the
  // 1 event that lands in the family *type*), and it owns that filename; `other` is always empty
  // because finalizeEvent resolves every event to a real type or `community`.
  ...EVENT_TYPES.filter((t) => t !== "other" && t !== "family").map(
    (t) => ({ file: `${t}.ics`, title: t.replace(/-/g, " "), desc: `Only ${t} events.`, group: "By kind", filter: { types: [t], institutionalNotice: false } }) as FeedSpec,
  ),

  // --- who it's for ---
  { file: "kids.ics", title: "Kids", desc: "Stated for children — upper age bound ≤12, storytime, preschool.", group: "Who it's for", filter: { audience: ["kids"] } },
  { file: "teen.ics", title: "Teens", desc: "Stated for teens/tweens, or an age band covering 13–17.", group: "Who it's for", filter: { audience: ["teen"] } },
  { file: "adults-only.ics", title: "Adults only (18+/21+)", desc: "A stated minimum age of 18 or over.", group: "Who it's for", filter: { audience: ["adults-only"] } },
  { file: "seniors.ics", title: "Seniors", desc: "Stated for older adults / 55+.", group: "Who it's for", filter: { audience: ["seniors"] } },
  {
    file: "music-no-age-limit.ics",
    title: "Music with no age restriction",
    desc: "Live music where no source states an 18+/21+ door policy. Absence of a stated limit — not a guarantee; check the venue.",
    group: "Who it's for",
    filter: { types: ["live-music"], excludeAudience: ["adults-only"] },
  },
  { file: "accessible.ics", title: "Wheelchair access stated", desc: "The source explicitly states wheelchair accessibility.", group: "Who it's for", filter: { access: ["wheelchair"] } },
  { file: "asl.ics", title: "ASL / captioned", desc: "ASL interpretation or captioning stated.", group: "Who it's for", filter: { access: ["asl"] } },
  { file: "sensory-friendly.ics", title: "Sensory-friendly", desc: "Sensory-friendly or quiet-hour programming.", group: "Who it's for", filter: { access: ["sensory-friendly"] } },

  // --- what it costs ---
  { file: "free-family.ics", title: "Free & family", desc: "Free admission and explicitly all-ages or for kids.", group: "What it costs", filter: { costTier: ["free"], audience: ["all-ages", "kids"] } },
  { file: "free-outdoor.ics", title: "Free & outdoor", desc: "Free admission, in a park / on the water / rain-or-shine.", group: "What it costs", filter: { costTier: ["free"], setting: ["outdoor"] } },

  // --- getting in ---
  { file: "open-to-public.ics", title: "Open to the public", desc: "Explicitly open to non-members / non-students.", group: "Getting in", filter: { publicAdmission: ["public"] } },
  { file: "registration-required.ics", title: "Registration required", desc: "Sign-up needed — plan ahead.", group: "Getting in", filter: { registration: ["required"] } },

  // --- when ---
  { file: "evenings.ics", title: "Evenings", desc: "Starts 5–9pm — the after-work slot.", group: "When", filter: { timeOfDay: ["evening"], institutionalNotice: false } },
  { file: "late-night.ics", title: "Late night", desc: "Starts 9pm or later.", group: "When", filter: { timeOfDay: ["late-night"] } },
  { file: "daytime.ics", title: "Daytime", desc: "Morning and afternoon starts.", group: "When", filter: { timeOfDay: ["morning", "afternoon"], institutionalNotice: false } },
  { file: "recurring.ics", title: "Recurring", desc: "Has a repeat rule — weekly karaoke, standing meetings.", group: "When", filter: { recurring: true } },
  { file: "single-day.ics", title: "Single-day only", desc: "Excludes multi-week / multi-day runs.", group: "When", filter: { multiDay: false } },
  { file: "multi-day.ics", title: "Multi-day runs", desc: "Multi-week classes, festival runs.", group: "When", filter: { multiDay: true } },
  { file: "classes-single-day.ics", title: "One-off classes", desc: "Single-session classes & workshops.", group: "When", filter: { types: ["class"], multiDay: false } },

  // --- where ---
  { file: "duluth-proper.ics", title: "Duluth proper", desc: "City of Duluth venues only — excludes road games and Superior, WI.", group: "Where", filter: { geoScope: ["duluth"] } },
  { file: "twin-ports.ics", title: "Twin Ports", desc: "Duluth plus Superior, Proctor, Hermantown, Cloquet & the ring.", group: "Where", filter: { geoScope: ["duluth", "twin-ports"] } },
  { file: "outdoor.ics", title: "Outdoor", desc: "Parks, trails, waterfront, rain-or-shine.", group: "Where", filter: { setting: ["outdoor"] } },
  { file: "virtual.ics", title: "Virtual", desc: "Zoom / webinar / livestream — no physical venue.", group: "Where", filter: { setting: ["virtual"] } },
  { file: "home-games.ics", title: "Home games", desc: "Athletics played here — excludes road trips.", group: "Where", filter: { types: ["sports"], homeAway: "home" } },

  // --- provenance ---
  { file: "high-confidence.ics", title: "High-confidence", desc: "First-party feeds & APIs only.", group: "Provenance", filter: { confidence: ["high"] } },
  { file: "corroborated.ics", title: "Corroborated", desc: "Confirmed by 2+ independent sources.", group: "Provenance", filter: { corroborated: true } },
  { file: "notices.ics", title: "Institutional notices", desc: "Academic-calendar rows that are not public events — kept, not discarded.", group: "Provenance", filter: { institutionalNotice: true } },
];

/**
 * One feed per REGISTERED place. Provisional places are excluded by construction — they have no
 * stable id, so a URL built on one could break.
 */
export function placeSpecs(): FeedSpec[] {
  return PLACE_INDEX.all.map((p) => ({
    file: `place/${p.id}.ics`,
    title: p.name,
    desc: `Everything at ${p.name}${p.address.city ? ` (${p.address.city}, ${p.address.state})` : ""}.`,
    group: "By venue" as Group,
    filter: { placeId: p.id },
  }));
}

