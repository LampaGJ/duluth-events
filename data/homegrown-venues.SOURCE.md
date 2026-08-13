# data/homegrown-venues.json — provenance

- **Origin repo:** [`LampaGJ/duluth-homegrown-map`](https://github.com/LampaGJ/duluth-homegrown-map)
- **File:** `homegrown_2026_venues.json` (companion to `homegrown_2026_schedule.json` in the same repo)
- **`generated_at` (from the source JSON):** `2026-04-15T00:00:00Z`
- **Venue count:** 41

First-party, hand-curated data scoped to exactly this project's domain: Duluth-area music venues,
all geocoded. Not machine-geocoded like `data/osm-duluth.json` — each entry carries its own
`sources` (URLs) and `licenses` (City of Duluth Legistar licensee-list links) as real, checkable
provenance, which is why `scripts/places-propose.mjs` treats a tier-0 hit here as `provenance:
{ source: "manual", ref: "homegrown:<venue name>" }` rather than `"osm"` or `"web"`.

Vendored verbatim (no transformation) from `/tmp/hg/venues.json` on 2026-07-28, for Task 9b of the
place-entity-resolution work (see `.superpowers/sdd/2026-07-28-place-entity-resolution/`).

Re-fetch from the origin repo only when refreshing the cache; this is a committed snapshot, not a
live dependency.
