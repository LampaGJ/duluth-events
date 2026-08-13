# Place Entity Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-source event duplicates merge on venue *identity* rather than string similarity, by resolving every event's venue against a curated registry of canonical Places.

**Architecture:** Split what `LocationSchema` conflates — `place` becomes the venue's name (a canonical entity with a stable public id), `location` becomes the physical address. A curated registry (`src/places.ts`, committed to git) is indexed into O(1) alias maps at load. `finalizeEvent` resolves each event's raw venue string to a `PlaceRef`. Dedupe then keys on `start-instant + placeId`. All fuzzy matching lives in an offline proposer whose output a human pastes into the registry — that human paste is what makes public ids stable.

**Tech Stack:** TypeScript 5.9+, Zod v4, Vitest, tsx, Node 18+ native fetch. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-26-place-entity-resolution-design.md`

## Global Constraints

- **A false merge is worse than a missed merge.** Merging removes an event from the feed; a missed merge only costs a corroboration. Every gate is tuned on this asymmetry.
- **Prove, don't infer.** An unrecognised venue never becomes a guessed place — it becomes `provisional` or nothing.
- **Fuzziness belongs in the proposer, never the build.** The build resolves by exact map lookup only.
- **`scripts/places-propose.mjs` must never write `src/places.ts`.** It prints to stdout / a proposal file. The human paste is the id-stability guarantee.
- **Zod v4 shapes only** — `z.iso.*`, `z.discriminatedUnion`, `{ error }` param, two-arg `z.record`. `.default()` takes the OUTPUT type; use `.prefault()` when the fallback is input to be parsed. Follow the existing `facets: FacetsSchema.prefault({})` precedent in `src/schema.ts`.
- **`agent-zod-zealot` must review every new or changed Zod schema before it merges** (user standing rule). Tasks 1 and 7 both change schemas.
- **Gates after every task:** `npx tsc --noEmit` (exit 0) and `npx vitest run` (currently 95/95 passing — the count only ever goes up).
- **Every new module carries the project's TSDoc annotations:** `@displayName`, `@strategicPurpose`, `@tacticalObjective`. Follow `src/facets.ts` as the reference.
- **Tests quote corpus phrases verbatim**, including negative cases. Follow `test/facets.test.ts`.
- **Commit after every task.** Stage explicit paths only — never `git add -A`/`.`/`-u`.
- **Branch:** `feat/place-entity-resolution`, off `main@8ccc456`. Already has 4 commits (spec + probe script).

---

## File Structure

**Created:**
- `src/place-resolve.ts` — normalization, sentinel detection, venue-string parsing, resolution. Pure; no I/O. Mirrors `src/facets.ts`.
- `src/places.ts` — the curated registry: a `Place[]` literal. Data only, no logic.
- `src/place-registry.ts` — loads + Zod-validates `PLACES`, builds the alias indexes, throws on duplicate id / colliding alias.
- `scripts/fetch-osm.mjs` — Overpass bulk fetch → `data/osm-duluth.json` (committed cache).
- `scripts/places-propose.mjs` — the proposer: normalize → match → score → print paste-ready literals.
- `test/place-resolve.test.ts`, `test/place-registry.test.ts`, `test/place-dedupe.test.ts`

**Modified:**
- `src/schema.ts` — add `AddressSchema`, `PlaceSchema`, `PlaceRefSchema`; add `place` + `venueRaw` to `DuluthEvent`; later remove `venueName`/`room` from `LocationSchema`.
- `src/classify.ts` — call `resolvePlace` in `finalizeEvent`; **delete** `resolveLocation`.
- `src/dedupe.ts` — two-pass merge.
- `src/emit.ts` — `X-PLACE-*` properties; `LOCATION:` renders from place + address.
- `src/facets.ts` — venue derivation reads `venueRaw`/`place` instead of `location.venueName`.
- `src/feeds-config.ts`, `src/build.ts` — place feeds + "By venue" group.
- 6 adapter call sites + 5 test files (exact locations in Task 6).

---

## Phase 1 — Schema, resolution, registry (zero merge-behaviour change)

Tasks 1–6. Additive until Task 6, which is the one contained breaking window.

---

### Task 1: Address, Place, and PlaceRef schemas

**Files:**
- Modify: `src/schema.ts` (add after the `FacetsSchema` block, before `DuluthEventSchema`)
- Test: `test/schema.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `AddressSchema`, `PlaceSchema`, `PlaceRefSchema`, and the types `Address`, `Place`, `PlaceRef`. `DuluthEvent` gains `place?: PlaceRef` and `venueRaw?: string`.

This task is **purely additive** — `LocationSchema` keeps `venueName`, so nothing breaks.

- [ ] **Step 1: Write the failing test**

Append to `test/schema.test.ts`:

```ts
import { PlaceSchema, PlaceRefSchema, AddressSchema, DuluthEventSchema } from "../src/schema.js";

describe("PlaceSchema", () => {
  it("accepts a fully specified place", () => {
    const p = PlaceSchema.parse({
      id: "bent-paddle-taproom",
      name: "Bent Paddle Taproom",
      nameAliases: ["bent paddle brewing", "bent paddle taproom"],
      addressAliases: ["1832 w michigan st"],
      address: { city: "Duluth", state: "MN", street: "1832 W Michigan St" },
      provenance: { source: "osm", ref: "way/123456", retrievedAt: "2026-07-28T00:00:00-05:00" },
    });
    expect(p.address.inDuluth).toBe(true);
    expect(p.rooms).toEqual([]);
  });

  it("rejects an id that is not a stable slug", () => {
    const base = {
      name: "X", nameAliases: [], addressAliases: [],
      address: { city: "Duluth", state: "MN" },
      provenance: { source: "manual" as const },
    };
    expect(() => PlaceSchema.parse({ ...base, id: "Bent Paddle" })).toThrow();
    expect(() => PlaceSchema.parse({ ...base, id: "" })).toThrow();
  });

  it("requires provenance — a machine-fetched address is not a hand-typed one", () => {
    expect(() =>
      PlaceSchema.parse({
        id: "x", name: "X", nameAliases: [], addressAliases: [],
        address: { city: "Duluth", state: "MN" },
      }),
    ).toThrow();
  });
});

describe("PlaceRefSchema", () => {
  it("defaults provisional to false", () => {
    expect(PlaceRefSchema.parse({ id: "x", name: "X" }).provisional).toBe(false);
  });
});

describe("DuluthEvent place fields", () => {
  it("accepts an event with no place at all (unresolved)", () => {
    const e = makeEvent();
    expect(e.place).toBeUndefined();
  });

  it("carries the source's raw venue claim alongside the resolved place", () => {
    const e = makeEvent({ venueRaw: "Bent Paddle Brewing", place: { id: "bent-paddle-taproom", name: "Bent Paddle Taproom" } });
    expect(e.venueRaw).toBe("Bent Paddle Brewing");
    expect(e.place?.provisional).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL — `PlaceSchema` is not exported from `../src/schema.js`.

- [ ] **Step 3: Write the schemas**

In `src/schema.ts`, add after the `FacetsSchema` / `export type Facets` block:

```ts
// ---------------------------------------------------------------------------
// Place entities
// ---------------------------------------------------------------------------

/**
 * @displayName Address
 * @strategicPurpose WHERE on earth an event happens, kept strictly separate from WHAT the venue is
 *   called. Conflating the two is why `venueName` ended up carrying strings like
 *   "Bismarck, ND, MDU Resources Community Bowl" and 59 out-of-state games shipped inside
 *   `duluth-proper.ics`.
 * @tacticalObjective Carry the geographic facts a feed consumer needs, and nothing else.
 */
export const AddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().default("Duluth"),
  state: z.string().default("MN"),
  zip: z.string().optional(),
  geo: GeoSchema.optional(),
  /** false => Superior WI / Iron Range / an away game. Derived from `city`, never hand-set. */
  inDuluth: z.boolean().default(true),
});
export type Address = z.infer<typeof AddressSchema>;

/** Where a registry fact came from. Required: a fetched address and a typed one are not the same. */
export const PlaceProvenanceSchema = z.object({
  source: z.enum(["osm", "web", "manual"]),
  ref: z.string().optional(), // OSM element id ("way/123456"), or the URL a fact came from
  retrievedAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * @displayName Place
 * @strategicPurpose The canonical venue entity. Cross-source dedupe keys on place identity because
 *   string similarity provably cannot separate true from false merges — venue-token similarity
 *   between CONFIRMED duplicate pairs ranges from 0.13 to 0.83.
 * @tacticalObjective Hold a hand-set stable id (it appears in feed URLs), every normalized alias
 *   that resolves to it, and a canonical address used to enrich events whose source gave none.
 */
export const PlaceSchema = z.object({
  /** Hand-set, stable, lowercase-kebab. Appears in feed URLs, so it must never move. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "place id must be lowercase-kebab (it appears in feed URLs)" }),
  name: z.string().min(1),
  /** Pre-normalized name forms — see normalizeVenueKey(). Resolution is an O(1) lookup, not fuzzy. */
  nameAliases: z.array(z.string()).default([]),
  /** Pre-normalized address forms. This is how an address-only listing merges with a name-only one. */
  addressAliases: z.array(z.string()).default([]),
  address: AddressSchema,
  /** Subdivisions: "The Yard", "AMSOIL Arena", "Council Chambers". Declarative; inert until an adapter populates room. */
  rooms: z.array(z.string()).default([]),
  /** Forward hook for Institution (issue #3): a name, deliberately not yet a reference. */
  operator: z.string().optional(),
  provenance: PlaceProvenanceSchema,
});
export type Place = z.infer<typeof PlaceSchema>;

/**
 * What an event carries. `provisional` = auto-derived from an unregistered string: usable for
 * dedupe, but never given a public feed URL, because no stability promise can be made about it.
 */
export const PlaceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  room: z.string().optional(),
  provisional: z.boolean().default(false),
});
export type PlaceRef = z.infer<typeof PlaceRefSchema>;
```

Then inside `DuluthEventSchema`'s object, immediately after the `location: LocationSchema,` line:

```ts
    /** The source's LITERAL venue string, preserved as provenance and used as the resolution input. */
    venueRaw: z.string().optional(),
    /** Resolved canonical venue. Absent = unresolved (a sentinel, or a string we declined to guess at). */
    place: PlaceRefSchema.optional(),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/schema.test.ts && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 5: Zod review (mandatory)**

Dispatch `agent-zod-zealot` on the `src/schema.ts` diff. Apply any rewrites it makes; re-run both gates.

- [ ] **Step 6: Commit**

```bash
git add src/schema.ts test/schema.test.ts
git commit -m "Add Address, Place, and PlaceRef schemas

Additive only — LocationSchema is unchanged, so nothing breaks yet.
place = the venue's name (canonical entity, stable id in feed URLs);
location = the physical address. venueRaw preserves the source's
literal claim as provenance and is the resolution input."
```

---

### Task 2: Venue-string normalization, sentinels, and parsing

**Files:**
- Create: `src/place-resolve.ts`
- Test: `test/place-resolve.test.ts`

**Interfaces:**
- Consumes: `cleanText` from `src/normalize.js`; `extractLeadingCity` from `src/facets.js`.
- Produces:
  - `normalizeVenueKey(raw: string): string`
  - `isSentinelVenue(raw: string): boolean`
  - `parseVenueString(raw: string): { name: string; city?: string; state?: string }`

`parseVenueString` is where the deleted `resolveLocation`'s away-games logic lands. It reuses the already-tested `extractLeadingCity`.

- [ ] **Step 1: Write the failing test**

Create `test/place-resolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeVenueKey, isSentinelVenue, parseVenueString } from "../src/place-resolve.js";

describe("normalizeVenueKey", () => {
  it("unescapes ICS, then decodes entities, then normalizes", () => {
    // Verbatim corpus strings. ICS escapes `;` as `\;`, which defeated entity decoding in the probe.
    expect(normalizeVenueKey("Vista Fleet Sightseeing &#038\\; Dining Cruises")).toBe("vista fleet sightseeing dining cruises");
    expect(normalizeVenueKey("Whole Foods Co-op &#8211; Hillside")).toBe("whole foods co op hillside");
    expect(normalizeVenueKey("Wussow&#8217;s Concert Cafe")).toBe("wussows concert cafe");
  });

  it("strips parenthetical room/building suffixes", () => {
    expect(normalizeVenueKey("Glensheen Mansion (G)")).toBe("glensheen mansion");
    expect(normalizeVenueKey("Marshall W. Alworth Planetarium (MWAP)")).toBe("marshall w alworth planetarium");
  });

  it("collapses punctuation and whitespace so variants converge", () => {
    expect(normalizeVenueKey("Bent Paddle Taproom // 1832 W Michigan St. // Duluth")).toBe(
      normalizeVenueKey("Bent Paddle Taproom 1832 W Michigan St"),
    );
  });

  it("is idempotent", () => {
    const once = normalizeVenueKey("Whole Foods Co-op &#8211; Hillside");
    expect(normalizeVenueKey(once)).toBe(once);
  });
});

describe("isSentinelVenue", () => {
  it("recognises every sentinel in the corpus", () => {
    for (const s of ["See listing", "Not specified", "See catalog", "See agenda", "Sign in to download the location"]) {
      expect(isSentinelVenue(s)).toBe(true);
    }
  });

  it("does not swallow a real venue", () => {
    expect(isSentinelVenue("Lake Superior Estuarium")).toBe(false);
    expect(isSentinelVenue("Bent Paddle Brewing")).toBe(false);
  });

  it("treats empty and whitespace as sentinel", () => {
    expect(isSentinelVenue("")).toBe(true);
    expect(isSentinelVenue("   ")).toBe(true);
  });
});

describe("parseVenueString", () => {
  it("splits an away-game venue into name and city — the 59-games regression", () => {
    expect(parseVenueString("Bismarck, ND, MDU Resources Community Bowl")).toEqual({
      name: "MDU Resources Community Bowl", city: "Bismarck", state: "ND",
    });
    expect(parseVenueString("Pueblo, CO, Massari Arena")).toEqual({
      name: "Massari Arena", city: "Pueblo", state: "CO",
    });
  });

  it("handles AP-style state abbreviations", () => {
    expect(parseVenueString("St. Cloud, Minn., Herb Brooks National Hockey Center")).toEqual({
      name: "Herb Brooks National Hockey Center", city: "St. Cloud", state: "MN",
    });
  });

  it("falls back to the city as the name when nothing follows it", () => {
    expect(parseVenueString("River Falls, WI")).toEqual({ name: "River Falls", city: "River Falls", state: "WI" });
  });

  it("leaves an ordinary venue untouched", () => {
    expect(parseVenueString("Lake Superior Estuarium")).toEqual({ name: "Lake Superior Estuarium" });
    expect(parseVenueString("Council Chambers-3rd Floor of City Hall")).toEqual({ name: "Council Chambers-3rd Floor of City Hall" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/place-resolve.test.ts`
Expected: FAIL — cannot resolve `../src/place-resolve.js`.

- [ ] **Step 3: Write the implementation**

Create `src/place-resolve.ts`:

```ts
import { cleanText } from "./normalize.js";
import { extractLeadingCity } from "./facets.js";

/**
 * Venue-string normalization and resolution.
 *
 * @displayName Place Resolver
 * @strategicPurpose Cross-source duplicates cannot be found by comparing venue strings — the same
 *   physical place appears as "Bent Paddle Brewing", "Bent Paddle Taproom // 1832 W Michigan St. //
 *   Duluth", and "1832 W Michigan St, Duluth, MN, United States, Minnesota 55806". Resolution turns
 *   all three into one identity.
 * @tacticalObjective Normalize a raw venue string to a stable lookup key, reject sentinels, and
 *   split packed "City, ST, Venue" forms — deterministically, with no fuzzy matching and no I/O.
 */

/**
 * Placeholder strings sources emit when they have no venue. These must NEVER resolve to a place:
 * two events at the same instant both reading "See listing" are demonstrably different events, and
 * merging them would DELETE one. 129 of 461 live events (28%) carry one.
 */
const SENTINELS = [
  "see listing",
  "see catalog",
  "see agenda",
  "not specified",
  "sign in to download the location",
  "tbd",
  "to be determined",
  "various",
  "varies",
];

/**
 * Normalize to a lookup key. Order matters and each step fixes a measured probe defect:
 *   1. unescape ICS (`\;` `\,` `\\`) — otherwise `&#038\;` never decodes
 *   2. decode HTML entities (cleanText)
 *   3. strip parenthetical suffixes — "(G)", "(MWAP)" are room/building codes, not venue identity
 *   4. lowercase, strip punctuation, collapse whitespace
 */
export function normalizeVenueKey(raw: string): string {
  const unescaped = raw.replace(/\\([;,\\])/g, "$1");
  return cleanText(unescaped)
    .replace(/\(.*?\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isSentinelVenue(raw: string): boolean {
  const key = normalizeVenueKey(raw ?? "");
  if (!key) return true;
  return SENTINELS.some((s) => key === s || key.startsWith(`${s} `));
}

/**
 * Split a packed venue string into its name and, when present, the city it leads with.
 *
 * UMD athletics encodes away games as "<City>, <ST>, <Venue>" inside the venue field while the city
 * field still says Duluth — which shipped 59 out-of-state games inside `duluth-proper.ics`. This is
 * where the deleted `resolveLocation()`'s fix now lives, parsing into the RIGHT fields instead of
 * rewriting a conflated one.
 */
export function parseVenueString(raw: string): { name: string; city?: string; state?: string } {
  const found = extractLeadingCity(raw);
  if (!found) return { name: cleanText(raw) };
  return { name: found.rest || found.city, city: found.city, state: found.state };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/place-resolve.test.ts && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/place-resolve.ts test/place-resolve.test.ts
git commit -m "Venue-string normalization, sentinels, and parsing

normalizeVenueKey unescapes ICS BEFORE decoding entities — the probe
measured that \\; escaping silently defeated entity decoding, so
'Vista Fleet Sightseeing &#038\\; Dining Cruises' reached the geocoder raw.

parseVenueString is where the deleted resolveLocation's away-games fix
lands, parsing into the right fields rather than rewriting a conflated one."
```

---

### Task 3: The registry and its indexes

**Files:**
- Create: `src/places.ts`, `src/place-registry.ts`
- Test: `test/place-registry.test.ts`

**Interfaces:**
- Consumes: `PlaceSchema`, `Place` from `src/schema.js`; `normalizeVenueKey` from `src/place-resolve.js`.
- Produces:
  - `PLACES: Place[]` (from `src/places.ts`)
  - `buildPlaceIndex(places: readonly unknown[]): PlaceIndex`
  - `PLACE_INDEX: PlaceIndex`
  - `interface PlaceIndex { byId: Map<string, Place>; byNameAlias: Map<string, Place>; byAddressAlias: Map<string, Place>; all: Place[] }`

The registry starts with **three** hand-verified entries so the machinery is exercised end-to-end. Task 8 fills it out.

- [ ] **Step 1: Write the failing test**

Create `test/place-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPlaceIndex, PLACE_INDEX } from "../src/place-registry.js";
import { PLACES } from "../src/places.js";

const base = {
  address: { city: "Duluth", state: "MN" },
  provenance: { source: "manual" as const },
};

describe("buildPlaceIndex", () => {
  it("indexes name and address aliases separately", () => {
    const idx = buildPlaceIndex([
      { ...base, id: "bent-paddle-taproom", name: "Bent Paddle Taproom", nameAliases: ["bent paddle brewing"], addressAliases: ["1832 w michigan st"] },
    ]);
    expect(idx.byNameAlias.get("bent paddle brewing")?.id).toBe("bent-paddle-taproom");
    expect(idx.byAddressAlias.get("1832 w michigan st")?.id).toBe("bent-paddle-taproom");
    expect(idx.byNameAlias.get("1832 w michigan st")).toBeUndefined();
  });

  it("indexes the canonical name itself, so it need not be repeated as an alias", () => {
    const idx = buildPlaceIndex([{ ...base, id: "wussows", name: "Wussow's Concert Cafe", nameAliases: [], addressAliases: [] }]);
    expect(idx.byNameAlias.get("wussows concert cafe")?.id).toBe("wussows");
  });

  it("normalizes aliases on the way in, so the registry can hold readable forms", () => {
    const idx = buildPlaceIndex([{ ...base, id: "glensheen", name: "Glensheen", nameAliases: ["Glensheen Mansion (G)"], addressAliases: [] }]);
    expect(idx.byNameAlias.get("glensheen mansion")?.id).toBe("glensheen");
  });

  // --- fail-fast invariants: a broken registry must stop the build, not mis-resolve ---

  it("throws on a duplicate id", () => {
    expect(() =>
      buildPlaceIndex([
        { ...base, id: "dup", name: "A", nameAliases: [], addressAliases: [] },
        { ...base, id: "dup", name: "B", nameAliases: [], addressAliases: [] },
      ]),
    ).toThrow(/duplicate place id/i);
  });

  it("throws when two places claim the same name alias", () => {
    expect(() =>
      buildPlaceIndex([
        { ...base, id: "a", name: "A", nameAliases: ["shared venue"], addressAliases: [] },
        { ...base, id: "b", name: "B", nameAliases: ["shared venue"], addressAliases: [] },
      ]),
    ).toThrow(/alias .* claimed by/i);
  });

  it("throws when two places claim the same address alias", () => {
    expect(() =>
      buildPlaceIndex([
        { ...base, id: "a", name: "A", nameAliases: [], addressAliases: ["1 main st"] },
        { ...base, id: "b", name: "B", nameAliases: [], addressAliases: ["1 main st"] },
      ]),
    ).toThrow(/alias .* claimed by/i);
  });

  it("throws on a place that fails schema validation", () => {
    expect(() => buildPlaceIndex([{ ...base, id: "Not A Slug", name: "X", nameAliases: [], addressAliases: [] }])).toThrow();
  });

  it("rejects a sentinel used as an alias — sentinels must never resolve", () => {
    expect(() =>
      buildPlaceIndex([{ ...base, id: "a", name: "A", nameAliases: ["see listing"], addressAliases: [] }]),
    ).toThrow(/sentinel/i);
  });
});

describe("the shipped registry", () => {
  it("loads and validates", () => {
    expect(PLACE_INDEX.all.length).toBe(PLACES.length);
    expect(PLACE_INDEX.all.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = PLACE_INDEX.all.map((p) => p.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/place-registry.test.ts`
Expected: FAIL — cannot resolve `../src/place-registry.js`.

- [ ] **Step 3: Write the registry data**

Create `src/places.ts`:

```ts
import type { Place } from "./schema.js";

/**
 * The canonical venue registry — the SOURCE OF TRUTH for place identity.
 *
 * @displayName Place Registry
 * @strategicPurpose Place ids appear in feed URLs, so they must never move. This file is curated and
 *   committed: `scripts/places-propose.mjs` PROPOSES entries but never writes here. The human paste
 *   IS the id-stability guarantee, and every judgment is visible in a git diff.
 * @tacticalObjective Map every venue-string variant a source emits onto one stable id, with a
 *   canonical address used to enrich events whose source supplied none.
 *
 * Adding an entry:
 *   1. `npm run places:propose` — prints paste-ready literals with provenance and a similarity score
 *   2. VERIFY the match yourself. A geocoder's confident wrong answer looks exactly like data:
 *      "Restaurant 301" resolved to "Perkins", "Sioux Falls" to "South Duluth Avenue".
 *   3. Paste here. Aliases may be written readably — buildPlaceIndex normalizes them on load.
 *
 * Address data from OpenStreetMap is ODbL; attribution ships in the feed footer.
 */
export const PLACES: Place[] = [
  {
    id: "bent-paddle-taproom",
    name: "Bent Paddle Brewing Co. — Brewery + Taproom",
    nameAliases: ["Bent Paddle Brewing", "Bent Paddle Taproom", "Bent Paddle Taproom 1832 W Michigan St."],
    addressAliases: ["1832 W Michigan St", "1832 W Michigan St, Duluth, MN, United States, Minnesota 55806"],
    address: { street: "1832 W Michigan St", city: "Duluth", state: "MN", inDuluth: true },
    rooms: ["The Yard"],
    provenance: { source: "manual", ref: "corpus + nominatim; street taken from the corpus listing, not the OSM 1912 result" },
  },
  {
    id: "lake-superior-estuarium",
    name: "Lake Superior Estuarium",
    nameAliases: [],
    addressAliases: ["3 Marina Drive", "3 Marina Dr"],
    address: { street: "3 Marina Drive", city: "Superior", state: "WI", geo: { lat: 46.7221, lon: -92.063 }, inDuluth: false },
    provenance: { source: "osm", ref: "nominatim:Lake Superior Estuarium, Superior, WI" },
  },
  {
    id: "wussows-concert-cafe",
    name: "Wussow's Concert Cafe",
    nameAliases: [],
    addressAliases: ["324 N Central Ave", "324 North Central Avenue"],
    address: { street: "324 North Central Avenue", city: "Duluth", state: "MN", geo: { lat: 46.7386, lon: -92.1662 }, inDuluth: true },
    provenance: { source: "osm", ref: "nominatim:Wussow's Concert Cafe, Duluth, MN" },
  },
];
```

Create `src/place-registry.ts`:

```ts
import { PlaceSchema, type Place } from "./schema.js";
import { normalizeVenueKey, isSentinelVenue } from "./place-resolve.js";
import { PLACES } from "./places.js";

/**
 * Registry loading and indexing.
 *
 * @displayName Place Index
 * @strategicPurpose Resolution must be O(1) and exact at build time — all fuzziness lives in the
 *   offline proposer. This turns the curated registry into the lookup maps that make that possible.
 * @tacticalObjective Validate every entry, normalize aliases on the way in, and FAIL FAST on a
 *   duplicate id or a colliding alias: the registry is a build-time asset, so a broken one must stop
 *   the build rather than silently mis-resolve events.
 */

export interface PlaceIndex {
  byId: Map<string, Place>;
  byNameAlias: Map<string, Place>;
  byAddressAlias: Map<string, Place>;
  all: Place[];
}

export function buildPlaceIndex(places: readonly unknown[]): PlaceIndex {
  const all = places.map((p) => PlaceSchema.parse(p));

  const byId = new Map<string, Place>();
  for (const p of all) {
    if (byId.has(p.id)) throw new Error(`duplicate place id: "${p.id}"`);
    byId.set(p.id, p);
  }

  const byNameAlias = new Map<string, Place>();
  const byAddressAlias = new Map<string, Place>();

  const claim = (map: Map<string, Place>, kind: string, raw: string, p: Place): void => {
    const key = normalizeVenueKey(raw);
    if (!key) return;
    if (isSentinelVenue(key)) throw new Error(`place "${p.id}" claims sentinel ${kind} alias "${raw}" — sentinels must never resolve`);
    const existing = map.get(key);
    if (existing && existing.id !== p.id) throw new Error(`${kind} alias "${key}" claimed by both "${existing.id}" and "${p.id}"`);
    map.set(key, p);
  };

  for (const p of all) {
    claim(byNameAlias, "name", p.name, p); // the canonical name is always an alias for itself
    for (const a of p.nameAliases) claim(byNameAlias, "name", a, p);
    for (const a of p.addressAliases) claim(byAddressAlias, "address", a, p);
  }

  return { byId, byNameAlias, byAddressAlias, all };
}

/** The shipped registry, validated at module load. A bad entry throws before any event is processed. */
export const PLACE_INDEX: PlaceIndex = buildPlaceIndex(PLACES);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/place-registry.test.ts && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/places.ts src/place-registry.ts test/place-registry.test.ts
git commit -m "Place registry with fail-fast index building

Registry is Zod-parsed at load; duplicate ids and aliases claimed by two
places throw immediately. A build-time asset must stop the build rather
than mis-resolve. Sentinels are rejected as aliases outright.

Seeded with three hand-verified entries to exercise the machinery.
Note bent-paddle uses the corpus street (1832) not the OSM result (1912) —
flagged in provenance as needing confirmation."
```

---

### Task 4: `resolvePlace` and wiring into `finalizeEvent`

**Files:**
- Modify: `src/place-resolve.ts` (append), `src/classify.ts`
- Test: `test/place-resolve.test.ts` (append), `test/classify.test.ts` (append)

**Interfaces:**
- Consumes: `PlaceIndex`, `PLACE_INDEX` from `src/place-registry.js`; `PlaceRef` from `src/schema.js`.
- Produces: `resolvePlace(venueRaw: string | undefined, index?: PlaceIndex): PlaceRef | undefined`

Still zero merge-behaviour change — `dedupe.ts` is untouched.

- [ ] **Step 1: Write the failing test**

Append to `test/place-resolve.test.ts`:

```ts
import { resolvePlace } from "../src/place-resolve.js";
import { buildPlaceIndex } from "../src/place-registry.js";

const IDX = buildPlaceIndex([
  {
    id: "bent-paddle-taproom", name: "Bent Paddle Taproom",
    nameAliases: ["Bent Paddle Brewing"], addressAliases: ["1832 W Michigan St"],
    address: { city: "Duluth", state: "MN" }, provenance: { source: "manual" as const },
  },
]);

describe("resolvePlace", () => {
  it("resolves every corpus variant of one venue to the same id", () => {
    const variants = [
      "Bent Paddle Brewing",
      "Bent Paddle Taproom // 1832 W Michigan St. // Duluth",
      "Bent Paddle Taproom 1832 W Michigan St.",
      "1832 W Michigan St",
    ];
    const ids = variants.map((v) => resolvePlace(v, IDX)?.id);
    expect(ids).toEqual(Array(4).fill("bent-paddle-taproom"));
    expect(resolvePlace("Bent Paddle Brewing", IDX)?.provisional).toBe(false);
  });

  it("returns undefined for a sentinel — the false-merge guard", () => {
    for (const s of ["See listing", "Not specified", "Sign in to download the location", ""]) {
      expect(resolvePlace(s, IDX)).toBeUndefined();
    }
    expect(resolvePlace(undefined, IDX)).toBeUndefined();
  });

  it("mints a provisional place for an unregistered real venue", () => {
    const p = resolvePlace("Wild State Cider", IDX);
    expect(p).toEqual({ id: "~wild-state-cider", name: "Wild State Cider", provisional: true });
  });

  it("gives a provisional place a stable id across calls and across spelling variants", () => {
    expect(resolvePlace("Wild State Cider", IDX)?.id).toBe(resolvePlace("wild  state   cider", IDX)?.id);
  });

  it("resolves an away-game venue by its name, not the packed city prefix", () => {
    expect(resolvePlace("Pueblo, CO, Massari Arena", IDX)?.id).toBe("~massari-arena");
  });
});
```

Append to `test/classify.test.ts`:

```ts
describe("finalizeEvent place resolution", () => {
  it("resolves a registered venue and preserves the raw claim", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe" }));
    expect(e.place?.id).toBe("wussows-concert-cafe");
    expect(e.place?.provisional).toBe(false);
    expect(e.venueRaw).toBe("Wussow's Concert Cafe");
  });

  it("leaves place undefined for a sentinel venue", () => {
    expect(finalizeEvent(makeEvent({ venueRaw: "See listing" })).place).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/place-resolve.test.ts test/classify.test.ts`
Expected: FAIL — `resolvePlace` is not exported.

- [ ] **Step 3: Implement `resolvePlace`**

Append to `src/place-resolve.ts`:

```ts
import type { PlaceRef } from "./schema.js";
import { PLACE_INDEX, type PlaceIndex } from "./place-registry.js";

/** kebab slug for a provisional id. Prefixed "~" so provisional ids can never collide with curated ones. */
function provisionalId(key: string): string {
  return `~${key.replace(/\s+/g, "-")}`;
}

/**
 * Resolve a raw venue string to a canonical place.
 *
 * Three outcomes, deliberately distinct:
 *   sentinel      -> undefined     never merges, never gets a feed
 *   registered    -> stable id     public feed URL, id guaranteed not to move
 *   anything else -> provisional   usable for dedupe, no feed, no stability promise
 */
export function resolvePlace(venueRaw: string | undefined, index: PlaceIndex = PLACE_INDEX): PlaceRef | undefined {
  if (!venueRaw || isSentinelVenue(venueRaw)) return undefined;

  const parsed = parseVenueString(venueRaw);
  const key = normalizeVenueKey(parsed.name);
  if (!key) return undefined;

  const hit = index.byNameAlias.get(key) ?? index.byAddressAlias.get(key);
  if (hit) return { id: hit.id, name: hit.name, provisional: false };

  // Also try the FULL raw string: sources like Do Duluth put the whole address in the venue field,
  // and that form is registered as an address alias.
  const fullKey = normalizeVenueKey(venueRaw);
  const fullHit = index.byNameAlias.get(fullKey) ?? index.byAddressAlias.get(fullKey);
  if (fullHit) return { id: fullHit.id, name: fullHit.name, provisional: false };

  return { id: provisionalId(key), name: parsed.name, provisional: true };
}
```

- [ ] **Step 4: Wire into `finalizeEvent`**

In `src/classify.ts`, add the import:

```ts
import { resolvePlace } from "./place-resolve.js";
```

In `finalizeEvent`, after the `const location = resolveLocation(e.location);` line, add:

```ts
  const place = resolvePlace(e.venueRaw ?? e.location.venueName);
```

and add `place,` to the returned object literal.

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — all previous tests still green (95 + new). tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/place-resolve.ts src/classify.ts test/place-resolve.test.ts test/classify.test.ts
git commit -m "Resolve venues to canonical places in finalizeEvent

Three outcomes: sentinel -> undefined (never merges), registered ->
stable id, anything else -> provisional (dedupe only, no feed).

Provisional ids are '~'-prefixed so they can never collide with curated
ones. Dedupe is untouched — zero merge-behaviour change so far."
```

---

### Task 5: Emit place properties

**Files:**
- Modify: `src/emit.ts:73-89` (`buildXProps`)
- Test: `test/emit.test.ts` (append)

**Interfaces:**
- Consumes: `e.place` from Task 4.
- Produces: `X-PLACE-ID`, `X-PLACE-NAME`, `X-PLACE-PROVISIONAL` on emitted VEVENTs.

- [ ] **Step 1: Write the failing test**

Append to `test/emit.test.ts`:

```ts
describe("place properties", () => {
  it("emits place id, name, and provisional flag when resolved", () => {
    const ics = emitFeed([finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe" }))], META);
    expect(ics).toContain("X-PLACE-ID:wussows-concert-cafe");
    expect(ics).toContain("X-PLACE-NAME:Wussow's Concert Cafe");
    expect(ics).toContain("X-PLACE-PROVISIONAL:false");
  });

  it("emits nothing when the venue is a sentinel", () => {
    const ics = emitFeed([finalizeEvent(makeEvent({ venueRaw: "See listing" }))], META);
    expect(ics).not.toContain("X-PLACE-ID");
  });
});
```

`META` is the existing feed-meta fixture in that file; reuse it. If the file builds meta inline, extract it to a `const META` at the top first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit.test.ts`
Expected: FAIL — `X-PLACE-ID` not found.

- [ ] **Step 3: Implement**

In `src/emit.ts`, inside `buildXProps`, immediately before `return x;`:

```ts
  if (e.place) {
    x.push({ key: "X-PLACE-ID", value: e.place.id });
    x.push({ key: "X-PLACE-NAME", value: e.place.name });
    x.push({ key: "X-PLACE-PROVISIONAL", value: String(e.place.provisional) });
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/emit.ts test/emit.test.ts
git commit -m "Emit X-PLACE-ID, X-PLACE-NAME, X-PLACE-PROVISIONAL

Phase 1 is now observable end-to-end: run the pipeline and measure
resolution quality against real data with zero merge-behaviour change."
```

---

### Task 6: Migrate `LocationSchema` → `AddressSchema` (the breaking window)

**Files:**
- Modify: `src/schema.ts` (`LocationSchema` → alias of `AddressSchema`)
- Modify: `src/adapters/ical-import.ts:106,109,116-121`
- Modify: `src/adapters/jsonld.ts:30-40,87`
- Modify: `src/adapters/structured-api.ts:85,93,99` · `:175,179,186-192` · `:246,250,256-262`
- Modify: `src/adapters/rec1.ts:80,91,98`
- Modify: `src/classify.ts` — **delete** `resolveLocation`; update `finalizeEvent`
- Modify: `src/facets.ts:305` (venue derivation), `src/emit.ts:44` (`formatLocation`), `src/dedupe.ts:20`
- Modify: `test/factory.ts:10`, `test/classify.test.ts:63-100`, `test/rec1.test.ts:40`, `test/jsonld.test.ts:37`, `test/structured-api.test.ts:45,87`

**Interfaces:**
- Consumes: `parseVenueString` (Task 2), `resolvePlace` (Task 4).
- Produces: `LocationSchema` no longer has `venueName`/`room`. Every adapter sets `venueRaw` + a pure `location` address.

This is the only task where the tree is briefly red. Do it in one commit.

- [ ] **Step 1: Update the failing tests first**

In `test/classify.test.ts`, **delete the whole `describe("resolveLocation", …)` block (lines ~63–79)** and replace it with the equivalent coverage through `finalizeEvent` — the away-games behaviour must still be proven:

```ts
describe("away-game location (formerly resolveLocation)", () => {
  it("puts an out-of-state game outside Duluth proper", () => {
    const e = finalizeEvent(
      makeEvent({
        title: "University of Minnesota Duluth Volleyball at Colorado State University Pueblo",
        categories: ["Athletics", "Sports and Recreation"],
        venueRaw: "Pueblo, CO, Massari Arena",
        location: { city: "Duluth", state: "MN" },
      }),
    );
    expect(e.eventType).toBe("sports");
    expect(e.location.city).toBe("Pueblo");
    expect(e.location.state).toBe("CO");
    expect(e.location.inDuluth).toBe(false);
    expect(e.facets.geoScope).toBe("distant");
    expect(e.facets.homeAway).toBe("away");
    expect(e.place?.name).toBe("Massari Arena");
  });

  it("handles AP-style abbreviations", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "St. Cloud, Minn., Herb Brooks National Hockey Center", location: { city: "Duluth", state: "MN" } }));
    expect(e.location.city).toBe("St. Cloud");
    expect(e.location.state).toBe("MN");
  });

  it("leaves an ordinary venue's stated address alone", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "Lake Superior Estuarium", location: { city: "Superior", state: "WI", inDuluth: false } }));
    expect(e.location.city).toBe("Superior");
    expect(e.place?.id).toBe("lake-superior-estuarium");
  });
});
```

Also update `test/classify.test.ts:97` (the existing away-game `finalizeEvent` test) to use `venueRaw` instead of `location.venueName`, and drop the `resolveLocation` import.

In `test/factory.ts`, change line 10 from `location: { venueName: "Pizza Lucé" },` to:

```ts
    location: { city: "Duluth", state: "MN" },
    venueRaw: "Pizza Lucé",
```

In `test/rec1.test.ts:40` change to `expect(e.venueRaw).toBe("Munger Landing");`
In `test/jsonld.test.ts:37` change to:

```ts
    expect(e!.venueRaw).toBe("Flame Nightclub Duluth");
    expect(e!.location).toMatchObject({ street: "1 W Superior St", city: "Duluth" });
```

In `test/structured-api.test.ts:45` change to `expect(e!.venueRaw).toBe("Council Chambers");`
In `test/structured-api.test.ts:87` change to:

```ts
    expect(e!.venueRaw).toBe("Vista Fleet");
    expect(e!.location).toMatchObject({ street: "323 Harbor Dr" });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run`
Expected: FAIL — many tests, `venueRaw` not populated by adapters.

- [ ] **Step 3: Narrow the schema**

In `src/schema.ts`, replace the `LocationSchema` definition with an alias, keeping the export name so nothing else has to change:

```ts
/**
 * Where the event happens, geographically. The venue's NAME lives on `place` (see PlaceRefSchema) —
 * keeping them separate is what stopped `venueName` carrying strings like
 * "Bismarck, ND, MDU Resources Community Bowl".
 */
export const LocationSchema = AddressSchema;
```

Delete the old object literal, including `venueName` and `room`. Move `AddressSchema`/`GeoSchema` above this point if needed so declaration order is valid.

- [ ] **Step 4: Update the six adapter call sites**

`src/adapters/ical-import.ts` — replace lines 116–121 with a parsed address, and add `venueRaw`:

```ts
      venueRaw: venueName,
      location: (() => {
        const { city, state } = parseVenueString(venueName);
        return { city: city ?? "Duluth", state: state ?? "MN", inDuluth: isInDuluth(comp.location) && !city };
      })(),
```

Add `import { parseVenueString } from "../place-resolve.js";` at the top. Leave line 106 and the `makeUid` call on 109 unchanged — UIDs must not move.

`src/adapters/jsonld.ts` — change `mapLocation` to return an address only, and return the name separately:

```ts
function mapLocation(loc: unknown): { venueRaw: string; location: DuluthEvent["location"] } {
  const o = loc && typeof loc === "object" ? (loc as Record<string, unknown>) : {};
  const addr = o.address && typeof o.address === "object" ? (o.address as Record<string, unknown>) : {};
  const city = str(addr.addressLocality) ?? "Duluth";
  return {
    venueRaw: str(o.name) ?? "See listing",
    location: {
      street: str(addr.streetAddress),
      city,
      state: str(addr.addressRegion) ?? "MN",
      inDuluth: !/\bsuperior\b/i.test(city),
    },
  };
}
```

Update its call site: where the result was spread into `location:`, now destructure and set both `venueRaw` and `location`. At line 87 the `makeUid` call takes `loc.venueName` — change to `loc.venueRaw`.

`src/adapters/structured-api.ts` — three sites:

- line 99: `venueRaw: venueName, location: { city: "Duluth", state: "MN", inDuluth: true },`
- lines 186–192: `venueRaw: venueName,` plus `location: { street: venue?.address?.trim() || undefined, city: venue?.city?.trim() || "Duluth", state: "MN", inDuluth: !/\bsuperior\b/i.test(venue?.city ?? "") },`
- lines 256–262: `venueRaw: venueName,` plus `location: { street: loc.addressLine1?.trim() || undefined, city: superior ? "Superior" : "Duluth", state: superior ? "WI" : "MN", geo, inDuluth: !superior },`

Leave all three `makeUid` calls unchanged.

`src/adapters/rec1.ts:98`:

```ts
    venueRaw: venueName,
    location: { city: "Duluth", state: "MN", inDuluth: !/\bsuperior\b/i.test(venueName) },
```

- [ ] **Step 5: Delete `resolveLocation` and update its consumers**

In `src/classify.ts`:

- Delete the entire `resolveLocation` function and its TSDoc block (lines ~160–176).
- Remove `extractLeadingCity` from the `./facets.js` import if now unused.
- In `finalizeEvent`, replace the location/place lines with:

```ts
  const parsed = parseVenueString(e.venueRaw ?? "");
  const location: DuluthEvent["location"] = {
    ...e.location,
    ...(parsed.city ? { city: parsed.city, state: parsed.state ?? e.location.state, inDuluth: /^duluth$/i.test(parsed.city) } : {}),
  };
  const place = resolvePlace(e.venueRaw);
  const eventType = e.eventType !== "other" ? e.eventType : classifyEventType(e.title, e.categories, "community", place?.name ?? e.venueRaw ?? "");
```

Add `import { parseVenueString, resolvePlace } from "./place-resolve.js";`

In `src/facets.ts:305`, replace the venue line with:

```ts
  const venue = cleanText([e.place?.name, e.venueRaw, e.location.city].filter(Boolean).join(", "));
```

In `src/emit.ts:44`, `formatLocation` now takes the event rather than just the location:

```ts
function formatLocation(e: DuluthEvent): string {
  const loc = e.location;
  const cityLine = `${loc.city}, ${loc.state}${loc.zip ? ` ${loc.zip}` : ""}`;
  return [e.place?.name ?? e.venueRaw, e.place?.room, loc.street, cityLine].filter(Boolean).join(", ");
}
```

Update its single call site in `emitFeed` from `formatLocation(e.location)` to `formatLocation(e)`.

In `src/dedupe.ts:20`, the venue component of `fuzzyKey` becomes:

```ts
  const venue = normalizeVenueKey(e.place?.name ?? e.venueRaw ?? "").replace(/\s+/g, "").slice(0, 12);
```

Add `import { normalizeVenueKey } from "./place-resolve.js";`

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc exit 0. If the away-game tests fail, the bug is in the `finalizeEvent` city override, not the adapters.

- [ ] **Step 7: Zod review (mandatory)**

Dispatch `agent-zod-zealot` on the `src/schema.ts` diff.

- [ ] **Step 8: Commit**

```bash
git add src/schema.ts src/classify.ts src/facets.ts src/emit.ts src/dedupe.ts \
        src/adapters/ical-import.ts src/adapters/jsonld.ts src/adapters/structured-api.ts src/adapters/rec1.ts \
        test/factory.ts test/classify.test.ts test/rec1.test.ts test/jsonld.test.ts test/structured-api.test.ts
git commit -m "Split location into address + place across all adapters

LocationSchema is now AddressSchema: no venueName, no room. Every
adapter sets venueRaw (the source's literal claim) plus a pure address.

resolveLocation is DELETED, not extended — it only existed because
venueName carried address data. The 59-away-games behaviour it fixed is
now proven through finalizeEvent instead.

No UID churn: all makeUid calls are untouched, and all 461 live UIDs are
native source ids anyway."
```

---

### Task 7: Verify Phase 1 changed nothing

**Files:**
- Create: `scripts/verify-phase1.mjs`

**Interfaces:**
- Consumes: a built feed.
- Produces: a console report. No source changes.

The whole point of Phase 1 is that it is observable and reversible. Prove it.

- [ ] **Step 1: Write the verifier**

Create `scripts/verify-phase1.mjs`:

```js
/**
 * Phase-1 gate: resolution is now emitted, but merge behaviour must be UNCHANGED.
 * Compares a freshly built feed against a baseline captured before Phase 1.
 * Usage: node scripts/verify-phase1.mjs <baseline.ics> <new.ics>
 */
import { readFileSync } from "node:fs";

const parse = (f) => {
  const lines = readFileSync(f, "utf8").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const evs = [];
  let cur = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") { cur = {}; continue; }
    if (l === "END:VEVENT") { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = l.indexOf(":");
    if (i < 0) continue;
    const k = l.slice(0, i).split(";")[0];
    if (cur[k] === undefined) cur[k] = l.slice(i + 1);
  }
  return evs;
};

const [a, b] = [parse(process.argv[2]), parse(process.argv[3])];
const uidsA = new Set(a.map((e) => e.UID));
const uidsB = new Set(b.map((e) => e.UID));
const lost = [...uidsA].filter((u) => !uidsB.has(u));
const gained = [...uidsB].filter((u) => !uidsA.has(u));

console.log(`baseline ${a.length} events | new ${b.length} events`);
console.log(`UIDs lost:   ${lost.length}`);
console.log(`UIDs gained: ${gained.length}`);

const resolved = b.filter((e) => e["X-PLACE-ID"]);
const registered = resolved.filter((e) => e["X-PLACE-PROVISIONAL"] === "false");
console.log(`\nresolution: ${resolved.length}/${b.length} have a place (${registered.length} registered, ${resolved.length - registered.length} provisional)`);

if (lost.length || gained.length) {
  console.error("\nFAIL: Phase 1 must not change which events exist.");
  for (const u of [...lost.slice(0, 10)]) console.error(`  LOST   ${u}`);
  for (const u of [...gained.slice(0, 10)]) console.error(`  GAINED ${u}`);
  process.exit(1);
}
console.log("\nPASS: event set unchanged.");
```

- [ ] **Step 2: Capture a baseline and compare**

```bash
git stash list >/dev/null   # ensure clean tree
curl -sS https://lampagj.github.io/duluth-events/feeds/all.ics -o /tmp/baseline.ics
npx tsx src/cli.ts /tmp/phase1.ics
node scripts/verify-phase1.mjs /tmp/baseline.ics /tmp/phase1.ics
```

Expected: `PASS: event set unchanged.` A non-zero lost/gained count means a real regression — stop and fix before Phase 2.

Note: the live baseline is a few days old, so a handful of naturally-expired events may show as `lost`. Inspect them; only unexplained losses are failures. If drift makes this noisy, regenerate the baseline from `main` instead: `git stash && git checkout main && npx tsx src/cli.ts /tmp/baseline.ics && git checkout - && git stash pop`.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-phase1.mjs
git commit -m "Phase-1 gate: prove resolution changed no event's existence"
```

---

## Phase 2 — Seed the registry

---

### Task 8: Overpass fetch and the proposer

**Files:**
- Create: `scripts/fetch-osm.mjs`, `scripts/places-propose.mjs`
- Modify: `package.json` (scripts), `.gitignore`
- Create: `data/osm-duluth.json` (committed cache)

**Interfaces:**
- Consumes: `normalizeVenueKey`, `isSentinelVenue`, `parseVenueString` from `src/place-resolve.ts` (imported via `tsx`).
- Produces: `reports/places-proposal.md` — paste-ready `Place` literals. **Never writes `src/places.ts`.**

- [ ] **Step 1: Write the Overpass fetcher**

Create `scripts/fetch-osm.mjs`:

```js
/**
 * Bulk-fetch named Duluth-area venues from OpenStreetMap into a COMMITTED cache, so seeding is
 * reproducible offline and does not re-hit the API. Re-run only when refreshing the cache.
 * Usage: node scripts/fetch-osm.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const QUERY = `[out:json][timeout:90];
(
  nwr["name"]["amenity"~"^(bar|pub|cafe|theatre|arts_centre|community_centre|library|nightclub|events_venue|restaurant|casino|college|university|place_of_worship)$"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["tourism"~"^(museum|attraction|gallery|hotel)$"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["leisure"~"^(park|sports_centre|stadium|ice_rink|marina|nature_reserve)$"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["craft"="brewery"](46.60,-92.35,46.90,-91.95);
  nwr["name"]["microbrewery"="yes"](46.60,-92.35,46.90,-91.95);
);
out center tags;`;

// overpass-api.de 504s under load; kumi is the reliable mirror.
const MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

let data = null;
for (const m of MIRRORS) {
  try {
    console.log(`trying ${m}`);
    const res = await fetch(m, { method: "POST", body: QUERY, headers: { "Content-Type": "text/plain" } });
    if (!res.ok) { console.log(`  HTTP ${res.status}`); continue; }
    data = await res.json();
    break;
  } catch (err) {
    console.log(`  ${String(err).slice(0, 80)}`);
  }
}
if (!data) { console.error("all mirrors failed"); process.exit(1); }

mkdirSync("data", { recursive: true });
const places = data.elements
  .filter((e) => e.tags?.name)
  .map((e) => {
    const c = e.center ?? e;
    const t = e.tags;
    return {
      name: t.name,
      street: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || null,
      city: t["addr:city"] ?? null,
      state: t["addr:state"] ?? null,
      zip: t["addr:postcode"] ?? null,
      lat: c.lat ?? null,
      lon: c.lon ?? null,
      ref: `${e.type}/${e.id}`,
    };
  });
writeFileSync("data/osm-duluth.json", JSON.stringify(places, null, 2));
console.log(`wrote data/osm-duluth.json — ${places.length} venues, ${places.filter((p) => p.street).length} with street addresses`);
```

- [ ] **Step 2: Write the proposer**

Create `scripts/places-propose.mjs`:

```js
/**
 * Propose registry entries for unresolved venue strings. PRINTS ONLY — never writes src/places.ts.
 * The human paste is the id-stability guarantee.
 *
 * Usage: npx tsx scripts/places-propose.mjs <feed.ics>
 *
 * Ordering matters and each step fixes a measured probe defect:
 *   unescape ICS -> decode entities -> strip room suffixes -> query with the CORRECT city.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";
import { normalizeVenueKey, isSentinelVenue, parseVenueString, resolvePlace } from "../src/place-resolve.ts";

const ICS = process.argv[2] ?? "duluth-events.ics";
const UA = "duluth-events/0.1 (github.com/LampaGJ/duluth-events)";

// --- collect unresolved venue strings with counts and their stated city ---
const lines = readFileSync(ICS, "utf8").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
const evs = [];
let cur = null;
for (const l of lines) {
  if (l === "BEGIN:VEVENT") { cur = {}; continue; }
  if (l === "END:VEVENT") { if (cur) evs.push(cur); cur = null; continue; }
  if (!cur) continue;
  const i = l.indexOf(":");
  if (i < 0) continue;
  const k = l.slice(0, i).split(";")[0];
  if (cur[k] === undefined) cur[k] = l.slice(i + 1);
}

const wanted = new Map(); // normalized key -> { raw, city, state, n }
for (const e of evs) {
  const raw = e["X-PLACE-NAME"] ?? (e.LOCATION ?? "").split(",")[0];
  if (!raw || isSentinelVenue(raw)) continue;
  if (e["X-PLACE-PROVISIONAL"] === "false") continue; // already registered
  const parsed = parseVenueString(raw);
  const key = normalizeVenueKey(parsed.name);
  if (!key) continue;
  const loc = (e.LOCATION ?? "").replace(/\\,/g, ",");
  const m = loc.match(/,\s*([A-Za-z .'-]+),\s*([A-Z]{2})\b/); // ALL states, not just MN|WI
  const prev = wanted.get(key);
  wanted.set(key, {
    raw: parsed.name,
    city: parsed.city ?? prev?.city ?? m?.[1]?.trim() ?? "Duluth",
    state: parsed.state ?? prev?.state ?? m?.[2] ?? "MN",
    n: (prev?.n ?? 0) + 1,
  });
}
const targets = [...wanted.values()].sort((a, b) => b.n - a.n);
console.log(`${targets.length} unresolved venue strings`);

// --- tier 1: the committed OSM cache ---
const osm = existsSync("data/osm-duluth.json") ? JSON.parse(readFileSync("data/osm-duluth.json", "utf8")) : [];
const STOP = new Set(["the", "and", "of", "at", "inc", "llc", "co"]);
const tk = (s) => new Set(normalizeVenueKey(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
/** Does `short` look like an acronym of `long`? DECC -> Duluth Entertainment Convention Center. */
const isAcronym = (short, long) => {
  const s = short.replace(/[^a-z]/gi, "").toLowerCase();
  if (s.length < 2 || s.length > 6) return false;
  const initials = long.split(/\s+/).filter(Boolean).map((w) => w[0]?.toLowerCase() ?? "").join("");
  return initials.includes(s);
};
const osmIdx = osm.map((o) => ({ o, t: tk(o.name) }));

const p = progress("places-propose", { total: targets.length, everyN: 5 });
const rows = [];
let done = 0;

for (const t of targets) {
  let best = null, score = 0, src = null;
  for (const x of osmIdx) {
    const s = jac(tk(t.raw), x.t);
    if (s > score) { score = s; best = x.o; src = "osm"; }
  }
  // tier 2: Nominatim, only when OSM was unconvincing
  if (score < 0.5) {
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("q", `${t.raw}, ${t.city}, ${t.state}`);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("addressdetails", "1");
      const j = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
      if (j.length) {
        const r = j[0], a = r.address ?? {};
        const name = r.name || String(r.display_name).split(",")[0];
        const s = Math.max(jac(tk(t.raw), tk(name)), isAcronym(t.raw, name) ? 0.9 : 0);
        if (s > score) {
          score = s; src = "web";
          best = {
            name, street: [a.house_number, a.road].filter(Boolean).join(" ") || null,
            city: a.city ?? a.town ?? a.village ?? null, state: a.state ?? null, zip: a.postcode ?? null,
            lat: +r.lat, lon: +r.lon, ref: `${r.osm_type}/${r.osm_id}`,
          };
        }
      }
      await new Promise((r) => setTimeout(r, 1150)); // Nominatim policy: <= 1 req/s
    } catch { /* leave whatever OSM gave */ }
  }
  rows.push({ ...t, best, score: +score.toFixed(2), src });
  p.tick(++done);
}
p.done({ total: rows.length });

// --- emit paste-ready literals, ranked, with the verdict a human must check ---
const slug = (s) => normalizeVenueKey(s).replace(/\s+/g, "-").slice(0, 48);
const verdict = (r) => (!r.best ? "NO MATCH — research by hand" : r.score >= 0.5 ? "LIKELY" : "WEAK — verify or reject");

let out = `# Place proposals\n\n`;
out += `${rows.length} unresolved strings. **Verify every entry before pasting.** A geocoder's\n`;
out += `confident wrong answer looks exactly like data: "Restaurant 301" resolved to "Perkins",\n`;
out += `"Sioux Falls" to "South Duluth Avenue". Nothing here is auto-accepted.\n\n`;
for (const r of rows) {
  out += `## ${r.raw}  (${r.n} event${r.n === 1 ? "" : "s"}) — ${verdict(r)}${r.best ? `, sim=${r.score}` : ""}\n\n`;
  out += "```ts\n{\n";
  out += `  id: ${JSON.stringify(slug(r.best?.name ?? r.raw))},\n`;
  out += `  name: ${JSON.stringify(r.best?.name ?? r.raw)},\n`;
  out += `  nameAliases: ${JSON.stringify([r.raw])},\n`;
  out += `  addressAliases: ${JSON.stringify(r.best?.street ? [r.best.street] : [])},\n`;
  const city = r.best?.city ?? r.city, state = r.best?.state ?? r.state;
  out += `  address: { ${r.best?.street ? `street: ${JSON.stringify(r.best.street)}, ` : ""}city: ${JSON.stringify(city)}, state: ${JSON.stringify(state)}`;
  if (r.best?.lat) out += `, geo: { lat: ${r.best.lat}, lon: ${r.best.lon} }`;
  out += `, inDuluth: ${/^duluth$/i.test(city)} },\n`;
  out += `  provenance: { source: ${JSON.stringify(r.src ?? "manual")}${r.best?.ref ? `, ref: ${JSON.stringify(r.best.ref)}` : ""} },\n`;
  out += "},\n```\n\n";
}
mkdirSync("reports", { recursive: true });
writeFileSync("reports/places-proposal.md", out);
console.log(`\nwrote reports/places-proposal.md`);
console.log(`  LIKELY:   ${rows.filter((r) => r.best && r.score >= 0.5).length}`);
console.log(`  WEAK:     ${rows.filter((r) => r.best && r.score < 0.5).length}`);
console.log(`  NO MATCH: ${rows.filter((r) => !r.best).length}`);
console.log(`\nreports/places-proposal.md is NOT the registry. Review, then paste into src/places.ts.`);
```

- [ ] **Step 3: Wire up npm scripts**

In `package.json` `scripts`, add:

```json
    "places:osm": "node scripts/fetch-osm.mjs",
    "places:propose": "tsx scripts/places-propose.mjs"
```

- [ ] **Step 4: Run both and sanity-check**

```bash
npm run places:osm
npx tsx src/cli.ts /tmp/current.ics
npm run places:propose /tmp/current.ics
head -60 reports/places-proposal.md
```

Expected: `data/osm-duluth.json` written with ~369 venues; a proposal file with LIKELY/WEAK/NO MATCH counts. Confirm `DECC` is scored via the acronym path (sim 0.9), not 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-osm.mjs scripts/places-propose.mjs package.json data/osm-duluth.json
git commit -m "Overpass cache + place proposer

Proposer PRINTS proposals; it never writes src/places.ts. Normalizes
before querying (unescape ICS, decode entities, strip room suffixes,
correct city) — the three defects measured in the probe.

Adds an acronym path so DECC -> Duluth Entertainment Convention Center
scores 0.9 rather than 0 on token overlap. No score auto-accepts."
```

---

### Task 9: Seed the registry (human review gate)

**Files:**
- Modify: `src/places.ts`

**Interfaces:**
- Consumes: `reports/places-proposal.md` from Task 8.
- Produces: a populated `PLACES` array.

**This task requires human judgment and cannot be delegated to a subagent.**

- [ ] **Step 1: Review the proposal file**

Read `reports/places-proposal.md` top to bottom. For each entry:
- **LIKELY** — confirm the name and address are actually this venue. Watch for a plausible-but-wrong nearby business.
- **WEAK** — verify by hand or reject. Most rejections are away-game venues and non-places.
- **NO MATCH** — research individually (tier 3), or accept it staying provisional.

Reject outright, leaving them provisional forever: virtual pseudo-venues (`Zoom`, `Virtual via Zoom - register at…`), cities used as venues (`Sioux Falls`, `Romeoville`), and rooms (`Council Chambers` belongs in a City Hall entry's `rooms`, not as its own place).

- [ ] **Step 2: Paste confirmed entries into `src/places.ts`**

Keep the three seed entries. Append confirmed literals. Set `provenance.source` honestly: `"osm"` when taken from the cache or Nominatim unedited, `"web"` when researched, `"manual"` when typed or corrected by hand.

- [ ] **Step 3: Verify the registry loads**

Run: `npx vitest run test/place-registry.test.ts && npx tsc --noEmit`
Expected: PASS. A duplicate id or colliding alias throws with the offending ids named — fix and re-run.

- [ ] **Step 4: Measure the coverage gain**

```bash
npx tsx src/cli.ts /tmp/seeded.ics
grep -c "X-PLACE-PROVISIONAL:false" /tmp/seeded.ics
grep -c "X-PLACE-PROVISIONAL:true" /tmp/seeded.ics
```

Record both numbers in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/places.ts
git commit -m "Seed the place registry

<N> venues registered, covering <M> of <T> events. Rejected as
non-places: virtual pseudo-venues, cities used as venues, and rooms.
Away-game venues left provisional — they need no feed."
```

---

## Phase 3 — Place-first dedupe (the risk concentrates here)

---

### Task 10: Two-pass dedupe

**Files:**
- Modify: `src/dedupe.ts`
- Test: `test/place-dedupe.test.ts` (create)

**Interfaces:**
- Consumes: `e.place`, `e.start`, `e.source.name`.
- Produces: `dedupe(events: DuluthEvent[]): DuluthEvent[]` — same signature, new behaviour.

- [ ] **Step 1: Write the failing test**

Create `test/place-dedupe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dedupe } from "../src/dedupe.js";
import { finalizeEvent } from "../src/classify.js";
import { makeEvent } from "./factory.js";

const at = (over: Record<string, unknown>) =>
  finalizeEvent(makeEvent({ start: "2026-08-10T18:00:00-05:00", end: "2026-08-10T21:00:00-05:00", ...over }));

const src = (name: string) => ({
  name, type: "ics-feed" as const, extractionMethod: "ics-import" as const,
  retrievedAt: "2026-07-28T09:00:00-05:00", confidence: "high" as const,
});

describe("place-first dedupe", () => {
  it("merges the same instant + same place across different sources", () => {
    // Verbatim corpus pair — different titles, different venue spellings, one event.
    const a = at({ uid: "a", title: "High Key Mondays &#038; Industry Nights", venueRaw: "Bent Paddle Brewing", source: src("Visit Duluth") });
    const b = at({ uid: "b", title: "HighKey Mondays + Industry Night!", venueRaw: "Bent Paddle Taproom 1832 W Michigan St.", source: src("Do Duluth") });
    const merged = dedupe([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.alsoListedIn.map((s) => s.name)).toEqual(["Do Duluth"]);
  });

  it("NEVER merges two sentinel-venue events at the same instant", () => {
    // The false-merge case that would DELETE an event. Both venues are sentinels.
    const a = at({ uid: "a", title: "Fall Volunteer and Engagement Fair", venueRaw: "Sign in to download the location", source: src("UMD Events") });
    const b = at({ uid: "b", title: "Two Harbors Fall Colors Tour", venueRaw: "See listing", source: src("North Shore Scenic Railroad") });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("never merges two events from the SAME source", () => {
    const a = at({ uid: "a", title: "Show A", venueRaw: "Wussow's Concert Cafe", source: src("Do Duluth") });
    const b = at({ uid: "b", title: "Show B", venueRaw: "Wussow's Concert Cafe", source: src("Do Duluth") });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("refuses to merge when both sides state a DIFFERENT room", () => {
    const a = at({ uid: "a", title: "A", venueRaw: "Wussow's Concert Cafe", place: { id: "wussows-concert-cafe", name: "W", room: "Main" }, source: src("X") });
    const b = at({ uid: "b", title: "B", venueRaw: "Wussow's Concert Cafe", place: { id: "wussows-concert-cafe", name: "W", room: "Back" }, source: src("Y") });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("merges provisional places too — dedupe does not require registration", () => {
    const a = at({ uid: "a", title: "A", venueRaw: "Wild State Cider", source: src("X") });
    const b = at({ uid: "b", title: "A", venueRaw: "Wild State Cider", source: src("Y") });
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it("VETOES a merge when titles are near-disjoint — the high-capacity-venue guard", () => {
    // Four unrelated events from four sources at one venue and instant. Real at DECC / AMSOIL /
    // a UMD building. `room` would discriminate but is populated on 0/461 events, so the title
    // veto is the only guard. A false merge here would DELETE three events.
    const evs = ["Symphony Rehearsal", "Craft Vendor Expo", "Job Fair Northland", "Roller Derby Bout"].map((t, i) =>
      at({ uid: `u${i}`, title: t, venueRaw: "Wussow's Concert Cafe", source: src(`Source ${i}`) }),
    );
    expect(dedupe(evs)).toHaveLength(4);
  });

  it("still merges every confirmed duplicate pair — the veto must not become a selector", () => {
    // Lowest-scoring confirmed pair in the corpus (0.25 after normalization). A 0.5 selector
    // would reject this; the 0.15 veto passes it.
    const a = at({ uid: "a", title: "High Key Mondays &#038; Industry Nights", venueRaw: "Bent Paddle Brewing", source: src("Visit Duluth") });
    const b = at({ uid: "b", title: "HighKey Mondays + Industry Night!", venueRaw: "Bent Paddle Brewing", source: src("Do Duluth") });
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it("does not merge the same place at DIFFERENT instants", () => {
    const a = at({ uid: "a", title: "A", venueRaw: "Wussow's Concert Cafe", source: src("X") });
    const b = at({ uid: "b", title: "A", start: "2026-08-11T18:00:00-05:00", venueRaw: "Wussow's Concert Cafe", source: src("Y") });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it("still merges via the title fallback when neither event has a place", () => {
    const a = at({ uid: "a", title: "Identical Title Here", venueRaw: "See listing", source: src("X") });
    const b = at({ uid: "b", title: "Identical Title Here", venueRaw: "See listing", source: src("Y") });
    // Sentinels give no place, so pass 1 skips them; pass 2's title key still applies.
    expect(dedupe([a, b])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/place-dedupe.test.ts`
Expected: FAIL — the place-pair test returns 2, not 1.

- [ ] **Step 3: Implement two-pass dedupe**

Replace the body of `dedupe` in `src/dedupe.ts`:

```ts
/**
 * Token-set Jaccard over normalized titles. Used ONLY as a veto (see TITLE_VETO) — never to select
 * merges, because a selector at any meaningful threshold rejects real duplicates: 4 of the 8
 * confirmed corpus pairs score below 0.5.
 */
const TITLE_STOP = new Set(["the", "and", "for", "with", "live", "music", "night", "nights", "duluth"]);
export function titleSimilarity(a: string, b: string): number {
  const tk = (s: string) => new Set(normalizeVenueKey(s).split(" ").filter((w) => w.length > 2 && !TITLE_STOP.has(w)));
  const [x, y] = [tk(a), tk(b)];
  if (!x.size || !y.size) return 1; // no signal either way — do not veto on emptiness
  let hits = 0;
  for (const t of x) if (y.has(t)) hits++;
  return hits / (x.size + y.size - hits);
}

/** Below this, two events at one place and instant are treated as genuinely different. */
const TITLE_VETO = 0.15;

/** Merge one group into a primary + corroborators. Highest confidence wins; ties keep first-seen order. */
function mergeGroup(group: DuluthEvent[]): DuluthEvent {
  const sorted = [...group].sort((a, b) => CONFIDENCE_RANK[b.source.confidence] - CONFIDENCE_RANK[a.source.confidence]);
  const primary = sorted[0]!;
  const seen = new Set([primary.source.name]);
  const corroborators: Source[] = [];
  for (const s of [...primary.alsoListedIn, ...sorted.slice(1).flatMap((e) => [e.source, ...e.alsoListedIn])]) {
    if (!seen.has(s.name)) { seen.add(s.name); corroborators.push(s); }
  }
  return { ...primary, alsoListedIn: corroborators };
}

/**
 * Merge duplicates across sources. Two passes, so nothing that works today regresses:
 *
 *   1. PLACE pass — same start instant + same resolved place id. Skipped entirely when place is
 *      absent (a sentinel venue must never merge: two events both reading "See listing" at the same
 *      instant are demonstrably different, and merging them DELETES one). Cross-source only.
 *      Refuses when both sides state a DIFFERENT room.
 *   2. TITLE fallback — the original fuzzy key, applied only to what pass 1 left alone.
 *
 * A false merge is worse than a missed merge, which is why every condition here is a refusal.
 */
export function dedupe(events: DuluthEvent[]): DuluthEvent[] {
  // --- pass 1: place identity ---
  const placeGroups = new Map<string, DuluthEvent[]>();
  const unplaced: DuluthEvent[] = [];
  for (const e of events) {
    if (!e.place) { unplaced.push(e); continue; }
    const key = `${e.start}|${e.place.id}`;
    const arr = placeGroups.get(key);
    if (arr) arr.push(e);
    else placeGroups.set(key, [e]);
  }

  const afterPlace: DuluthEvent[] = [...unplaced];
  for (const group of placeGroups.values()) {
    if (group.length === 1) { afterPlace.push(group[0]!); continue; }
    // Split by source: only cross-source copies may merge, and a stated differing room blocks it.
    const bySource = new Map<string, DuluthEvent[]>();
    for (const e of group) {
      const room = e.place?.room ?? "";
      const k = `${e.source.name}|${room}`;
      const arr = bySource.get(k);
      if (arr) arr.push(e);
      else bySource.set(k, [e]);
    }
    const rooms = new Set(group.map((e) => e.place?.room ?? ""));
    const roomsConflict = rooms.size > 1 && !rooms.has("");
    if (roomsConflict) { afterPlace.push(...group); continue; }

    const reps = [...bySource.values()].map((g) => (g.length === 1 ? g[0]! : mergeGroup(g)));
    // High-capacity-venue veto: a big venue can host genuinely different events at one instant, and
    // `room` (the intended discriminator) is populated on 0/461 events. Refuse when any pair of
    // titles is near-disjoint. This is a VETO, not a selector — every confirmed duplicate scores
    // >= 0.25, unrelated events score ~0, so the bar sits at 0.15.
    const disjoint = reps.some((x, i) => reps.slice(i + 1).some((y) => titleSimilarity(x.title, y.title) < TITLE_VETO));
    if (disjoint) { afterPlace.push(...reps); continue; }

    afterPlace.push(reps.length === 1 ? reps[0]! : mergeGroup(reps));
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
```

Note: pass 1 groups same-source copies under a distinct key so they are never collapsed against each other, then merges the cross-source representatives.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — including the existing `test/dedupe.test.ts`. tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/dedupe.ts test/place-dedupe.test.ts
git commit -m "Two-pass dedupe: place identity, then title fallback

Pass 1 keys on start-instant + resolved place id, cross-source only,
skipped when place is absent, refused when rooms differ. Pass 2 keeps
the existing title key for whatever pass 1 left alone, so today's
corroborations do not regress.

Sentinel venues resolve to no place and therefore never merge — the
regression case is UMD 'Fall Volunteer and Engagement Fair' vs NSSR
'Two Harbors Fall Colors Tour', same instant, both sentinel venues."
```

---

### Task 11: The merge-diff gate

**Files:**
- Create: `scripts/merge-diff.mjs`
- Modify: `package.json`
- Test: `test/place-dedupe.test.ts` (append merge-count bound)

**Interfaces:**
- Consumes: a baseline feed and a new feed.
- Produces: a printed merge report; non-zero exit when merges exceed a stated bound.

**This is a hard gate. Phase 3 does not ship until a human reads this output and confirms zero false merges.**

- [ ] **Step 1: Write the merge-count bound test**

Append to `test/place-dedupe.test.ts`:

```ts
it("pins the corroborator count when near-identical listings collapse", () => {
  // Four sources listing the SAME event. Titles overlap, so the veto does not fire and all four
  // collapse to one with three corroborators. Pins the count so a future widening is visible.
  const evs = ["Visit Duluth", "Do Duluth", "Perfect Duluth Day", "Duluth Reader"].map((s, i) =>
    at({ uid: `u${i}`, title: "Buffalo Galaxy Live at the Taproom", venueRaw: "Wussow's Concert Cafe", source: src(s) }),
  );
  const merged = dedupe(evs);
  expect(merged).toHaveLength(1);
  expect(merged[0]!.alsoListedIn).toHaveLength(3);
});
```

- [ ] **Step 2: Write the merge-diff tool**

Create `scripts/merge-diff.mjs`:

```js
/**
 * PHASE-3 HARD GATE. Prints every event that disappeared between two builds and why, so a human can
 * confirm no false merge. A false merge DELETES an event, so this must be read, not skimmed.
 * Usage: node scripts/merge-diff.mjs <baseline.ics> <new.ics> [maxMerges]
 */
import { readFileSync } from "node:fs";

const parse = (f) => {
  const lines = readFileSync(f, "utf8").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const evs = [];
  let cur = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") { cur = {}; continue; }
    if (l === "END:VEVENT") { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = l.indexOf(":");
    if (i < 0) continue;
    const k = l.slice(0, i).split(";")[0];
    if (cur[k] === undefined) cur[k] = l.slice(i + 1);
  }
  return evs;
};

const [a, b] = [parse(process.argv[2]), parse(process.argv[3])];
const maxMerges = Number(process.argv[4] ?? 60);
const byUid = new Map(b.map((e) => [e.UID, e]));
const absorbed = a.filter((e) => !byUid.has(e.UID));

console.log(`baseline ${a.length} -> new ${b.length}  (${absorbed.length} absorbed)\n`);
for (const gone of absorbed) {
  const survivor = b.find((e) => e.DTSTART === gone.DTSTART && e["X-PLACE-ID"] && e["X-PLACE-ID"] === gone["X-PLACE-ID"]);
  console.log(`ABSORBED  "${gone.SUMMARY}"  [${gone["X-SOURCE-NAME"]}]`);
  console.log(`   place: ${gone["X-PLACE-ID"] ?? "(none)"}   start: ${gone.DTSTART}`);
  if (survivor) {
    console.log(`   INTO   "${survivor.SUMMARY}"  [${survivor["X-SOURCE-NAME"]}]`);
    console.log(`   also:  ${survivor["X-ALSO-LISTED-IN"] ?? "(none)"}`);
  } else {
    console.log(`   !! no same-place survivor found — investigate, this may not be a merge at all`);
  }
  console.log();
}

if (absorbed.length > maxMerges) {
  console.error(`FAIL: ${absorbed.length} merges exceeds the bound of ${maxMerges}.`);
  console.error(`Either the registry gained a bad alias, or raise the bound deliberately.`);
  process.exit(1);
}
console.log(`Within bound (${absorbed.length}/${maxMerges}). A human must still confirm every line above.`);
```

- [ ] **Step 3: Add the npm script**

```json
    "merge:diff": "node scripts/merge-diff.mjs"
```

- [ ] **Step 4: Run the gate**

```bash
git stash && git checkout main && npx tsx src/cli.ts /tmp/before.ics && git checkout - && git stash pop
npx tsx src/cli.ts /tmp/after.ics
npm run merge:diff /tmp/before.ics /tmp/after.ics
```

**Read every `ABSORBED` line.** Each must be a genuine duplicate of the event it merged into. A single false merge fails the phase regardless of how many true merges it achieved — if one appears, add the offending venue's variants as distinct places (or remove the bad alias) and re-run.

- [ ] **Step 5: Commit**

```bash
git add scripts/merge-diff.mjs package.json test/place-dedupe.test.ts
git commit -m "Phase-3 hard gate: merge diff + merge-count bound

Prints every absorbed event with the event it merged into, so a false
merge is caught before shipping rather than found later as missing
content. Bounded merge count fails CI if a registry edit suddenly
collapses more than expected."
```

---

## Phase 4 — Feeds and enrichment

---

### Task 12: Enrich event addresses from resolved places

**Files:**
- Modify: `src/classify.ts` (`finalizeEvent`)
- Test: `test/classify.test.ts` (append)

**Interfaces:**
- Consumes: `PLACE_INDEX.byId`.
- Produces: events whose `location` gains `street`/`zip`/`geo` from their resolved place.

- [ ] **Step 1: Write the failing test**

Append to `test/classify.test.ts`:

```ts
describe("address enrichment from a resolved place", () => {
  it("fills missing street and geo from the registry", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe", location: { city: "Duluth", state: "MN" } }));
    expect(e.location.street).toBe("324 North Central Avenue");
    expect(e.location.geo).toEqual({ lat: 46.7386, lon: -92.1662 });
  });

  it("NEVER overwrites what the source stated", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe", location: { street: "999 Source Says This St", city: "Duluth", state: "MN" } }));
    expect(e.location.street).toBe("999 Source Says This St");
  });

  it("does not enrich from a provisional place", () => {
    const e = finalizeEvent(makeEvent({ venueRaw: "Some Unregistered Venue", location: { city: "Duluth", state: "MN" } }));
    expect(e.location.street).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL — `street` is undefined.

- [ ] **Step 3: Implement**

In `src/classify.ts`, add the import `import { PLACE_INDEX } from "./place-registry.js";` and, in `finalizeEvent` after `place` is computed, insert:

```ts
  // Enrichment: fill gaps from the registry, never overwrite what the source stated.
  const canonical = place && !place.provisional ? PLACE_INDEX.byId.get(place.id) : undefined;
  const enriched: DuluthEvent["location"] = canonical
    ? {
        ...location,
        street: location.street ?? canonical.address.street,
        zip: location.zip ?? canonical.address.zip,
        geo: location.geo ?? canonical.address.geo,
      }
    : location;
```

Use `enriched` in place of `location` when constructing `withLoc`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit -m "Enrich event addresses from resolved places

Fills missing street/zip/geo from the registry; a source-stated value
always wins. Provisional places never enrich — they are unverified."
```

---

### Task 13: Place feeds and the "By venue" group

**Files:**
- Modify: `src/feeds-config.ts`, `src/feed.ts`, `src/build.ts`
- Test: `test/feeds-config.test.ts` (append)

**Interfaces:**
- Consumes: `PLACE_INDEX.all`, `filterEvents`.
- Produces: `/feeds/place/<id>.ics` per registered place with ≥1 event; a "By venue" landing-page group.

- [ ] **Step 1: Write the failing test**

Append to `test/feeds-config.test.ts`:

```ts
import { placeSpecs } from "../src/feeds-config.js";
import { PLACE_INDEX } from "../src/place-registry.js";
import { finalizeEvent } from "../src/classify.js";

describe("place feeds", () => {
  it("emits one spec per registered place, under a place/ path", () => {
    const specs = placeSpecs();
    expect(specs.length).toBe(PLACE_INDEX.all.length);
    for (const s of specs) expect(s.file).toMatch(/^place\/[a-z0-9-]+\.ics$/);
  });

  it("filters to exactly that place", () => {
    const spec = placeSpecs().find((s) => s.file === "place/wussows-concert-cafe.ics")!;
    const here = finalizeEvent(makeEvent({ venueRaw: "Wussow's Concert Cafe" }));
    const elsewhere = finalizeEvent(makeEvent({ venueRaw: "Lake Superior Estuarium" }));
    expect(filterEvents([here, elsewhere], spec.filter)).toHaveLength(1);
  });

  it("never emits a feed for a provisional place", () => {
    expect(placeSpecs().every((s) => !s.file.includes("~"))).toBe(true);
  });

  it("keeps filenames unique across the whole catalog including place feeds", () => {
    const files = [...SPECS, ...placeSpecs()].map((s) => s.file);
    expect(files).toEqual([...new Set(files)]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/feeds-config.test.ts`
Expected: FAIL — `placeSpecs` is not exported.

- [ ] **Step 3: Add the `placeId` filter**

In `src/feed.ts`, add `placeId?: string;` to `FeedFilter`, add to `filterEvents`:

```ts
    if (f.placeId !== undefined && e.place?.id !== f.placeId) return false;
```

and in `parseFilter`:

```ts
  const place = String(q.place ?? q.placeId ?? q.placeid ?? "").trim();
  if (place) f.placeId = place;
```

- [ ] **Step 4: Add `placeSpecs()`**

In `src/feeds-config.ts`:

```ts
import { PLACE_INDEX } from "./place-registry.js";

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
```

Add `"By venue"` to the `GROUPS` tuple, before `"Provenance"`.

- [ ] **Step 5: Wire into the build**

In `src/build.ts`:

```ts
import { GROUPS, SPECS, placeSpecs, type Group } from "./feeds-config.js";
```

Replace the spec loop with:

```ts
await mkdir(`${OUT}/feeds/place`, { recursive: true });
const allSpecs = [...SPECS, ...placeSpecs()];
const rows: Row[] = [];
for (const spec of allSpecs) {
  await writeFile(`${OUT}/feeds/${spec.file}`, buildFeed(events, spec.filter), "utf8");
  rows.push({ title: spec.title, desc: spec.desc, count: filterEvents(events, spec.filter).length, file: spec.file, group: spec.group });
}
```

In `renderIndex`, cap the "By venue" group so the page stays scannable — after `shown` is computed:

```ts
  const BY_VENUE_LIMIT = 15;
  const capped = GROUPS.flatMap((g) => {
    const rowsInGroup = shown.filter((r) => r.group === g).sort((a, b) => b.count - a.count);
    return g === "By venue" ? rowsInGroup.slice(0, BY_VENUE_LIMIT) : rowsInGroup;
  });
```

and build `sections` from `capped` instead of `shown`. Add a footer line when venues are truncated:

```ts
  const venueTotal = shown.filter((r) => r.group === "By venue").length;
  const venueNote = venueTotal > BY_VENUE_LIMIT ? `Showing the ${BY_VENUE_LIMIT} busiest of ${venueTotal} venue feeds; all are on disk at <code>/feeds/place/&lt;id&gt;.ics</code>.` : "";
```

Render `venueNote` in the footer, and add the ODbL attribution line required by the spec:

```html
    <p>Venue addresses derived from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © OpenStreetMap contributors, ODbL.</p>
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, tsc exit 0.

- [ ] **Step 7: Build and eyeball the page**

```bash
npx tsx src/build.ts
ls public/feeds/place | head
open public/index.html
```

Expected: a "By venue" section with at most 15 rows; `public/feeds/place/` holding one file per registered place.

- [ ] **Step 8: Commit**

```bash
git add src/feed.ts src/feeds-config.ts src/build.ts test/feeds-config.test.ts
git commit -m "Place feeds and the By venue group

One /feeds/place/<id>.ics per REGISTERED place; provisional places are
excluded by construction since their ids carry no stability promise.
Landing page shows the 15 busiest, all are on disk.

Adds the ODbL attribution OpenStreetMap-derived addresses require."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Data model (Address/Place/PlaceRef) | 1 |
| Two alias namespaces | 3 |
| Migration, `resolveLocation` deleted | 6 |
| Resolution + three-way outcome | 2, 4 |
| Registry validation, fail-fast | 3 |
| Seeding pipeline (Overpass, Nominatim, tier 3) | 8, 9 |
| Acronym + address-form handling | 8 |
| Two-pass dedupe | 10 |
| Feeds + enrichment | 12, 13 |
| Rollout phases 1–4 | Phases 1–4 |
| Testing: unit / regression / invariants / merge bound | 2, 3, 10, 11 |
| ODbL attribution | 13 |

**Two deviations from the spec, both deliberate:**

1. **`venueRaw` is a new field the spec does not name.** The spec has `place` and `location`, but adapters need somewhere to put the source's literal venue string for resolution to consume, and the provenance doctrine says that raw claim should survive. Without it, a sentinel-venue event would lose the source's words entirely.
2. **`places.html` is not built.** It is an open question in the spec; the landing page instead caps "By venue" at 15 and states that all feeds exist on disk. Revisit if place feeds prove popular.

**Type consistency:** `resolvePlace`, `normalizeVenueKey`, `isSentinelVenue`, `parseVenueString`, `buildPlaceIndex`, `PLACE_INDEX`, `placeSpecs` are each defined once and referenced with the same signature throughout. `PlaceIndex` has the same four members in Tasks 3, 4, and 13.

**The away-game regression is preserved but relocated** — deleted from `resolveLocation`'s unit tests and re-proven through `finalizeEvent` in Task 6, which is the behaviour that actually matters.
