# Extraction Methods Index

A reusable playbook of how each Duluth events source is extracted — organized by **platform**, because most sources share one (crack the platform once, every source on it is trivial). Pairs with the machine registry in [`src/sources.ts`](../src/sources.ts) (which source uses which adapter) and the schema in [`src/schema.ts`](../src/schema.ts).

**Doctrine:** feed-first, scrape-last, deterministic-first. Prefer a first-party machine feed/API over HTML; reach for a browser only when the data is JS/bot-gated; the LLM is a last resort. Every extraction earns a **confidence** tier via the schema's `CONFIDENCE_CEILING` (first-party feed → `high`; structured aggregator/render → `medium`; LLM → `low`).

---

## Adapter kinds (code strategies)

Registered in `src/pipeline.ts`; one `AdapterKind` per strategy.

- **`ical-import`** (`adapters/ical-import.ts`) — fetch a first-party `.ics`, parse with `node-ical`. Confidence `high`.
- **`structured-api`** (`adapters/structured-api.ts`) — fetch a documented/observed JSON API, per-source `mapper` (`legistar`, `tribe-rest`). Confidence `high`|`medium`.
- **`rec1`** (`adapters/rec1.ts`) — the REC1/CivicRec multi-call catalog flow. Confidence `medium`.
- **`jsonld`** (`adapters/jsonld.ts`) — headless-render a gated page, extract schema.org `Event` JSON-LD. Confidence `medium`.
- **`html`** (`adapters/html-scrape.ts`) — stub; stable-selector DOM parse for no-feed HTML calendars.
- **`pdf-llm`** (`adapters/pdf-llm.ts`) — stub; constrained LLM over PDF prose (last resort only).

Shared fetch seams: `fetchIcsText` (ical), `fetchJsonLdEvents` (`fetchers/headless.ts`, Playwright, lazy-imported).

---

## Platform playbook

### The Events Calendar (WordPress plugin) — REST
- **Fingerprint:** `GET {base}/wp-json/tribe/events/v1/events` returns JSON; page markup has `tribe-events*` classes.
- **Endpoint:** `{base}/wp-json/tribe/events/v1/events?per_page=N&start_date=YYYY-MM-DD` → `{events:[{title, start_date, utc_start_date, timezone, all_day, venue{venue,address,city}, cost_details{currency_symbol,values:[min,max]}, categories[], url, description(HTML)}], total, total_pages}`.
- **Access:** plain `fetch` + a **browser User-Agent** (several hosts 403 a bare curl UA). Paginate via `total_pages`.
- **Adapter:** `structured-api` / `tribe-rest`. **Confidence:** `medium` (aggregators) / could be `high` for a venue's own calendar.
- **Sources:** Visit Duluth, Do Duluth, Whole Foods Co-op.
- **⚠ Gotcha:** if the whole origin is Cloudflare-gated, this REST endpoint is *also* WAF-blocked even from a cleared browser → fall back to **JSON-LD render** (see PDD).

### Legistar / Granicus — OData Web API
- **Fingerprint:** government meetings; portal at `{client}.legistar.com`.
- **Endpoint:** `https://webapi.legistar.com/v1/{client}/events?$filter=EventDate ge datetime'YYYY-MM-DD'&$orderby=EventDate&$top=N` → OData JSON `[{EventId, EventBodyName, EventDate, EventTime, EventLocation, EventInSiteURL, EventAgendaFile}]`. Supports `$filter`/`$top`/`$skip`.
- **Access:** plain `fetch`, no auth for public calendars. **Client slug for Duluth = `duluth-mn`** (bare `duluth` → HTTP 500).
- **Adapter:** `structured-api` / `legistar`. **Confidence:** `high`, `verified:true` (first-party government record). `eventType: meeting`.
- **Sources:** Duluth City Meetings (Council + ~18 boards/commissions).

### REC1 / CivicRec — catalog SPA (multi-call)
- **Fingerprint:** `secure.rec1.com/{STATE}/{org}/catalog`, a jQuery SPA (`catalog-standard.js`).
- **Flow (all discovered by network sniffing):**
  1. `GET {catalog}` (HTML) → extract the **32-hex session hash** (`/catalog/{endpoint}/([a-f0-9]{32})/`; the hash in the URL path authorizes calls — no cookie needed).
  2. `getTabsFiltersItemsCounts/{hash}` → `{tabs:[{id}]}`.
  3. `getItems/{hash}/{tabId}` → `{sections:[{name,groups:[{id,name,descriptionText,minPrice,maxPrice,itemCount,deferredLoading:true,items:[]}]}]}` — groups are **deferred** (empty `items`). Keep only sections whose `name` matches `/program/i` (skips facility/rental tabs).
  4. `getActivitySessions/{hash}/{tabId}/{groupId}` → `{items:[{id, text, price, basicInfo[], features:[{name:"dates",value:"08/10/26"},{name:"times",value:"4pm-8pm"},{name:"location"},{name:"ageGender","value":"8/up"},{name:"days"}]}]}` — the **dated sessions**.
- **Access:** plain `fetch` throughout. **Adapter:** `rec1`. **Confidence:** `medium`. `eventType: class`; a date *range* → `multiDay`.
- **Source:** Duluth Parks & Recreation (retires the PDF brochure).

### LiveWhale — university calendar
- **Fingerprint:** `calendar.{domain}/live/`.
- **Endpoint:** `calendar.{domain}/live/ical/events` (real ICS). Also `/live/rss/events`, group-scoped feeds.
- **Access:** plain `fetch`. **Adapter:** `ical-import`. **Confidence:** `high`.
- **Source:** UMD (`calendar.d.umn.edu/live/ical/events`, ~277 events).

### JSON-LD render (schema.org Event on a gated page)
- **When:** the origin is Cloudflare/JS-gated so feeds are blocked, BUT the rendered page embeds `<script type="application/ld+json">[{"@type":"Event",…}]`.
- **Flow:** headless Chromium clears the challenge on the HTML page → extract JSON-LD Event blocks from the DOM → paginate via `a.tribe-events-c-nav__next` / `a[rel="next"]`. JSON-LD Event fields: `name, description(entity-encoded HTML), startDate(ISO+offset), endDate, location{@type:Place,name,address{streetAddress,addressLocality}}, offers{price}, eventStatus, image, url`.
- **Access:** headless Playwright (`fetchers/headless.ts`). **Adapter:** `jsonld`. **Confidence:** `medium`.
- **Source:** Perfect Duluth Day (`/duluth-events/list/`).

---

## Access technique: Cloudflare / bot walls

Not a platform — a wall that sits in front of one. Escalation ladder:
1. **Plain `fetch` + browser UA** → if `200` + real data, done.
2. **403 "Just a moment…" / "whoa there pardner"** → headless Chromium: `page.goto(htmlPage)`, `waitForFunction(() => !/just a moment/i.test(document.title))`. The HTML page usually clears.
3. **A specific endpoint still 403s even from the cleared browser** (PDD `?ical=1` + `wp-json`; a WAF rule on the export): don't fight it — either **in-page same-origin fetch** `page.evaluate(async () => (await fetch("/endpoint")).json())` (works when it's UA/fingerprint filtering, e.g. reddit's `about.json`/`search.json` on `www.reddit.com`), or **extract embedded JSON-LD from the DOM** (PDD).
4. Reddit note: `old.reddit.com` gates to a "Welcome to Reddit" wall; `www.reddit.com` loads headless and its same-origin JSON endpoints (`/r/<sub>/about.json`, `/wiki/index.json`, `/search.json`, `{permalink}.json`) return data.

---

## Source → method map

| Source | Platform | Adapter | Confidence | Status |
|---|---|---|---|---|
| UMD Events | LiveWhale | `ical-import` | high | ✅ live (~277) |
| Duluth City Meetings | Legistar | `structured-api`/legistar | high | ✅ live (13) |
| Visit Duluth | The Events Calendar | `structured-api`/tribe-rest | medium | ✅ live (50) |
| Do Duluth | The Events Calendar | `structured-api`/tribe-rest | medium | ✅ live (50) |
| Whole Foods Co-op | The Events Calendar | `structured-api`/tribe-rest | medium | ✅ live (19) |
| Perfect Duluth Day | Cloudflare + JSON-LD | `jsonld` (headless) | medium | ✅ live (25) |
| Duluth Parks & Rec | REC1/CivicRec | `rec1` | medium | ✅ live (29) |
| Duluth Public Library | LibraryMarket (`*.events.mylibrary.digital`) | TBD (headless) | medium | ⏳ sniffing |
| On The Record (zine) | Squarespace | TBD (`?format=json`/`ical`) | medium | ⏳ sniffing |
| DECC | WordPress (no tribe REST) | TBD | medium | ⏳ sniffing |
| Twin Ports Nightlife | custom | TBD | medium | ⏳ sniffing |
| Duluth Reader | JS-rendered custom | TBD | medium | ⏳ sniffing |
| Duluth Farmers Market | WP My Calendar | TBD (ICS/RSS) | medium | ⏳ sniffing |
| Duluth Folk School | Event Espresso | TBD (`/wp-json/ee/v4.8.36/events`) | medium | lead |

---

## Reverse-engineering recipe (for a new/unknown site)

1. **Fingerprint by plain fetch** (browser UA): try `/wp-json/`, `/wp-json/tribe/events/v1/events`, `?ical=1`, `/feed/`, `/sitemap.xml`, `?format=json` (Squarespace), and grep the HTML for platform markers (`tribe-events`, `squarespace`, `Event Espresso`, `my-calendar`).
2. **If JS-rendered or gated → sniff the network:** headless Chromium, `page.on("response")` capturing any `content-type: json` or URL matching `/api/|graphql|\.ics|feed|events|calendar`; then **interact** (click the calendar, "next", an event) to trigger deferred/XHR loads — this is how REC1's `getActivitySessions` and the deferred-load pattern were found.
3. **If a specific endpoint is bot-gated:** in-page same-origin `page.evaluate(fetch)`, or pull embedded JSON-LD from the DOM.
4. **Confirm** the endpoint returns real data with title/date/venue before trusting it — **never emit a guessed URL** (anti-fabrication; mark unconfirmed `⚠`).
5. **Classify:** platform → adapter kind → confidence tier; add the source to `src/sources.ts` and (if a new platform) a playbook entry here.

---

## Open leads (being sniffed)

`agent-web-data-extraction-engineer` is network-sniffing: On The Record (Squarespace `?format=`), Duluth Public Library (LibraryMarket, headless), DECC (hidden ajax/REST), Twin Ports Nightlife (custom), Duluth Reader (JS XHR), Duluth Farmers Market (My Calendar ICS), transistormag. Confirmed endpoints get appended to the playbook + source map above.
