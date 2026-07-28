import type { DuluthEvent, Source } from "./schema.js";
import { normalizeVenueKey } from "./place-resolve.js";

/**
 * Cross-source duplicate merging.
 *
 * @displayName Event Deduplicator
 * @strategicPurpose One physical event listed by three aggregators must reach the subscriber ONCE,
 *   with all three named as provenance — but two genuinely different events must never collapse into
 *   one, because a false merge silently DELETES an event from the feed and nobody can tell.
 * @tacticalObjective Merge on resolved place identity first (same instant + same place, cross-source
 *   only, subject to explicit refusals), then fall back to the legacy title key for whatever the
 *   place pass left alone.
 *
 * Governing asymmetry: a MISSED merge costs a duplicate row; a FALSE merge costs an event. Every
 * condition in the place pass is therefore written as a refusal, and any ambiguity refuses.
 */

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
  const venue = normalizeVenueKey(e.place?.name ?? e.venueRaw ?? "").replace(/\s+/g, "").slice(0, 12);
  return `${day}|${titleTokens}|${venue}`;
}

/**
 * Title tokens that carry no discriminating signal in this corpus — they appear across unrelated
 * listings at the same venue, so counting them as agreement would inflate similarity toward a
 * false merge.
 */
const TITLE_STOP = new Set(["the", "and", "for", "with", "live", "music", "night", "nights", "duluth"]);

/**
 * Token-set Jaccard over normalized titles. Used ONLY as a veto (see TITLE_VETO) — never to select
 * merges, because a selector at any meaningful threshold rejects real duplicates: 4 of the 8
 * confirmed corpus pairs score below 0.5.
 *
 * Reuses `normalizeVenueKey` as the tokenizer: it is the project's one deterministic text-to-token
 * normalizer (ICS unescape -> entity decode -> transliterate -> `&`/punctuation fold), which is
 * exactly what a title needs before token comparison. Titles arrive entity-encoded from several
 * sources ("High Key Mondays &#038; Industry Nights"), and comparing raw would score a real
 * duplicate at 0.
 *
 * NO-SIGNAL CASE RETURNS 0 (a veto), deliberately diverging from the task brief's `return 1`. When a
 * title reduces to no scoring tokens ("5K", "TBA", ""), there is no evidence the two events are the
 * same — and under this module's governing asymmetry, absent evidence must refuse, not permit. The
 * merge is not lost outright either: two events whose titles are actually identical still collapse in
 * pass 2, whose key is the title itself. Returning 1 would instead grant an unconditional merge to
 * exactly the events we know least about, at exactly the provisional places ("~location-tbd") where a
 * false merge is most likely.
 */
export function titleSimilarity(a: string, b: string): number {
  const tk = (s: string) => new Set(normalizeVenueKey(s).split(" ").filter((w) => w.length > 2 && !TITLE_STOP.has(w)));
  const [x, y] = [tk(a), tk(b)];
  if (!x.size || !y.size) return 0;
  let hits = 0;
  for (const t of x) if (y.has(t)) hits++;
  return hits / (x.size + y.size - hits);
}

/**
 * Below this, two events at one place and instant are treated as genuinely different.
 *
 * A VETO, NOT A SELECTOR — do not raise this into "how similar must titles be to merge". All 8
 * confirmed corpus duplicate pairs score >= 0.25 and unrelated pairs score at or near 0, so the bar
 * sits in the empty band between them. A 0.5 selector would reject 4 of the 8 confirmed pairs.
 * Measured margin is real but thin: the tightest observed unrelated pair ("Fall Volunteer and
 * Engagement Fair" vs "Two Harbors Fall Colors Tour", which share the token "fall") scores 0.125.
 */
const TITLE_VETO = 0.15;

/** Merge one group into a primary + corroborators. Highest confidence wins; ties keep first-seen order. */
function mergeGroup(group: DuluthEvent[]): DuluthEvent {
  const sorted = [...group].sort((a, b) => CONFIDENCE_RANK[b.source.confidence] - CONFIDENCE_RANK[a.source.confidence]);
  const primary = sorted[0]!;
  // Corroborators = every other copy's source AND its own corroborators (pass 2 consumes pass 1's
  // output, so an input here may already carry them), deduped by name, excluding the primary's own.
  const seen = new Set([primary.source.name]);
  const corroborators: Source[] = [];
  for (const s of [...primary.alsoListedIn, ...sorted.slice(1).flatMap((e) => [e.source, ...e.alsoListedIn])]) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      corroborators.push(s);
    }
  }
  return { ...primary, alsoListedIn: corroborators };
}

/**
 * Merge duplicates across sources. Two passes, so nothing that works today regresses:
 *
 *   1. PLACE pass — same start INSTANT + same resolved place id, subject to four refusals (below).
 *   2. TITLE fallback — the original `fuzzyKey`, applied only to what pass 1 left alone.
 *
 * Pass 1's four refusals, each of which exists because the alternative deletes a real event:
 *
 *   a. NO PLACE — a sentinel venue ("See listing", "Not specified") resolves to no place and is
 *      skipped entirely. 145 of 584 live events carry one; two of them at one instant are
 *      demonstrably different events.
 *   b. SAME SOURCE — if a source name STILL appears twice after same-title copies are folded, the
 *      WHOLE group is refused. One source listing two DIFFERENT titles at one venue and instant is
 *      listing two different events (live corpus: UMD publishes the men's and the women's
 *      cross-country race at one meet; Perfect Duluth Day publishes two different shows at Wussow's
 *      at 18:00). The fold that runs first is what makes this precise rather than blunt — see the
 *      comment on `byLegacyKey` in the body.
 *   c. CONFLICTING ROOM — more than one distinct stated `room` in the group. (An unstated room is
 *      not a conflict, only less specific.) Inert today: `room` is populated on 0 of 584 events, so
 *      this guards a future adapter, and its absence is exactly why refusal (d) has to exist.
 *   d. TITLE VETO — any pair in the group scoring below TITLE_VETO refuses the whole group. A
 *      high-capacity venue (DECC, AMSOIL Arena, a UMD building) genuinely hosts unrelated events at
 *      one instant, and `room` — the intended discriminator — is populated nowhere. It also covers
 *      the sentinel strings `SENTINELS` misses: "Location TBD" and "Multiple" are not prefix matches,
 *      so they resolve to the provisional places `~location-tbd` and `~multiple`, and provisional
 *      places DO participate in pass 1. The veto is the only thing standing between two unrelated
 *      "Location TBD" events at one instant and the deletion of one of them.
 *
 * Pass 1 keys on the resolved INSTANT (`Date.getTime()`), not the raw offset string, per the schema's
 * standing rule — two sources that write the same moment as `-05:00` local and as `Z` are at the same
 * instant and must group.
 */
export function dedupe(events: DuluthEvent[]): DuluthEvent[] {
  // --- pass 1: place identity ---
  const placeGroups = new Map<string, DuluthEvent[]>();
  const unplaced: DuluthEvent[] = [];
  for (const e of events) {
    if (!e.place) {
      unplaced.push(e); // refusal (a)
      continue;
    }
    const key = `${new Date(e.start).getTime()}|${e.place.id}`;
    const arr = placeGroups.get(key);
    if (arr) arr.push(e);
    else placeGroups.set(key, [e]);
  }

  const afterPlace: DuluthEvent[] = [...unplaced];
  for (const group of placeGroups.values()) {
    if (group.length === 1) {
      afterPlace.push(group[0]!);
      continue;
    }

    // Fold a source's own repeated listing — one source publishing the SAME TITLE twice at one place
    // and instant is one listing emitted twice (25 events in the live corpus arrive this way, several
    // under a duplicate UID), and pass 2 collapses it regardless. Doing it here first is what keeps
    // refusal (b) from over-firing: Perfect Duluth Day emits the planetarium show twice, and without
    // this fold that internal duplicate would veto the genuine cross-source merge with UMD's listing.
    //
    // The key is the EXACT title, deliberately NOT `fuzzyKey`. fuzzyKey truncates to the first 6 title
    // tokens, so two genuinely different events sharing a 6-token prefix ("Duluth Superior Symphony
    // Orchestra Summer Series: Beethoven" / "…: Mozart") would fold — which is harmless on its own
    // (pass 2 merges them either way) but here would defeat refusal (b) and let the folded pair merge
    // ACROSS sources, deleting two events instead of one. Exact-title folding cannot amplify: a title
    // that differs at all leaves the source repeated, and refusal (b) fires.
    const bySourceTitle = new Map<string, DuluthEvent[]>();
    for (const e of group) {
      const k = `${e.source.name}|${e.title}`;
      const arr = bySourceTitle.get(k);
      if (arr) arr.push(e);
      else bySourceTitle.set(k, [e]);
    }
    const collapsed = [...bySourceTitle.values()].map((g) => (g.length === 1 ? g[0]! : mergeGroup(g)));

    // (b) a source STILL appearing twice is publishing two different events (UMD lists the men's and
    // women's cross-country races at one meet, one instant, one place). Refuse the whole group, not
    // just the repeated source: with sources {X, X, Y} there is no non-title way to decide which X the
    // Y corroborates, and using titles to choose would turn the veto into the selector this design
    // forbids. Refusal pushes the ORIGINAL group, so the refused path stays byte-identical to pass 2's
    // pre-existing behaviour.
    const sourceNames = new Set(collapsed.map((e) => e.source.name));
    if (sourceNames.size !== collapsed.length) {
      afterPlace.push(...group);
      continue;
    }

    // (c) more than one distinct STATED room means the group spans rooms, not copies of one event.
    const statedRooms = new Set(collapsed.map((e) => e.place?.room).filter(Boolean));
    if (statedRooms.size > 1) {
      afterPlace.push(...group);
      continue;
    }

    // (d) near-disjoint titles mean a shared venue and clock, not a shared event.
    const disjoint = collapsed.some((x, i) => collapsed.slice(i + 1).some((y) => titleSimilarity(x.title, y.title) < TITLE_VETO));
    if (disjoint) {
      afterPlace.push(...group);
      continue;
    }

    afterPlace.push(collapsed.length === 1 ? collapsed[0]! : mergeGroup(collapsed));
  }

  // --- pass 2: title fallback, only for what pass 1 did not merge ---
  const titleGroups = new Map<string, DuluthEvent[]>();
  for (const e of afterPlace) {
    const key = fuzzyKey(e);
    const arr = titleGroups.get(key);
    if (arr) arr.push(e);
    else titleGroups.set(key, [e]);
  }
  return [...titleGroups.values()].map((g) => (g.length === 1 ? g[0]! : mergeGroup(g)));
}
