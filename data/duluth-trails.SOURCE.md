# data/duluth-trails.json — provenance

- **Origin:** City of Duluth GIS Staff (`copyrightText` on the ArcGIS service root), layer
  `Parks/TrailsDuluthService/MapServer/14` — "Trails - All City", the master feature table. Layers
  0-13 on the same service are filtered views over this identical schema and were NOT vendored
  (fetching 14 alone captures every record they'd each show a subset of).
- **Query endpoint:** `https://utility.arcgis.com/usrsvcs/servers/085f4309eec943a8998e801f7849b1b8/rest/services/Parks/TrailsDuluthService/MapServer/14/query`
- **Fetcher:** `scripts/fetch-arcgis.mjs` (`npm run places:arcgis`)
- **Record count:** 800 (measured live; an earlier 400-record hand-sample undercounted by half —
  the full table is 800, still under the layer's own `maxRecordCount` of 1000 in a single page, so
  `exceededTransferLimit` is `false` today — the fetcher still paginates defensively in case that
  changes).
- **Source watermark (`sourceWatermark`):** max `last_edited_date` across all 800 records, as ISO.
  This is NOT a fetch timestamp — it only advances when the City edits a trail record, which is what
  keeps re-running the fetcher against unchanged upstream data a zero-diff no-op.
- **Geometry:** NOT vendored (`returnGeometry=false` — 800 polylines would dominate this artifact).
  `Mileage` (miles) and `SHAPE.STLength()` (source-projected length units) are kept as scalar proxies.
  Full polyline geometry remains available live from the query endpoint above if a future consumer
  needs it (e.g. a map render).
- **Out of scope, not vendored:** the same service family also exposes Streets (5,675 records) and
  Alleys (1,059 records) layers — not fetched here, mentioned only as available should a future task
  need them.

## Licence / attribution posture

The service's ArcGIS REST root metadata carries `copyrightText: "City of Duluth GIS Staff"`. No
separate open-data licence document (e.g. an explicit CC-BY / ODbL / public-domain grant) was found
at the endpoint itself or linked from it — this note records what was actually found, not an
assumption of permissive licensing. Treat this as City of Duluth municipal GIS data with an
attribution string but no confirmed formal licence; verify against the City's official open-data
policy before any downstream/public reuse that depends on licence terms.

## Field-normalization decisions (see TSDoc on `TrailSchema` in `src/schema.ts` for the same, closer to the code)

- **`uses`** — the source's eight loose Y/N-ish columns (`Hiking`, `MountainBiking`,
  `XCountrySkiing`, `Snowmobile`, `Accessible`, `Horseback`, `ATV`, `Adaptive`) become one uniform
  `{ activity, permitted }` array. `permitted` is `true` only for raw `"Y"` or `"Yes"` — every other
  raw value (`"N"`, `"No"`, `null`) normalizes to `false`. `Adaptive` uses `"No"`/`"Yes"` while the
  other seven use `"N"`/`"Y"` — the boolean normalization erases that inconsistency, but the raw
  string survives verbatim under `raw.<ColumnName>` on every record, so nothing is lost.
- **`season`** — raw `Season` (`"Summer"` / `"Winter"` / `"Both"` / `null`, 8/800 records null) maps
  to `"summer" | "winter" | "both"`; `null` maps to `"both"` (the permissive default — treating an
  unstated season as "usable either season" cannot wrongly exclude a trail from a seasonal search,
  whereas guessing a single season could).
- **`surface`** — the source column is literally misspelled `Suface`. The schema field is spelled
  correctly (`surface`); the misspelled raw key is preserved unchanged at `raw.Suface`.
- **`jurisdiction`** — raw values include both `"City"` (605) and `"City of Duluth"` (56), almost
  certainly the same authority under two spellings, but NOT collapsed here — nothing in the source
  proves the equivalence, and inventing it risks quietly erasing a real distinction the City intended
  (e.g. an in-progress data-entry migration between the two forms). Preserved as-is; a consumer that
  needs one canonical municipal jurisdiction should normalize downstream.
- **`partnerOrganization`** — the literal source string `"None"` normalizes to `null` (raw value
  preserved at `raw.PartnerOrganization`); every other value, including the empty-seeming trimmed
  string, passes through as a plain string. This is a forward hook to the future Institution entity
  (issue #3) — deliberately left as a string, not a reference, per the task spec.
- **`GlobalID` → `id`/`globalId`** — `globalId` is the source's exact string (`"{D6440883-...}"`,
  braces + uppercase). `id` is the normalized form (braces stripped, lowercased) used as the sort/
  join key, so it lines up with `Neighborhood.id`'s normalization (that layer's `GlobalID` already
  arrives brace-free and lowercase).
- **`name`** — 44/800 records have a null `Name`: the layer models trail SEGMENTS, not named trails,
  and an unnamed connector segment is a legitimate, expected record — not a data error.
- **`raw`** — every record carries the complete, untouched ArcGIS `attributes` object (keys sorted
  alphabetically for determinism), so any field this schema doesn't promote to a named property
  (`Traverse`, `Position`, `SHT`, `EMVAccess`, `CCT`, `VisibleRecMap`, `created_user`,
  `created_data`, `last_edited_user`) — and the un-normalized original of every field above — is
  still there.

Re-fetch with `npm run places:arcgis` only when refreshing the cache; this is a committed snapshot,
not a live dependency. Re-running it twice in a row against unchanged upstream data produces a
byte-identical file (verified for Task place-entity-resolution — see
`.superpowers/sdd/2026-07-28-place-entity-resolution/task-arcgis-report.md`).
