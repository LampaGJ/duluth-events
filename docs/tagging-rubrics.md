---
type: spec
status: active
related: [docs/extraction-methods.md, src/facets.ts, src/classify.ts, src/feeds-config.ts]
purpose: The deterministic rubrics that tag every event, and the doctrine governing them.
summary: eventType answers one question (WHAT); everything else a subscriber filters on is an orthogonal facet derived by a named, corpus-evidenced rule. No rule may guess.
review_by: 2026-10-25
---

# Tagging rubrics

**What this answers:** how an event acquires its tags, why each rule exists, and which sub-feeds those tags are allowed to produce.

**TL;DR** — `eventType` answers exactly one question: *what kind of thing is this*. Everything else a
subscriber filters on — who it's for, what it costs, whether they can get in the door, whether it's
even in town — is an independent question carried as a **facet**. Facets are multi-valued,
orthogonally filterable, and derived by named deterministic rubrics from text the source actually
published. When the source is silent the facet stays `unknown`; it never guesses.

All counts below are measured against the deployed corpus: `public/feeds/all.ics`, 549 events,
build of 2026-07-24, 11 live sources.

## Why facets, not a bigger enum

`eventType` is single-valued. Asking it to also encode audience, cost and geography forces a loser
every time an event is more than one thing, and the corpus showed exactly that failure:

- `family.ics` contained **0 events** while **103** events carried an explicit family or age signal.
  Those 103 were scattered across community (62), class (27), food-drink (4), market (3),
  education (2), sports (2), festival, live-music and meeting. "Family Fun Cruise with the Vista
  Fleet" is tagged `Family-Friendly` by its own publisher and is *also* a dinner cruise — under a
  single enum, one of those facts had to be discarded, and the audience fact lost.
- `community.ics` held **310 of 549 (56%)** — the fallback had become the largest feed.

Adding `all-ages` as an event *type* would repeat the mistake one notch further out. The fix is to
stop overloading the axis: keep one topical WHAT, and give every other question its own axis.

Consequence for feeds: **`family.ics` is keyed to the audience facet, not to `eventType: family`.**
The URL is unchanged; it went from 0 events to 82. `test/feeds-config.test.ts` pins this.

## Doctrine

**D1 — Prove, don't infer.** A facet is set only when the source states it. `costTier` stays
`unknown` rather than defaulting to free; `access` stays empty rather than asserting a venue is
inaccessible. A missing tag means *the publisher was silent*, which is why the landing page says so
in plain words. This is the same anti-fabrication discipline the provenance model already enforces.

**D2 — Publisher categories outrank our regex.** A structured category the source chose is better
evidence than our guess at their prose. 137 events carry `Athletics` / `Sports and Recreation`; the
classifier ignored them in favour of title matching, and 36 away games ended up typed `education`
because the title contained "University" and the sports vocabulary had no word for soccer.

**D3 — Only unambiguous categories map to a type.** Visit Duluth's `Arts & Culture` covers a makers
market, an orchestra and a train excursion; Do Duluth's `Sports & Live Entertainment` tags a folk
singer. Those are deliberately absent from the category map and left to the vocabulary stage. A
category that means three things is not evidence.

**D4 — Audience categories are facets, never types.** `Family-Friendly` sets the audience facet. The
conflation of the two is the specific bug that emptied `family.ics`.

**D5 — Decode before matching.** Sources ship `Food &amp; Drink`, `Whole Foods Co-op &#8211;
Hillside`, `Wussow&#8217;s`. Left encoded, every category-equality and venue rubric silently misses.
`cleanText()` runs first, always.

**D6 — Venue infers function, never a person's eligibility.** A brewery venue sets `alcohol: true`.
It must not set a minimum age: Minnesota taprooms are routinely all-ages, and the corpus proves it —
"Jumpsuit Mondays | Live Music in The Yard!" at Bent Paddle is tagged Family-Friendly by its own
source.

**D7 — Keyword rubrics need adjacency.** The corpus contains "…sparkling on a cloud free night". A
bare `/\bfree\b/` is a false-positive generator. Every high-volume keyword rule carries a required
neighbour (`free admission`, `free to attend`, `no admission fee`).

**D8 — Plurals are not optional.** `\bconcert\b` misses "Concerts on the Pier"; `\bmovie\b` misses
"Movies in the Park"; `\brace\b` misses "Sunday Night at the Races"; `brewer(?:ing)` spells
"brewering" and matches nothing. Every noun in a rubric takes an explicit plural form. Four live
misclassifications traced to this one class of typo.

**D9 — Nothing is silently dropped.** Institutional non-events are flagged and routed to
`notices.ics`, not discarded. A subscriber who wants UMD's academic calendar can still have it.

**D10 — Distinct questions get distinct fields.** `multiDay` (does the span cross a calendar day)
and `recurring` (is there an RRULE) were conflated, which put 8 weekly-recurring events — karaoke
every Thursday, one evening at a time — into `multi-day.ics`.

## The rubrics

Each is implemented in `src/facets.ts` (or `src/classify.ts` for type/location) and covered by
`test/facets.test.ts` using phrases quoted verbatim from the corpus.

**R1 — Audience.** Order: explicit numeric band, then declared category, then vocabulary. A stated
band always beats vocabulary. Bands observed: `ages 3-5`, `ages 14 & under`, `ages 5 and up`,
`ages 10+`, and bare `8+` / `11+` / `14+` / `16+` / `18+` / `21+`. The bare form is guarded against
`$10+` and years so a price or date never reads as an age. Categories: `Family-Friendly` (22
events), `Student Activities` (56), `Adult Event`. Vocabulary: all ages (52 verbatim), family
friendly (31), storytime/toddler/preschool, teen/tween, seniors/55+. An `adults-only` minimum
deletes a stray `all-ages` claim rather than carrying both. Result: 82 events reach the family feed.

**R2 — Cost tier.** Used only when the source carried no price field (415 of 549 had none). Ranking:
a declared price always wins; then donation; then a `$N` token; then free-with-adjacency. "Free for
members, $10 for non-members" is `paid`. Recovered 65 provably-free events from prose.

**R3 — Registration.** `drop-in` / "no registration" is a positive claim and outranks a register
link. `required` from "registration is required", "must register", "space is limited". Otherwise
`open` if any sign-up language, else `unknown`. Corpus: 165 mention registration, 12 state required,
14 state drop-in.

**R4 — Setting.** `virtual` is checked against the venue string as well as the prose, because
"Virtual via Zoom - register at z.umn.edu/…" is a *venueName* in the corpus. A virtual event must
never be filed under a physical geography. 29 virtual, 98 outdoor. There is no `indoor` inference —
absence of outdoor evidence is not indoor evidence.

**R5 — Access.** Wheelchair / ADA (9), ASL, captioning or interpretation (3), sensory-friendly (1).
Low volume, perfectly deterministic, and currently the only way anyone can find these events at all.

**R6 — Geography.** Two parts. (a) Recover the real city from a venue string: UMD encodes away games
as `"<City>, <ST>, <Venue>"` inside venueName while the city field still says Duluth. A leading
`City, ST` pair — validated against the US state list, tolerating AP forms like `Minn.` — is
authoritative. (b) Scope: `duluth` / `twin-ports` / `regional` / `distant` / `virtual`.
**This corrected 59 away games in Tempe AZ, Columbus OH, Burlington VT and Grand Forks ND that were
shipping inside `duluth-proper.ics`.** That feed went from effectively-everything to 394.

**R7 — Timing.** Bucketed from the local start hour in the event's own timezone: morning (<12),
afternoon (12–16), evening (17–20), late-night (≥21 or <5), all-day. The corpus clusters hard at
17–19 (82+67+65), so `evening` is the highest-value timing filter. Weekend is Sat/Sun local —
152 Saturday and 124 Friday events make it the single most-requested cut.

**R8 — Alcohol.** Licensed-venue and beverage vocabulary. Sets `alcohol`, never an age (D6).

**R9 — Public admission.** UMD tags 56 events `Open to the Public` and 56 `Student Activities` —
a clean, free, already-published answer to "can a non-student attend this?"

**R10 — Institutional notices.** `Academic Calendar` category **and** a notice-shaped title ("Final
exams; last day of regular session", "Faculty appointments begin"). Both conditions are required, so
a real public event that merely also carries the category — "HazMaTON Webinar: Plastic Paradox" — is
not suppressed. 13 flagged.

**R11 — Rescheduled.** Title says the date moved or it was called off while the source's STATUS
still reads CONFIRMED: "Concerts on the Pier (Rescheduled date)", "⚠️Re-Scheduled!! Co-op Crafts".
Downgrades `status` to `tentative`.

**R12 — Home/away.** College feeds are rigidly consistent: `vs` is home, `at` is away. Applied only
to athletics.

**R13 — Venue function.** Half the residual `community` bucket was touring music billed under
nothing but the artist's name — "Buffalo Galaxy", "Judy Collins", "The Brothers Burn Mountain" —
which no title vocabulary can ever catch. The venue can. Two tiers: function words the venue puts in
its own name (`Concert Cafe`, `Music Hall`, `Theatre`, `Arena`, `Planetarium`, `Brewing`), and a
small registry of named Duluth rooms whose function is not in the name (NorShor, Zeitgeist, Sacred
Heart, Wussow's, Pier B, Bayfront, AMSOIL, Glensheen). Applied *after* title vocabulary so an
explicitly-titled event always beats its room, and after an explicit civic-vocabulary rule so
"P7: Volunteer at Bentleyville" is not typed as a concert because it happens at Bayfront.

## Effect on the corpus

Type distribution, before and after: `community` 310 → 203 (56% → 37%), `sports` 92 → 144,
`class` 41 → 59, `food-drink` 10 → 37, `live-music` 12 → 23, `education` 39 → 39 (but now genuinely
educational rather than 36 misfiled road games), `film` 1 → 3.

New reachable feeds: family 82, kids 54, free 65, outdoor 98, weekend 147, evenings 220, virtual 29,
open-to-public 58, drop-in 14, wheelchair 9, ASL 3, sensory-friendly 1, home games 66.

Corrected feeds: `duluth-proper` no longer contains out-of-state road games; `multi-day` no longer
contains weekly karaoke.

## Feed catalog

`src/feeds-config.ts` is the single source of truth, grouped for the landing page as **Start here /
By kind / Who it's for / What it costs / Getting in / When / Where / Provenance**.

Curation rules:

- Feeds are **curated, not a blind cross-product.** The facets support arbitrary combinations via
  the query API (`/feed.ics?type=live-music&audience=kids&cost=free`); only combinations worth a row
  on a scannable page become static files.
- A cross-facet feed must earn its place with a real subscriber intent, not merely a non-zero count.
  `free-family` and `free-outdoor` qualify; `late-night-virtual` does not.
- **Empty feeds are hidden from the page but still written to disk**, so an existing bookmark keeps
  resolving. The footer reports how many are hidden.
- Feed filenames are unique and stable — the catalog test enforces uniqueness after `family.ics` was
  briefly emitted twice and the two writers overwrote each other.

## Known limitations

- **Age policy for music is rarely published.** Only 3 live-music events state "all ages". A strict
  `all-ages-music` feed would therefore be near-empty and misleading, so the catalog instead ships
  `music-no-age-limit.ics` (20 events) — live music where *no source states* an 18+/21+ policy. That
  is absence of a restriction, not a guarantee, and the feed description says exactly that.
- `community` remains the largest type at 203. The residue is genuinely heterogeneous civic and
  social programming, much of it from Perfect Duluth Day, which publishes no categories at all.
- The venue registry (R13, tier b) encodes local knowledge and will drift as venues open and close.
  It is deliberately small and additive; a wrong entry only ever affects events that matched no
  category and no title vocabulary.
- `visual-arts` (1) and `film` (3) are under-detected because the Duluth Art Institute's 50 events
  are categorised `Classes` / `Studio` and are correctly typed `class`; their exhibition programming
  is not in the feed at all.
