# data/duluth-neighborhoods.json — provenance

- **Origin:** City of Duluth GIS Office (`copyrightText` on the ArcGIS service root), service
  `Neighborhoods_Duluth/FeatureServer/0` — "City of Duluth, Mn Neighborhood Boundaries".
- **Query endpoint:** `https://services.arcgis.com/DgKyOSWnVuXUe0Jp/arcgis/rest/services/Neighborhoods_Duluth/FeatureServer/0/query`
- **Fetcher:** `scripts/fetch-arcgis.mjs` (`npm run places:arcgis`)
- **Record count:** 31 (confirmed via `returnCountOnly=true`; single page, well under
  `maxRecordCount` of 1000).
- **Source watermark (`sourceWatermark`):** max `last_edited_date` across all 31 records, as ISO —
  same non-wall-clock discipline as `data/duluth-trails.SOURCE.md`.
- **Geometry:** NOT vendored (`returnGeometry=false` — 31 polygons would dominate this small
  artifact). `Shape__Area` (sq ft) and `Shape__Length` (ft) are kept as scalar proxies; full polygon
  geometry remains available live from the query endpoint above.
- **Intended join:** to the free-text `neighborhood` field already present on each venue in
  `data/homegrown-venues.json`. That join is NOT exact — the homegrown data uses compound labels
  like `"Downtown Duluth / Central Hillside"` and `"Lincoln Park / Craft District"` that span what
  this layer treats as separate neighborhood polygons (e.g. this layer has both `"Central Hillside"`
  and `"East Hillside"` as distinct entries, and no `"Craft District"` entry at all) — resolving
  that join is left to a future consumer, not attempted here.

## Licence / attribution posture

Same posture as `data/duluth-trails.SOURCE.md`: the ArcGIS REST root carries
`copyrightText: "City of Duluth GIS Office"` and no separate licence document was found at or linked
from the endpoint. Treat as City of Duluth municipal GIS data with an attribution string but no
confirmed formal open-data licence; verify before downstream/public reuse that depends on licence
terms.

## Field-normalization decisions

- **`GlobalID` → `id`/`globalId`** — this layer's `GlobalID` already arrives brace-free and
  lowercase (e.g. `"6be8a353-9712-4ce8-996f-0d351d47ec21"`), unlike Trails' `"{D6440883-...}"`
  form. `id` still runs through the same normalization function as Trail's `id` (strip `{}`,
  lowercase) for consistency, even though it's a no-op here — both entity kinds key alike.
- **`adminId`** — the source's own integer `ID` field (e.g. 29 for "North Shore"), distinct from
  `objectId` (an ArcGIS row identifier with no meaning outside this service).
- **`raw`** — every record carries the complete, untouched ArcGIS `attributes` object (keys sorted
  alphabetically), preserving `created_user`/`created_data`/`last_edited_user` and the un-normalized
  originals of every promoted field.

Re-fetch with `npm run places:arcgis` only when refreshing the cache; this is a committed snapshot,
not a live dependency.
