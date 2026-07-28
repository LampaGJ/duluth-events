---
type: spec
status: active
related: [docs/tagging-rubrics.md, src/schema.ts, src/dedupe.ts, src/classify.ts]
purpose: Canonical Place entities so cross-source duplicates merge on identity rather than string similarity.
summary: place = the venue's name (a curated, resolvable entity); location = the physical address. Dedupe keys on instant + resolved place. Registry seeded from OpenStreetMap plus targeted research, confirmed by a human so public IDs stay stable.
review_by: 2026-10-26
---

# Place entity resolution

**What this answers:** how an event's venue becomes a canonical entity, and why that makes
cross-source corroboration work when string matching cannot.

**TL;DR** — Split the two things `LocationSchema` currently conflates: **`place` is the venue's name**
(a canonical entity with a stable id), **`location` is the physical address**. Resolve every event's
venue against a curated registry seeded from OpenStreetMap. Dedupe then keys on
*start-instant + resolved place id* instead of comparing strings. Measured on the real corpus, that
merges 8 of 8 observed cross-source duplicates with zero false positives.

This is the first of three entity-resolution specs. Institution is
[#3](https://github.com/LampaGJ/duluth-events/issues/3), Person is
[#4](https://github.com/LampaGJ/duluth-events/issues/4). Both are blocked behind this one.

## The problem, measured

Corroboration barely fires: **11 of 461** live events carry an `alsoListedIn` corroborator. That is
not because the sources are disjoint. It is because `fuzzyKey` in `src/dedupe.ts` matches on the
first six title tokens plus a twelve-character venue prefix, and both axes break on real data.

The same event, three ways:

- `Buffalo Galaxy` — Perfect Duluth Day
- `Buffalo Galaxy | Live Music in The Yard!` — Visit Duluth
- `Live Music: Buffalo Galaxy` — Do Duluth

The same physical place, four ways:

- `Bent Paddle Brewing`
- `Bent Paddle Taproom // 1832 W Michigan St. // Duluth`
- `Bent Paddle Taproom 1832 W Michigan St.`
- `1832 W Michigan St, Duluth, MN, United States, Minnesota 55806`

Venue-token similarity between *confirmed duplicate* pairs ranges from 0.13 to 0.83, so no threshold
on raw strings separates true from false merges. String matching is the wrong primitive.

### The decisive measurement

Two distinct measurements, easily confused, so stated separately:

**Candidate duplicates.** Scoring cross-source pairs that share a start instant by title- and
venue-token overlap surfaces **18 candidate duplicate pairs** in the corpus that still contains
Perfect Duluth Day, and **3** in the live CI build. None are currently merged.

**The safety test.** Narrowing to pairs that share a start instant *and* a same-venue reference
(venue-token similarity ≥ 0.5) yields 6 pairs in the local corpus and 2 in the live build. **All 8
are true duplicates. There are no counterexamples.** The lowest title similarity among them is 0.25 —
for
`High Key Mondays &#038; Industry Nights` vs `HighKey Mondays + Industry Night!` — and that figure
is depressed entirely by the undecoded HTML entity and the `HighKey`/`High Key` split, both of which
normalization fixes.

**Consequence: a title-similarity guard must not be used to *select* merges** — at any threshold high
enough to be meaningful it rejects real duplicates. Place plus instant is the key.

**Amended 2026-07-28 (pre-implementation).** The 8 confirmed pairs all occur at small single-room
venues — Bent Paddle, Wussow's, the Glensheen pier. None tested a convention center. At DECC, AMSOIL
Arena or a UMD building, four genuinely different events from four sources can share a venue and a
start time, and `room` — the intended discriminator — is populated on **0 of 461 events**, so nothing
guards it.

So a title check enters as a **veto, not a selector**: merge on place + instant *unless* the titles
are near-disjoint (token Jaccard < 0.15). Every confirmed duplicate scores ≥ 0.25 after
normalization, so the veto passes all 8 while blocking unrelated events, which score ~0. The
distinction matters — a selector at 0.5 would have rejected 4 of the 8.

## Doctrine

Inherits everything in [tagging-rubrics.md](../../tagging-rubrics.md). Three rules bind hardest here:

**Prove, don't infer.** An unrecognised venue never becomes a guessed place. It becomes `provisional`
or nothing at all.

**A false merge is worse than a missed merge.** Merging *removes* an event from the feed. A missed
merge only costs a corroboration. Every threshold, gate, and rollout phase below is tuned on that
asymmetry.

**Fuzziness belongs in the proposer, never the build.** The build resolves by exact lookup against a
checked-in registry. All approximate matching happens in a tool whose output a human reviews, so
every fuzzy judgment is a reviewed line in a git diff.

## Data model

`place` is the name. `location` is the address. They are complementary, not competing — which is what
lets `LOCATION:` render unambiguously and removes the redundancy of carrying two rival descriptions
of where an event is.

```ts
/** WHERE on earth. Purely geographic. */
AddressSchema {
  street?, city, state, zip?
  geo?: { lat, lon }
  inDuluth: boolean          // derived from city
}

/** WHAT it is called. The canonical entity; curated registry, committed to git. */
PlaceSchema {
  id: string                 // "bent-paddle-taproom" — hand-set, stable, appears in feed URLs
  name: string
  nameAliases: string[]      // normalized name forms
  addressAliases: string[]   // normalized address forms
  address: AddressSchema     // canonical; the source of enrichment
  rooms?: string[]           // subdivisions: "The Yard", "AMSOIL Arena", "Council Chambers"
  operator?: string          // forward hook for Institution (#3): a name, not yet a reference
  provenance: {
    source: "osm" | "web" | "manual"
    ref?: string             // OSM element id, or the URL a fact came from
    retrievedAt?: string
  }
}

/** What an event carries. */
PlaceRefSchema { id, name, room?, provisional }

DuluthEvent {
  place?: PlaceRef           // absent = unresolved
  location: Address
}
```

### Why two alias namespaces

`"bent paddle brewing"` and `"1832 w michigan st"` are different *kinds* of reference to one entity.
Without address aliases, Do Duluth's address-only listing can never merge with Visit Duluth's
name-only listing — no comparison between those two strings could succeed.

### Design notes

**Aliases are stored pre-normalized** (entity-decoded, lowercased, punctuation-stripped), so
resolution is an O(1) map lookup.

**`operator` is a plain string, not a foreign key.** Institution entities do not exist yet. Promoting
a string to a reference later is cheap; inventing half an entity model now is not.

**`rooms` is declarative and currently inert** — no adapter populates `room` (0/461). It is reserved
so a multi-room venue can discriminate simultaneous events if DECC or UMD ever produce a false merge.
`"Council Chambers"` is the clearest existing example of a room misfiled as a venue.

**`provenance` is required.** A machine-fetched address and a hand-typed one are not the same
epistemic object and must not be indistinguishable in the registry.

### Migration

`LocationSchema` loses `venueName` and `room`; both move to `PlaceRef`. This is a breaking change
across six adapter call sites, each of which must split its venue string into a place-name candidate
and address parts. That is the bulk of the implementation work.

**It costs no UID churn.** All 461 live UIDs are native source ids; none derive from the
`title|start|venueName` hash in `makeUid`. No subscriber sees duplicate events.

`resolveLocation()` in `classify.ts` is **deleted, not extended**. It exists only because `venueName`
was carrying address data — `"Bismarck, ND, MDU Resources Community Bowl"`. Under the split that
parses natively into address `Bismarck, ND` and place name `MDU Resources Community Bowl`. Its
59-away-games fix is preserved by parsing into the right fields; regression tests carry over verbatim.

## Resolution

Pure, O(1), no fuzzy matching at build time:

```
normalize(raw)                  decode entities, lowercase, strip punctuation, collapse whitespace
  ↓
sentinel?                       "see listing" / "not specified" / "see catalog" / "see agenda" /
  → undefined                   "sign in to download the location" — no place, never merges
  ↓
nameAliases.get(key)    → Place registered: stable id, public feed
addressAliases.get(key) → Place registered: stable id, public feed
  ↓
else → provisional              id = "~" + slug(key); usable for dedupe, no feed, no stability promise
```

### The three-way outcome

**Sentinel → no place.** 129 events (28%) carry one. This is not pedantry: two events at the same
instant both reading `"See listing"` are demonstrably different events. UMD's *Fall Volunteer and
Engagement Fair* and North Shore Scenic Railroad's *Two Harbors Fall Colors Tour* share an instant
and both have sentinel venues. Treating sentinels as a place would merge and therefore **delete** one.

**Registered → stable id + public feed.** The human paste into the registry *is* the stability
guarantee. Nothing can silently mint or move a public id.

**Provisional → dedupe only.** Lets an unregistered venue participate in corroboration without being
handed a URL we cannot promise to keep. Away-game venues (`Massari Arena`, `Sanford Center`) and
non-places (`Zoom`, `Sioux Falls`) stay provisional permanently, which is correct — they need no feed.

### Registry validation

The registry is Zod-parsed at load. A duplicate `id`, or an alias claimed by two places, throws
immediately. It is a build-time asset; a broken registry must stop the build rather than mis-resolve.
Unknown venues never throw.

## Seeding: research-assisted, human-confirmed

### Measured coverage: two complementary OSM surfaces

Both were probed against all 134 distinct non-sentinel venue strings (330 events). Script:
`scripts/probe-geocoder.mjs`; raw results in `reports/geocode-probe.json`.

**Overpass** (bulk query by bounding box + tag) returns 369 named Duluth-area venues, 180 with full
street addresses, all with geo. Name-matching covers **29% of events**.

**Nominatim** (geocode a name string) covers **49% of events** at name-similarity ≥ 0.5. It does
*not* always answer — it returned nothing for 81 of 134 strings, which corrected an early assumption
that a geocoder's always-answers behaviour would make hit-rate meaningless.

**Union: 56% of events, 43% of strings**, and the two are genuinely complementary — 28 strings
resolve only via Nominatim, 9 only via Overpass. Layering is worth the complexity.

**56% is a floor with three known causes, all defects in the probe rather than in the sources:**

1. Away-game venues were queried against the wrong city — the probe's city regex matched only
   `MN|WI`, so `Massari Arena` (Pueblo, CO) was queried as "Duluth, MN". This accounts for most of
   the top-20 gap list: Vandament, Gutterson, Midco, Ed Robson, MDU Resources, Mattke Field.
2. ICS escaping defeats entity decoding — `Vista Fleet Sightseeing &#038\; Dining Cruises` escapes
   `;` as `\;`, so the entity regex never fired and the raw string was sent to the geocoder.
3. Room suffixes were not stripped — `Glensheen Mansion (G)`.

**The real proposer must unescape ICS, then decode entities, then strip room suffixes, then query
with the correct city.** The true ceiling is unmeasured; the design does not depend on a specific
number, only on the human gate that follows.

### Reliability, not hit rate, is the risk

Nominatim returns a best guess rather than an error, so the proposer scores name-similarity between
query and result and flags anything weak. Two genuine failures were observed:
`Restaurant 301 → Perkins` and `Sioux Falls → South Duluth Avenue`.

But similarity is itself a lossy guard, and two of the four flagged "mismatches" were **correct
matches the metric mislabelled**:

- `DECC → Duluth Entertainment Convention Center` — a correct acronym expansion scoring 0 on token
  overlap.
- `805 E Superior St Duluth → Sir Benedict's Tavern on the Lake` — a correct *address-form* query;
  name-similarity is simply the wrong test for those.

So the proposer needs acronym handling and a separate evaluation path for address-form queries, and
**neither similarity score may auto-accept without review.** A geocoder's confident wrong answer is
more dangerous than a miss, because it looks like data.

### Failure classes in the residue

- **Out of scope by construction** — `Romano Gymnasium`, `Massari Arena`, `Vandament Arena`,
  `Sanford Center` are away-game venues in other cities. Correctly outside the box; stay provisional.
- **Not places** — `Zoom` (virtual), `Sioux Falls` (a city), `Council Chambers` (a room).
- **Threshold artifacts** — `Bent Paddle Taproom 1832 W Michigan St.` vs OSM's
  `Bent Paddle Brewing Co. - Brewery + Taproom` scored **0.43**, a true match rejected by a 0.5
  cutoff. Address-alias matching was not exercised at all in the probe.
- **Genuine gaps** — `Lake Superior Estuarium` (30 events) and `Whole Foods Co-op – Hillside` (11)
  are real venues OSM lacks or names differently.

The distribution is long-tailed favourably: the top ~20 venues carry most event volume. **All
distinct venue strings are registered regardless, including the 80 singletons** — a place feed with
one event is still the only way to find that event, and a venue seen once today recurs tomorrow. This
is the same reasoning that keeps the 1-event `sensory-friendly.ics` on the landing page.

### Pipeline

0. **Normalize first** — unescape ICS, decode entities, strip room suffixes, resolve the correct
   city. Skipping this is what produced three of the probe's failure classes.
1. **Overpass bulk fetch**, cached to a committed JSON artifact so seeding is reproducible offline
   and does not re-hit the API.
2. **Nominatim per-string** for what Overpass misses, at ≤1 req/s per its usage policy.
3. **Match** on both name and address; score similarity; classify confident / weak / mismatch.
4. **Rank the residue by event count** and research those individually — tier 3, websearch.
5. **Emit a proposal file** of paste-ready `Place` literals with provenance and similarity score.
6. **Human review** → `src/places.ts`.

Tier 3 (websearch) is deliberately last: it returns a page to interpret rather than structured
fields, reintroducing the non-determinism the doctrine pushes latest. Measured against the residue it
is a small tier — much of what remains is non-places (`Zoom`, `Sioux Falls`, `Romeoville`) and rooms,
which the design handles by declining to make them places at all.

**Resolvers considered and rejected for this stage:** Photon (typo-tolerant, OSM-backed) is a good
future complement for messy strings. Overture Maps is the strongest fallback if OSM coverage
disappoints, at the cost of a bulk parquet download. Wikidata suits the handful of landmarks.
**Google Places was rejected on licensing, not quality** — its terms restrict retaining place data
outside a Google map context, which conflicts directly with committing addresses to a git registry.

`places:propose` **never writes the registry.** That is the whole mechanism by which ids stay stable.

OSM data is ODbL and requires attribution where derived addresses ship; a line in the feed footer
covers it. Launch-stage detail, noted and not a blocker.

## Dedupe

Two passes, so nothing currently working regresses:

1. **Place pass** — key `startInstant | placeId`. Cross-source only. Skipped entirely when place is
   absent. Refuses to merge when both sides state a *different* `room`, **or when the titles are
   near-disjoint (token Jaccard < 0.15)** — the high-capacity-venue veto.
2. **Title fallback** — the existing fuzzy key, now entity-decoded, applied only to events the place
   pass did not merge.

Pass 2 preserves today's 11 corroborations while some venues remain unregistered. Pass 1 adds the
candidate duplicates whose venues resolve — up to 18 in the PDD-present corpus, 3 in the live build,
bounded by how much of the registry is seeded.

Only cross-source merging is permitted. Two events from the same source at the same place and instant
are two genuinely different events.

## Feeds and enrichment

`/feeds/place/<id>.ics` for every registered place with at least one event. Provisional places get no
feed. The landing page cannot absorb 100+ rows, so a **By venue** group lists the top ~15 by event
count and links to a full `places.html`. Same discipline as the existing catalog: curated page,
complete on disk.

**Enrichment fills gaps and never overwrites.** When a place resolves and the event address lacks
`street`/`zip`/`geo`, fill from `place.address`; a source-stated value always wins. This is the lever
on geo coverage, currently 7.8%.

New properties: `X-PLACE-ID`, `X-PLACE-NAME`, `X-PLACE-PROVISIONAL`.

## Rollout

Phased, because merging deletes events and a bad registry entry does so silently:

1. **Schema, resolution, registry loading.** Emit `X-PLACE-ID`; change no merge behaviour. Measures
   resolution quality against real data at zero risk. Fully reversible.
2. **Seed the registry** — OSM bulk, targeted research, human review.
3. **Switch dedupe to place-first**, title fallback retained. **Hard gate:** review a merge diff
   printing every proposed merge with both titles and both sources before it ships.
4. **Place feeds and enrichment.**

Risk concentrates entirely in phase 3. Every merge logs both sides at info level, so a false merge is
greppable after the fact rather than invisible.

## Testing

- **Unit** — normalization, sentinel rejection, name-alias hit, address-alias hit, provisional
  generation, id stability across rebuilds.
- **Regression against real pairs** — the 8 observed true duplicates must merge. The observed
  non-duplicates must not: specifically *Fall Volunteer and Engagement Fair* / *Two Harbors Fall
  Colors Tour*, the same-instant sentinel-venue pair that a naive design would collapse.
- **Registry invariants** — no duplicate ids, no alias claimed twice. Same shape as the
  `feeds-config` filename-uniqueness test that caught `family.ics` being emitted twice.
- **Merge-count bound** — a registry edit that suddenly collapses an unexpected number of events
  fails CI instead of quietly shipping.

## Open questions

- **`places.html`.** A generated static list, or defer until the place feeds prove useful?
- **Away-game venues.** Permanently provisional, or a second Overpass pass over opponent cities so
  road games get real addresses? They need no feeds, so this is enrichment-only value.

## Success criteria

- All 8 same-instant same-venue pairs merge. **Zero false merges in the phase-3 diff review** — this
  is the binding criterion; a single false merge fails the phase regardless of how many true merges
  it achieved.
- Corroborated events rise from 11 as registry coverage grows, and substantially further once
  Perfect Duluth Day returns (it is the largest overlapper and currently absent from CI). No fixed
  target is claimed: the ceiling is set by how many venues are registered, which is a review-effort
  decision rather than a property of the design.
- Geo coverage rises materially from 7.8%.
- `resolveLocation()` is deleted with its away-game regression tests still passing.
