# data/trail-conditions.json — provenance

## THIS IS NOT A PUBLISHED API

`data/trail-conditions.json` vendors COGGS' live trail-conditions widgets, which are an
**undocumented Next.js server-side-rendered payload**, not a published/versioned API. There is no
API documentation, no stability guarantee, and no contract with TrailBot (the vendor) or COGGS
(the publisher) about this shape ever staying the same. Treat any future breakage as expected, not
a bug — see "Defensive parsing" below for how the fetcher is built to fail loudly rather than
quietly emit wrong data when that happens.

- **Discovery page:** `https://www.coggs.com/trail-conditions` — a static-ish HTML page that embeds
  one or more `<iframe src="https://trailbot.com/widgets/feed?keys=<uuid>[,<uuid>...]">` tags. Two
  iframes were found on the page at fetch time: one carrying a single key, one carrying eight
  comma-joined keys.
- **Widget URL pattern:** `https://trailbot.com/widgets/feed?keys=<embedKey>` — a Next.js SSR page.
  The data lives in the `<script id="__NEXT_DATA__" type="application/json">` tag, at
  `props.pageProps.trails[]`. TrailBot supports batching multiple keys into one `?keys=a,b,c`
  request (that's how the 8-key COGGS iframe works), but `scripts/fetch-trailbot.mjs` deliberately
  fetches each discovered key with its OWN single-key request instead, so a failure on one key is
  diagnosable without implicating the other eight.
- **Fetcher:** `scripts/fetch-trailbot.mjs` (`npm run trails:conditions`, run via `tsx` — it
  Zod-validates every record directly against `TrailConditionSchema` before writing anything, a
  stricter in-fetcher check than `scripts/fetch-arcgis.mjs` uses).
- **Discovered key set (9, sorted):**
  ```
  06d1e417-8cb0-4391-8502-3bc0b9eb20ff
  1e6fb673-ffd9-4b21-89b1-616b6c70a517
  2d3b4c0f-ffd3-4bab-be2d-3523c9335737
  39bc49b5-699a-40e1-859d-9a6f70fa3e7e
  456b5fd8-72a7-4253-8376-38e9b8a91c1d
  5af70f8f-9995-4451-8877-a42fbb299a6a
  5bce8b00-d153-428d-91ab-069b6d67b180
  b706151a-1671-4005-a724-c050a7bf78a1
  dd9e8719-d624-4d34-b0ca-762a25b8f468
  ```
  Discovered live by scraping the COGGS page's raw HTML for `trailbot.com/widgets/feed?keys=...`
  iframe `src` values — NOT hand-maintained. A key added or removed on COGGS is picked up
  automatically on the next fetch. (One key, `dd9e8719-d624-4d34-b0ca-762a25b8f468`, was truncated
  in the task brief's own grep and is included here after live re-verification — the brief was
  explicit that its list should not be trusted as complete.)
- **Record count:** 9 — every discovered key returned exactly one trail record in every observed
  fetch (1:1, not N:1). This is an empirical observation, not a guaranteed invariant: a future key
  could plausibly return zero or multiple trails, which is exactly why the fetcher tracks
  zero-trail keys distinctly (see "Defensive parsing") rather than assuming 1:1.
- **Source watermark (`sourceWatermark`):** max `updatedAt` across all 9 records, as ISO. This is
  the source's own last-update time for the most recently updated trail record — NOT a fetch
  timestamp.
- **Geographic scope is WIDER than Duluth city limits.** Despite `region`/`regions` reading
  `"Duluth"` on every record, three of the nine trail systems are outside the City of Duluth:
  Split Rock Wilds (Lake County MTB / Beaver Bay Township), Pokegama Trail and Senior Slide Trail
  (City of Superior, WI), and Pine Valley (Cloquet Area Bike/Hike/Run, City of Cloquet, MN). Only
  five of the nine (Spirit Mountain, Piedmont/Brewer/Enger/Keene, Mission Creek, Hartley Park/UMD/
  Chester, Lester Park/Downer) are within the ArcGIS trails layer's Duluth-municipal scope. See the
  join-proposal report below.

## Why this data exists — the closure-rule gap

The vendored ArcGIS trails layer (`data/duluth-trails.json`, `src/trails.ts`) gives permanent,
structural facts: which activities a trail permits (`uses`), and a coarse `season` of
`summer`/`winter`/`both`. It cannot express the City's actual closure rule, which is
condition-dependent, not calendar-dependent — trails are "closed each Spring/Fall until they are
dry enough, or frozen enough," and reopen "24 hours after a rainfall event." TrailBot supplies
exactly that missing dimension:

- `trailStatus` — the current open/closed/partial state, in the maintainer's own words.
- `statusTags` — short condition tags (observed: `dry`, `hero`, `wet`, `dusty`).
- `last24Precip` / `last24PrecipType` — the machine-readable half of the reopening rule.
- `weatherPolicy` — several records carry the maintaining authority's own prose statement of the
  rule, e.g. (COGGS-maintained trails): *"All trails are closed when raining and are re-opened when
  they have dried to a point that use will not cause damage (typically 12-24 hours after a rain
  event). Monitor Trailbot for the re-open message."* — this is the closest thing this source has to
  a machine-readable policy, and is why it was promoted to a named field rather than left in `raw`.

## Defensive parsing — this is an undocumented SSR payload

`scripts/fetch-trailbot.mjs` treats every layer of this payload as untrusted and can-change:

- **Fetch failure** (HTTP error after 3 retries) for any key: hard, immediate error naming the key.
  Nothing is written.
- **Structural failure** — `__NEXT_DATA__` script tag absent, or `props.pageProps.trails` missing
  from its JSON — hard, immediate error naming the key. This is the "TrailBot changed its SSR
  shape" tripwire.
- **Schema failure** — any individual record that fails `TrailConditionSchema.safeParse` is a hard,
  immediate error naming the record's `embedKey` and the Zod issue path. No record is ever silently
  dropped or coerced.
- **A key returning a structurally valid but EMPTY `trails: []`** is reported distinctly (a named
  warning list), and does NOT by itself abort the run — it is a plausible true fact (e.g. a trail
  system temporarily deactivated), not a parsing failure. If, and only if, **every** discovered key
  returns zero trails, the run still hard-fails: a conditions feed that quietly writes zero records
  is worse than one that errors, because downstream it silently reads as "all trails fine." At the
  time of this fetch, 9/9 keys returned exactly one trail each — zero zero-trail keys observed.

## Observed field shape (9/9 records unless noted)

Every field TrailBot returned across all 9 records, and whether it was promoted to a named
`TrailConditionSchema` property or left to the `raw` catch-all:

- **Always present, promoted:** `embedKey`, `_id`/`trailId` (identical on every record — promoted
  as `trailId`), `trailName`, `slug`, `trailStatus`, `statusTags`, `description`, `activity`,
  `authority`, `agency`, `region`, `regions`, `latitude`, `longitude` (both STRINGS in the source —
  `raw.lat`/`raw.long` carry the source's own parsed-float duplicates, not promoted), `city`,
  `state`, `zipcode`, `timezone`, `last24Precip`, `last24PrecipType`, `updatedAt`, `remindedAt`,
  `sourceDescription`, `url`, `socials`, `organization` (subset: `name`, `slug` promoted; the full
  object — `shortName`, `logoUrl`, `flags`, `embedKey`, `timezone` — survives in `raw.organization`).
- **Present but empty on one record (Split Rock Wilds), normalized `"" -> null`:** `street`, `url`.
- **Present on 6/9, absent (not null) on 3/9, normalized missing -> `null`:** `weatherPolicy`
  (absent on the three non-COGGS-maintained systems: Spirit Mountain, Split Rock Wilds, Senior
  Slide Trail — each has a different maintaining authority with no shared reopening-policy text).
- **Observed, NOT promoted (kept only in `raw`):** `amenities` (present 2/9), `coverUrl` (3/9),
  `createdAt` (1/9), `customFields` (1/9), `donationUrl` (6/9), `ebikePolicy` (1/9), `joinUrl`
  (3/9), `logoUrl` (3/9), `volunteerUrl` (6/9), `waiverUrl` (2/9), `attributes`, `fields`, `counts`,
  `pictures`, `visibility`, `active`, `country`, `source`, `organizationId`, `slugAliases`,
  `updatedBy`, `maps`, `notes`, `latestUpdateId` (all 9/9 present but not consumed downstream).

If a future fetch throws a schema-validation error, check this list first — a field moving from
"always present" to "sometimes absent" (or vice versa), or changing type, is the most likely cause,
and the fix is almost always a `nullIfEmpty`/`nullIfMissing` normalization in the fetcher plus a
`.nullable()` in `TrailConditionSchema`, matching how `street`/`url`/`weatherPolicy` were handled
here — NOT loosening validation by dropping a field from the schema.

## IDEMPOTENCY — same contract as the ArcGIS fetcher, with one difference

Re-running against unchanged upstream data (two runs seconds apart, no new maintainer update
landing in between) produces a byte-identical file — verified for this task, see
`.superpowers/sdd/2026-07-28-place-entity-resolution/task-trailbot-report.md` for the two-run
`git diff`-empty proof.

**Difference from the ArcGIS layers:** trail CONDITIONS are the opposite of an evergreen fact —
`trailStatus` is expected to change hour-to-hour with weather. This committed artifact is a
**point-in-time snapshot**, not a "vendor once, trust forever" reference table like
`data/duluth-trails.json`. Re-run `npm run trails:conditions` whenever the conditions data needs to
be current; the idempotency guarantee is about the WRITER being deterministic (no wall-clock
timestamp, stable sort/key order), not about the underlying reality staying still.

## Licence / attribution posture

No licence or terms-of-use document was found for this data at either `coggs.com` or `trailbot.com`
in the course of this fetch. `sourceDescription` on every record states *"Updates are provided
directly by trail maintainers"* — the content is maintainer-authored, republished by TrailBot and
embedded by COGGS. As with `data/duluth-trails.SOURCE.md`, this note records what was actually
found, not an assumption of permissive licensing; verify before any downstream/public reuse that
depends on licence terms.

## Join proposal — TrailBot trail systems vs. the vendored ArcGIS trails layer (for human review only)

**Not implemented in `src/` — no fuzzy join, no automatic join, this data does not exist as code.**
This section reports what a join to `data/duluth-trails.json` (`Name`/`Park` fields) would look
like by EXACT normalized-string match only, for a human to review and decide on. Full analysis in
`scripts/trailbot-join-propose.mjs` output (`npm run trails:join-propose`):

- **0/9** TrailBot `trailName` values match an ArcGIS `Name` or `Park` value exactly (normalized:
  lowercase, `/`/`-` -> space, whitespace-collapsed) as a WHOLE string. TrailBot's naming convention
  groups multiple trail systems into one compound name (e.g. `"Piedmont/Brewer/Enger/Keene"`), which
  the ArcGIS layer models as separate `Park` values — so a whole-string join was never going to
  match, and no attempt was made to force one.
- Splitting each TrailBot `trailName` on `/` (TrailBot's OWN compound-name delimiter — not an
  invented heuristic; no substring stripping, no abbreviation table) and exact-matching each
  segment against ArcGIS `Name`/`Park` finds **at least one matching segment for 3/9** TrailBot
  records: `Piedmont/Brewer/Enger/Keene` (`Piedmont` -> `Name`; `Brewer`, `Enger` -> `Park`; `Keene`
  itself has no exact match — ArcGIS only has `Keene Creek Corridor`/`Keene Dog Park`/`Keene Park`),
  `Hartley Park/UMD/Chester` (`Hartley Park`, `Chester` -> `Park`; `UMD` has no exact match), and
  `Lester Park Trail Center/Downer` (`Downer` -> `Park`; `Lester Park Trail Center` itself has no
  exact match — ArcGIS only has bare `Lester`/`Lester/Amity` variants).
- **6/9** have zero matching segments at any level: `Spirit Mountain Bike Park` (ArcGIS `Park` has
  bare `"Spirit Mountain"` / `"Spirt Mountain"` (sic) — close but not exact; a human call on whether
  the "Bike Park" suffix + a source typo should be reconciled), `Mission Creek Trail Center` (ArcGIS
  has bare `"Mission Creek"` for both `Name` and `Park` — again close but not exact, no `/` to
  segment on since the name has none), and the four systems confirmed above to be OUTSIDE Duluth
  city limits entirely (`Split Rock Wilds`, `Pokegama Trail`, `Senior Slide Trail`, `Pine Valley`) —
  these are not expected to appear in a Duluth-municipal ArcGIS layer at all, and a "no match" here
  is the CORRECT outcome, not a join failure.

Run `npm run trails:join-propose` for the full per-record breakdown.
