# data/overture-places.json — provenance

- **Origin:** [Overture Maps Foundation](https://overturemaps.org/) `places` theme, `type=place`
  (points of interest — businesses, venues, amenities). Overture is a Linux Foundation project
  combining Meta, Microsoft, TomTom, Esri, AWS and community/OSM contributions into one
  globally-consistent schema with a stable cross-dataset join key (GERS — see below).
- **Release (pinned):** `2026-07-22.0` — hardcoded in `scripts/fetch-overture.mjs` (`RELEASE_VERSION`),
  deliberately not "latest". Overture ships a new release roughly twice a month; querying "latest" on
  every run would make this artifact drift on a schedule we don't control and would break the
  idempotency contract below (two runs either side of a release boundary would legitimately differ).
  Bump `RELEASE_VERSION` deliberately, in its own commit, to pick up a newer release.
- **Query:** `s3://overturemaps-us-west-2/release/2026-07-22.0/theme=places/type=place/*`, filtered to
  the same Duluth bbox `data/duluth-trails.json`'s ArcGIS layer and `data/osm-duluth.json`'s Overpass
  extract both use: `bbox.xmin BETWEEN -92.35 AND -91.90 AND bbox.ymin BETWEEN 46.60 AND 46.95`.
  Public/anonymous S3 read — no credentials required. Query engine: DuckDB (`spatial` + `httpfs`
  extensions), shelled out to from `scripts/fetch-overture.mjs` — no `duckdb` npm binding exists in
  this project's dependency set, and the CLI is the documented zero-new-dependency path.
- **Fetcher:** `scripts/fetch-overture.mjs` (`npm run places:overture`)
- **GERS id:** Overture's Global Entity Reference System id — a stable UUID that is Overture's own
  cross-theme, cross-release join key (https://docs.overturemaps.org/gers/). Vendored as `gersId` on
  every record and, per this task, as an optional `Place.gersId` join key in `src/schema.ts` — purely
  additive; our lowercase-kebab `Place.id` remains the sole public/URL-stable identifier and does not
  move.

## Record count and the addressless-point filter

- **7,693** places matched the bbox query (measured live, unfiltered).
- **7,428** (96.6%) were vendored; **265** were dropped for having no usable street address:
  - 198 records have `addresses[1] IS NULL` outright (no address at all).
  - A further 67 records have a non-null `addresses[1].freeform` that is an **empty string** after
    trimming — a real, previously-invisible data-quality wrinkle in Overture's own extract (a `NOT
    NULL` check alone undercounts the addressless population by exactly this much; measured directly
    against the live bbox query, not inferred).
- **Filter rationale (`addresses[1]` present and non-blank):** an addressless point cannot serve
  either of this registry's two uses for Overture data — a name-token match candidate that also
  carries a real street address to enrich onto a hit (the whole point of vendoring Overture over the
  OSM cache, which is comparatively address-poor), or an address-alias candidate in its own right. It
  is Overture's least useful record shape for `scripts/places-propose.mjs`'s purposes, so it is
  filtered at vendor time rather than carried as dead weight into every future consumer of this file.
  This is the "all with an address" option named in the task spec, not an arbitrary cut.
- **What was NOT filtered, and why:** `operating_status` (4,852 `"open"`, 2,519 `null`/unreported, 57
  `"permanently_closed"`) is vendored as-is, unfiltered — a permanently-closed business is still a
  real fact about a real address and has reference value (e.g. explaining why a raw venue string no
  longer geocodes to an active listing). `scripts/places-propose.mjs`'s Overture tier is the layer
  responsible for excluding `"permanently_closed"` candidates from proposal, not this artifact.
  Categories were likewise NOT filtered to a "venue-ish" allowlist: 872 distinct `categories.primary`
  values appear across the 7,428 vendored records, spanning far more than event venues (dry cleaners,
  warehouses, ATMs) — but a would-be venue allowlist can't be drawn reliably without the very
  eventType-taxonomy work this task is explicitly OUT OF SCOPE for (see the task report's
  eventType-change measurement). Keeping the full category range costs ~5MB and zero behavior change;
  narrowing it would have required a judgment call this task isn't authorized to make.

## Fields kept, and what was deliberately dropped

Per task spec ("keep the fields that matter... drop geometry blobs"):

- **Kept:** `gersId`, `name`, `alternateNames` (from `names.common`, empty on every record in this
  bbox/release — see `src/overture.ts`'s TSDoc), `categories.primary`/`categories.alternate`,
  `confidence` (Overture's own [0,1] place-confidence score), `address` (freeform/locality/postcode/
  region/country), `lat`/`lon` (extracted from the point geometry via `ST_Y`/`ST_X`, NOT the bbox
  centroid), `operatingStatus`, `sourceDatasets`.
- **Dropped: raw `geometry`.** Per task spec explicitly.
- **Dropped: the raw `sources` array.** Each record's `sources` struct array carries the real
  provenance chain, but in practice includes dozens of near-duplicate `Overture-signals`
  `operating_status` entries differing ONLY by an `update_time` timestamp (12 entries observed on a
  single record in manual inspection) — vendoring it as-is would multiply this file's size for zero
  matching value and would embed timestamps that are not this registry's watermark discipline
  (`sourceWatermark` is the release version, not per-record signal times — see below). Distilled to
  `sourceDatasets`: the distinct, sorted list of `sources[].dataset` names contributing to the record
  (e.g. `["Foursquare", "Overture", "Overture-signals"]`), which is what "source/dataset attribution"
  actually needs.
- **Dropped: `basic_category`, `taxonomy`, `version`, `theme`/`type` (constant across every row),
  `websites`/`emails`/`socials`/`phones`, `brand`.** Not asked for in the task spec and not used by
  any consumer of this artifact; all remain available live from the same S3 query if a future
  consumer needs them — this is a committed snapshot, not a re-derivation of the full schema.

## Idempotency

Re-running `npm run places:overture` twice against the SAME pinned release (`2026-07-22.0`) produces
a byte-identical file — verified for this task (Task place-entity-resolution): run 1 wrote
`data/overture-places.json`; run 2's own log line read `wrote data/overture-places.json — 7428
record(s) (265 addressless dropped), watermark 2026-07-22.0 (unchanged)`, and a byte diff against a
copy of run 1's output was empty. See `.superpowers/sdd/2026-07-28-place-entity-resolution/task-overture-report.md`
for the full transcript.

Determinism comes from: `ORDER BY gers_id` in the SQL (re-sorted defensively in JS too), `list_sort`/
`list_distinct` on every array field in the SQL (re-sorted defensively in JS too), and NO wall-clock
timestamp anywhere in the written file — `sourceWatermark`/`releaseVersion` is the pinned Overture
release string, which only changes when `RELEASE_VERSION` in the fetcher is deliberately bumped.

## Licence / attribution posture

Overture Maps data is licensed under a mix of **ODbL 1.0** (for OpenStreetMap-derived contributions)
and **CDLA-Permissive-2.0** (for Overture's own aggregation and most commercial-partner contributions
— Microsoft, Meta, Esri, TomTom). The live query's own `sources[].license` field, sampled across this
vendored set, returns exactly three values: `CDLA-Permissive-2.0`, `Apache-2.0`, and `CC0-1.0` — no
`ODbL` string was observed on any record actually returned for this bbox, but Overture's own top-level
licensing documentation (https://docs.overturemaps.org/attribution/) states the combined places
dataset is `ODbL`-compatible and requires attribution regardless of which contributing dataset backs
an individual record; treat the dataset as ODbL-equivalent for attribution purposes and do not rely
on the absence of an explicit `ODbL` string in this particular slice as evidence that no ODbL-derived
data is present.

**Attribution requirement:** Overture explicitly requires attribution distinct from OpenStreetMap's
own — "© Overture Maps Foundation" (or equivalent), per
https://docs.overturemaps.org/attribution/. The project's landing page already carries an OSM
attribution line (see `docs/` or the rendered index) for `data/osm-duluth.json`; **that line does NOT
cover Overture data** and a separate "Places data © Overture Maps Foundation" attribution line is
still owed wherever `data/overture-places.json` (or values derived from it, e.g. a proposed Place
literal whose `provenance.ref` starts with `overture:`) reaches a public page. This is flagged here as
an open action item — no public-facing page was edited by this task (scope was data vendoring +
schema + the offline proposer script only).

## Field-normalization decisions (see TSDoc on `OverturePlaceSchema` in `src/overture.ts` for the same, closer to the code)

- **`gersId` sort/primary key** — same role `globalId`/`embedKey` play for the ArcGIS/TrailBot
  artifacts: a stable UUID Overture assigns and controls, used as this artifact's sort key and its
  join-key candidate into `Place.gersId`.
- **`categories`** — kept as `{ primary, alternate }`, matching the source struct exactly (872
  distinct `primary` values across the vendored set — see the eventType-change measurement in the
  task report for how these compare against `classifyByVenue`'s substring rules). NOT collapsed or
  remapped to our `EventType` vocabulary here — that is explicitly out of scope for this task; this
  file is raw reference data, one layer below any classification decision.
- **`operatingStatus`** — left as a plain nullable string, not a Zod enum, because it is externally
  controlled vocabulary Overture (not this project) defines; only 3 values (`"open"`,
  `"permanently_closed"`, `null`) are observed today, but a stricter enum would hard-fail the fetcher
  the moment a future release adds a fourth without warning, which is a worse failure mode than
  accepting an unrecognized string.
- **`address`** — `locality`/`postcode`/`region`/`country` are nullable (Overture leaves them null more
  often than `freeform`, which this artifact requires non-blank by the filter above); `freeform` alone
  is guaranteed present and non-blank on every vendored record.

Re-fetch with `npm run places:overture` only when deliberately bumping `RELEASE_VERSION`; this is a
committed snapshot, not a live dependency.
