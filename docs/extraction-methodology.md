---
type: spec
status: active
related: [../src/schema.ts, ../src/sources.ts, ../src/adapters/ical-import.ts, ../src/dedupe.ts]
review_by: 2026-10-23
purpose: Deterministic-first method ladder for getting the no-feed Duluth sources into DuluthEvent, reserving a constrained LLM only for irreducible brochure prose.
summary: Legistar Web API and Visit Duluth REST API are fully deterministic structured feeds (proven live). DECC is deterministic HTML. Only the Parks/Library PDF residue may need a constrained-LLM referee, gated behind a dual/triple independent-engine cross-check.
---

# Deterministic-first extraction methodology

**What this answers:** for each no-feed source, the lowest rung on the deterministic-to-frontier ladder that actually gets it into `DuluthEvent` — with live evidence, not assumption.

**TL;DR.** Almost none of this needs an LLM. Two of the four "hard" sources are fully-structured first-party JSON feeds that were hiding in plain sight (Legistar Web API; Visit Duluth's The-Events-Calendar REST API — both proven live below). DECC is deterministic HTML (tribe single-event templates). Only the Parks & Rec brochure and Library press-release PDFs have irreducibly-unstructured prose — and even there, the plan is dual/triple *independent deterministic extractor* cross-check first, with a constrained LLM admitted only as a per-field *referee* over the genuinely-conflicting residue, capped at `low` and validated against the schema.

---

## The ladder (most-deterministic → LLM-last)

1. Structured first-party API (JSON/OData) — deterministic, typed, paginated. **Earns the top deterministic tier.**
2. JSON-LD / schema.org microdata embedded in the page — spec'd extraction, deterministic.
3. Platform REST/feed export (`?ical=1`, `/wp-json/tribe/...`) — deterministic parse of a structured export.
4. Deterministic HTML parse via *stable* selectors (data-attributes / templated CSS classes), not guesswork.
5. Deterministic PDF text+table extraction + regex over the structured pockets — dual/triple independent engines cross-checked.
6. Constrained LLM, last — referee over the conflicting residue only; forced through `DuluthEventSchema`; `low`; every field validated + date/time re-parsed deterministically.

---

## Per-source findings (live-probed 2026-07-23)

### 1. City of Duluth public meetings → rung 1, structured API. PROVEN.

- Platform: Granicus **Legistar**, client slug **`duluth-mn`** (confirmed; `duluth` returns HTTP 500 "connection string not set up").
- Endpoint: `https://webapi.legistar.com/v1/duluth-mn/events?$top=40&$orderby=EventDate desc` → **HTTP 200, clean JSON array**.
- Fields per event: `EventId`, `EventBodyName`, `EventDate`, `EventTime` ("6:00 PM"), `EventLocation` ("Council Chambers"), `EventInSiteURL`, `EventAgendaFile` (PDF). OData `$filter`/`$top`/`$skip` for paging + date windows.
- 19 distinct bodies in the last 40 events (City Council, DEDA, Planning Commission, HPC, Library Board, Parks & Rec Commission, ...).
- **POC result: 40/40 mapped to validated `DuluthEvent`.** Sample: `City Council — Public Meeting`, `2026-07-27T18:00:00-05:00`, Council Chambers, InSite URL.
- This is first-party government structured data → the strongest possible non-ICS signal. Recommend confidence **high** (see schema proposal) — with `verified: true`.

### 2. Visit Duluth → rung 1/3, The-Events-Calendar REST API. PROVEN.

- Platform: WordPress + **The Events Calendar** (same plugin family as PDD). The page references `wp-json/tribe/events/v1/`.
- Endpoint: `https://visitduluth.com/wp-json/tribe/events/v1/events?per_page=50&start_date=YYYY-MM-DD` → **HTTP 200; `total: 1158` events**.
- Fields: `title`, `start_date`/`end_date` + `utc_start_date`/`utc_end_date`, `timezone` (`America/Chicago`), `all_day`, `url`, `venue` (`venue`, `address`, `city`), `cost_details` (`currency_symbol`, `values: [min,max]`), `categories[]`, `description`. HTML entities need decoding; strip tags from description.
- **POC result: 6/6 mapped to validated `DuluthEvent`**, incl. paid cost min/max ("$1"–"$22"), venue+address, categories.
- Bonus: Visit Duluth *aggregates DECC* (DECC event links appear inside its listing) — so enabling Visit Duluth covers much of DECC deterministically, and dedupe collapses the overlap.
- Recommend confidence **medium** (it is a tourism aggregator, not the venue's own system) via a new `structured-api` method.

### 3. DECC → rung 4, deterministic HTML. No LLM.

- Platform: WordPress 7.0.2 with `/event/<slug>/` detail pages (The Events Calendar rewrite), BUT: tribe REST is **404 (disabled)**, `?ical=1` is **ignored (serves HTML)**, and **no JSON-LD** on list or detail pages (0 `ld+json`, 0 `@type:Event`).
- So the structured exports are off. Path: deterministic parse of the templated single-event pages using **stable tribe CSS classes** (`.tribe-events-single-event-title`, `.tribe-events-start-date`, `.tribe-events-venue-details`) via `node-html-parser`/`cheerio`. Detail links are cleanly enumerable from the list page (`href="https://decc.org/event/<slug>/"`).
- Largely redundant with Visit Duluth; build this **after** VD so dedupe already covers the overlap. Confidence **medium** (`html-scrape`).

### 4. Duluth Reader → rung 4 (deferred). JS-rendered.

- Small page (40 KB), no JSON-LD, no `wp-json` events, calendar rendered client-side. Lowest value / highest effort of the HTML set. Defer; revisit with a rendered-DOM fetch if coverage gaps remain.

### 5. City Parks & Rec REC1/CivicRec catalog → rung 1 candidate (registration, not events).

- `https://secure.rec1.com/MN/duluthparks/catalog` is a jQuery SPA (`catalog-standard.js`, `catalog.catalog(...)`) that loads catalog data via an ajax endpoint (traceable → deterministic). BUT this is a **registration catalog** (classes/camps/leagues), not one-off public events. Lower events-value than the brochure's free concert series. Trace the endpoint only if registerable programs are in scope; otherwise skip.

### 6. Parks & Rec brochure + Library PDFs → rung 5, then rung-6 residue only.

- Brochure: `pdftotext -layout` extracts cleanly (**32 pages, 69,928 chars** — born-digital text layer, no OCR needed). It is a **mix**: regex-targetable pipe/column table rows (`Th | May 28 | 5-6 p.m. | $5 | Course #4503`; `W | 9-11 a.m. | Free | Course #4505`) AND irregular magazine prose with dotted leaders and interleaved columns (`Tab & Nicole........ Acoustic Covers (6:30-7:10 pm)`).
- The **regular tables are deterministic** (dual/triple-engine cross-check below). The **irregular prose residue is the only genuine LLM candidate** in the entire system.

---

## Dual / triple independent-extractor PDF cross-check (rung 5)

Born-digital PDFs have a text layer → CPU-only, no OCR. Run independent engines **in parallel as cross-checks, not either/or** — agreement between genuinely-different engines is an *uncorrelated* signal that earns a deterministic tier.

**Engine independence map (this is load-bearing):**

- **Text boxes:** `pdfplumber` (MIT; pdfminer.six, pure-Python) vs **PyMuPDF** (AGPL-3.0; MuPDF, C). Different engines → **fully independent**; text-box agreement is a strong uncorrelated signal.
- **Tables:** PyMuPDF `find_tables()` was **derived from pdfplumber's** table algorithm → their table results share lineage and are only **partially independent**. Do NOT treat their table-cell agreement as fully uncorrelated. Add **Camelot** (MIT; OpenCV lattice/stream — a genuinely different geometric approach that self-reports a per-table accuracy score) as the independent **third witness** for schedule tables.

**Architecture (schema discipline preserved):** shell out to a small **pinned** Python `extract.py` per engine emitting JSON; **validate that JSON at the TS boundary with Zod** before it enters the pipeline (an extractor-output contract, run through `agent-zod-zealot`). PyMuPDF `get_text("dict")` → blocks/spans+bbox = text-box cards; `find_tables().extract()` and Camelot → schedule tables.

**License options to state up front:** PoC uses PyMuPDF (AGPL-3.0) — fine for a spike (launch-only license flag, noted, proceeding). A fully-MIT variant is **pdfplumber + Camelot** (drop PyMuPDF) — slightly weaker text-box independence but no copyleft.

### "Same event" matching (mirror `src/dedupe.ts`)

Reuse the existing `fuzzyKey` shape so reconciliation is consistent with cross-source dedupe: `day (YYYY-MM-DD) | first 6 title tokens (lowercased, alnum) | venue token (alnum, 12 chars)`. Two engine extractions match iff their fuzzyKeys match; then compare **key fields** field-by-field: title (fuzzy/normalized), start date+time (parse to instant and compare), venue (normalized). Fee/cost, course#, category are secondary fields.

### Reconciliation → confidence tiers

- **Both text engines agree on title+date/time+venue** → deterministic record. Text-box fields parsed by regex over the agreed spans → **medium** via `pdf-parse` (a notch below API/JSON-LD; it is still a parse of prose).
- **Table-cell values confirmed by two *genuinely-independent* methods** (PyMuPDF/pdfplumber text-box + **Camelot**, or Camelot's own confidence score above threshold) → the **higher deterministic tier** for those fields (still `pdf-parse`; record `verified: true`, note "table-cell dual-witness").
- **Field-level disagreement** (e.g. different fee or time) → **keep the record, flag the conflicting field**, cap confidence at `low` for the record. Resolution rule: **prefer the table-structured value** (Camelot/`find_tables` cell) over a text-box regex capture; if still conflicting, escalate that **field only** (not the whole record).
- **One engine finds an event the other misses** → **flag for review** (emit with `status: tentative` + `source.notes: "single-engine; unconfirmed"`); never silently drop, never silently include.
- **Genuinely-conflicting residue only** → constrained **LLM referee** (see below) or human. Referee output stays **`low`**, validated against `DuluthEventSchema`.

### Recording "confirmed by both engines" in provenance

- Primary record's `source` = the winning engine's `pdf-parse` extraction.
- Append the second (and third) engine's extraction as a `SourceSchema` entry in **`alsoListedIn`** — same mechanism the fuzzy-merge already uses for cross-source corroboration. Reader/downstream can see "seen by pdfplumber + PyMuPDF + Camelot".
- `source.notes`: brochure edition/date (stale-season visibility) + the witness set, e.g. `"Summer 2026 brochure; table-cell confirmed by find_tables+Camelot (acc 0.96)"`.

---

## Where the LLM is genuinely irreducible — and how it is constrained

Only the **irregular brochure/press-release prose residue** that survives the deterministic tables and the dual-engine text cross-check. There, the LLM is a **referee / tiebreaker, not an extractor**, and is constrained on every axis:

1. **Deterministic pre-segmentation:** the LLM only ever sees the one already-isolated prose block for one candidate event — never the whole 32-page PDF.
2. **Forced structured output** against `DuluthEventSchema` (constrained decoding / JSON-schema; a small local model is sufficient for this narrow shape).
3. **Confidence hard-capped `low`** via `extractionMethod: "pdf-llm-extract"` (the schema ceiling already enforces this — a brochure guess cannot validate as `high`).
4. **Every field validated**, and **date/time re-parsed with a deterministic parser** and cross-checked against the LLM's own output — structure is not truth; a valid-but-wrong instant is caught here.
5. **No date/venue agreement → drop** (or `status: tentative` for human review), never emit.

---

## Schema change proposal (run through `agent-zod-zealot`)

The current `extractionMethod` enum lumps a deterministic first-party JSON API in with an HTML scrape, and has no home for JSON-LD — so a Legistar/Visit-Duluth extraction is mislabeled `html-scrape` and capped below what it deserves. Proposed additions to `src/schema.ts`:

- Add to `extractionMethod` enum: **`structured-api`**, **`jsonld`**.
- `CONFIDENCE_CEILING`:
  - `"structured-api": ["high", "medium"]` — first-party government/official API (Legistar) may be `high`; third-party aggregator API (Visit Duluth) uses `medium`.
  - `"jsonld": ["medium"]` — spec'd structured markup, but page-authored, so cap at `medium`.
  - (`pdf-parse` stays `["medium","low"]`; `pdf-llm-extract` stays `["low"]`.)
- Consider `SourceSchema.type` already has `json-api` — good; align `extractionMethod` with it.

This is a **schema/contract change** → do NOT merge without `agent-zod-zealot` (v4-shape lint + `tsc` + parse smoke) and a `agent-schema-registry-architect` manifest refresh.

---

## Prioritized build order (adapters, mirroring `ical-import.ts`)

1. **`legistar-api.ts`** (new, `structured-api`, `high`) — highest value, zero LLM, fully proven. `fetchJson(webapi.legistar.com/v1/duluth-mn/events?$filter=EventDate ge <today>)` → map → validate. Mirror the ical adapter's fetch/validate/drop-invalid shape.
2. **`tribe-rest.ts`** (new, `structured-api`, `medium`) — Visit Duluth (1158 events, proven). Generalizable to any The-Events-Calendar site (reuse for PDD/DoDuluth as a REST fallback to the Cloudflare-blocked `?ical=1`). Entity-decode + strip tags.
3. **`html-scrape.ts`** (fill the stub, `html-scrape`, `medium`) — DECC single-event tribe templates via `node-html-parser`. Build after #2 so dedupe already covers the overlap.
4. **`pdf-parse.ts`** (new, `pdf-parse`, `medium`/`low`) — dual/triple-engine cross-check over the Parks brochure + Library PDFs. Deterministic tables → `medium`; conflicts → `low`/review.
5. **`pdf-llm.ts`** (existing stub, `pdf-llm-extract`, `low`) — demote to *referee over the pdf-parse residue only*. Not a primary extractor. Wire last, behind #4.

**Net effect:** the two biggest missing sources (all City meetings; ~1000+ Visit Duluth listings) come in **fully deterministically** with **zero LLM calls**. The LLM survives only as a constrained referee over the irregular-prose fraction of two PDF sources — exactly the irreducible residue.

## Tooling named

- Legistar Web API (OData) — no dep, native `fetch`.
- The Events Calendar REST (`/wp-json/tribe/events/v1/events`) — native `fetch`.
- `node-html-parser` (or `cheerio`) for DECC.
- PDF: `pdftotext -layout` (already installed) for probing; `pdfplumber` + `PyMuPDF` + `Camelot` (pinned Python `extract.py`, JSON out, Zod-validated at the TS boundary) for production dual/triple cross-check.
- Reconciliation reuses `src/dedupe.ts` `fuzzyKey` + `alsoListedIn` provenance.
