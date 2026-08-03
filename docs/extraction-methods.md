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

### Joomla + iCagenda — native RSS feed
- **Fingerprint:** Joomla markup + `mod_icagenda_calendar` CSS/JS, `com_icagenda` URL slugs.
- **Endpoint:** Joomla's feed dispatcher on an iCagenda list view: `{base}/{list-view}?format=feed&type=rss` (e.g. `/music?format=feed&type=rss`, `/the-nightlife/calendar?format=feed&type=rss`) → RSS 2.0 (`application/rss+xml`), `<item>` per event with `title`, `link`, `pubDate` (date+time), `category`, `description` (HTML: venue + thumbnail).
- **Access:** plain `fetch`, no bot-wall. **⚠ Gotcha:** Joomla caps the feed at **10 items** (not client-overridable). Secondary richer source: `index.php?option=com_ajax&module=icagenda_calendar&method=events&format=raw&modid={id}&year=&month=` (chattier per-month HTML).
- **Adapter:** `rss` (new — RSS 2.0 parse; sits beside `ical-import`). **Confidence:** `medium`.
- **Source:** Twin Ports Nightlife (`twinportsnightlife.com`).

### `swim-events-calendar` (bespoke WordPress plugin) — HTML fragment endpoint
- **Fingerprint:** WordPress, but NOT The Events Calendar (its `tribe` REST 404s — a red herring). Calendar rendered by the `swim-events-calendar` plugin.
- **Endpoint:** `{base}/wp-content/plugins/swim-events-calendar/events-template.php?cat=All` (optionally `&startMo=YYYYMM01&endMo=YYYYMM01`; cats: `All,Broadway,Comedy,Conventions,Dance,DSSO,Expos,Hockey,Music`) → an HTML **fragment** (not JSON): `<section class="event-list-item">` blocks with `.entry-title a` (title+permalink), `.event-date` (`Jul <span>26</span> | 6:00 pm` — infer year from the query month), `.slide-venue`, category classes, thumbnail, Ticketmaster link.
- **Access:** plain `fetch`, no bot-wall, no headless. One request returns the full list (94 events observed).
- **Adapter:** `html-scrape` (deterministic, stable semantic classes) against the fragment endpoint — NOT the full rendered `/events-calendar/` page. **Confidence:** `medium`.
- **Source:** DECC.

### My Calendar (WordPress plugin, joedolson) — ICS
- **Fingerprint:** WordPress + `my-calendar` markup; a `/my-calendar/` page.
- **Endpoint:** `{base}/feed/my-calendar-google/` → real `text/calendar` (`PRODID:spatie/icalendar-generator`), `VEVENT`s with `SUMMARY/LOCATION/DTSTART/DTEND(TZID)/RRULE/URL`. (The documented `?my-calendar-api=json|ical|csv` export is often **not enabled** — confirm empirically; it silently falls through to the homepage when off.)
- **Access:** plain `fetch`. **⚠ Gotcha:** the TLS cert may lack a `www` SAN (CN = apex only) → fetch the **apex** host (`duluthfarmersmarket.com`, not `www.`) to avoid a cert error; do NOT disable cert validation.
- **Adapter:** `ical-import` (existing). **Confidence:** `high` (first-party ICS).
- **Source:** Duluth Farmers Market (thin — ~2 recurring VEVENTs currently).

### Custom server-rendered calendar (per-day HTML)
- **Fingerprint:** no feed, no wp-json; a JS `component?...&json=...` AJAX shell that returns empty (red herring) while the real content is server-rendered inline.
- **Endpoint pattern:** one plain `GET` per day, e.g. `{base}/events/calendar/YYYY/MM/DD?city=duluth` → `<article class="result event_time">` per event: `.date .time`, `.title a`, `.teaser`, `.location_text`, `.cost` ("Cost: FREE"), `.age`.
- **Access:** plain `fetch`, no bot-wall. Requires **date-range iteration** (no single "all upcoming" endpoint).
- **Adapter:** `html-scrape` (deterministic). **Confidence:** `medium`.
- **Source:** Duluth Reader.

### Squarespace — `?format=` (only if an Events collection exists)
- **Fingerprint:** `squarespace` in markup; `?format=json` returns structured JSON on ANY page.
- **Trick:** an Events **collection** page serves `?format=json`, `?format=ical`, and `?format=rss`. Useful in general.
- **⚠ Negative (On The Record):** the site has NO events collection — its "shows listing" is only **scanned page images** of the print zine (plus a Google-Drive PDF archive). No feed/API/JSON-LD tier applies; extraction would require OCR/`pdf-llm` over images. Under feed-first discipline, **do not build** — "high priority" here is print-zine value, not web-extractable value.

### LibraryMarket (`*.events.mylibrary.digital`) — BLOCKED (Cloudflare Turnstile)
- **Fingerprint:** `{lib}.events.mylibrary.digital`; a real events calendar (`/search?c=…`), NOT PDF-only.
- **Status:** whole-zone Cloudflare **Turnstile managed challenge** — even `/robots.txt` is gated. Bundled Playwright/Chrome (headless AND headed, `navigator.webdriver` patched, `--disable-blink-features=AutomationControlled`, real-Chrome `channel:"chrome"`) all stay stuck: it's the **CDP automation itself** that's flagged, not the UA.
- **Path if prioritized:** anti-detect tooling (`patchright`, or `playwright-extra` + stealth), OR a human solves the Turnstile once and we harvest the short-lived `cf_clearance` cookie for reuse (needs periodic refresh). Defer.
- **Source:** Duluth Public Library.

---

## Access technique: Cloudflare / bot walls

Not a platform — a wall that sits in front of one. Escalation ladder:
1. **Plain `fetch` + browser UA** → if `200` + real data, done.
2. **403 "Just a moment…" / "whoa there pardner"** → headless Chromium: `page.goto(htmlPage)`, `waitForFunction(() => !/just a moment/i.test(document.title))`. The HTML page usually clears.
3. **A specific endpoint still 403s even from the cleared browser** (PDD `?ical=1` + `wp-json`; a WAF rule on the export): don't fight it — either **in-page same-origin fetch** `page.evaluate(async () => (await fetch("/endpoint")).json())` (works when it's UA/fingerprint filtering, e.g. reddit's `about.json`/`search.json` on `www.reddit.com`), or **extract embedded JSON-LD from the DOM** (PDD).
4. Reddit note: `old.reddit.com` gates to a "Welcome to Reddit" wall; `www.reddit.com` loads headless and its same-origin JSON endpoints (`/r/<sub>/about.json`, `/wiki/index.json`, `/search.json`, `{permalink}.json`) return data.
5. **Cloudflare Turnstile (managed challenge) — the hard wall.** Distinct from the basic "Just a moment…" that step 2 clears. Turnstile fingerprints the **CDP automation itself** — bundled Playwright/Chrome cannot pass even headed, with `navigator.webdriver` patched and `--disable-blink-features=AutomationControlled`, or via real-Chrome `channel:"chrome"`. It can gate a whole zone (even `/robots.txt`). Options: anti-detect forks (`patchright`), `playwright-extra` + stealth, or **harvest a human-solved `cf_clearance` cookie** and replay it (short-lived, needs refresh). Seen on: Duluth Public Library (`*.events.mylibrary.digital`).

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
| Twin Ports Nightlife | Joomla / iCagenda | `rss` (new) | medium | ✅ cracked — RSS feed (10-cap) |
| DECC | swim-events-calendar (WP) | `html-scrape` | medium | ✅ cracked — plugin fragment (94) |
| Duluth Farmers Market | WP My Calendar | `ical-import` | high | ✅ cracked — `/feed/my-calendar-google/` (thin) |
| Duluth Reader | custom server-rendered | `html-scrape` | medium | ✅ cracked — per-day HTML |
| Duluth Folk School | Event Espresso | `structured-api` (new mapper) | medium | lead (`/wp-json/ee/v4.8.36/events`) |
| Duluth Public Library | LibraryMarket | headless + anti-detect | medium | ⛔ blocked — CF Turnstile |
| On The Record (zine) | Squarespace | — | — | ⛔ no data — shows are scanned images |
| transistormag | — | — | — | 💀 dead (folded 2019, DNS gone) |

---

## Nature centers & museums (sweep 2026-07-23)

**Wired (enabled):** Duluth Art Institute (TEC, ~102 events — biggest venue find), North Shore Scenic Railroad (TEC; its feed sends a non-IANA `UTC+0` tz → `safeTimezone` falls back), **Glensheen** (LiveWhale *group*-scoped ICS `…/live/ical/events/group/Glensheen` — corroborates/merges with the main UMD feed, a live demo of multisampling), **St. Louis River Alliance** + **Friends of the Lake Superior Reserve / Estuarium** (Squarespace `?format=json` → new `squarespace` mapper), Bong Center (TEC, Superior WI → `inDuluth:false`), Friends of Sax-Zim Bog (TEC, empty right now).

**SiteGround "Robot Challenge"-gated WordPress with NO event plugin** — headless clears the wall in ~5s (escalation step 2, not Turnstile) but there is no feed to extract; aggregator-only (they cross-post to Visit Duluth/PDD/Do Duluth): **Hartley Nature Center, Great Lakes Aquarium, Lake Superior Zoo**.

**No structured feed:** Boulder Lake ELC (Drupal prose), Lake Superior Maritime Visitor Center (ClubExpress, no events), Hawk Ridge (no plugin; its "Everyone Can Bird" comes via FOLSR), Chester Bowl (no plugin), NRRI/Tweed (UMD Drupal, no LiveWhale widget — Tweed worth a headless follow-up on `/exhibitions`).

**Covered by existing sources:** Bagley Nature Area → UMD LiveWhale; SS William A. Irvin → DECC.

**Dead / closing:** Karpeles Manuscript Library Museum (closing 2026), Superior Public Museums / Fairlawn (site misconfigured/orphaned — periodic recheck).

## Extended sweep — tribal / college / arts / health / sports (2026-07-24)

**New platforms confirmed (need mappers):**
- **Revize CMS calendar** (tribal/municipal): `GET {base}/_assets_/plugins/revizeCalendar/calendar_data_handler.php?webspace={ws}&relative_revize_url=//cms3.revize.com&protocol=https:` → JSON array (title/start/location/url/desc/allDay). The `webspace`/`relative_revize_url` params live in the page's inline `<script>` (guessing 404s). Plain fetch. → `structured-api`/new `revize-calendar`. **FDL Band** = 428 events.
- **Sitecore XA + Coveo** (Essentia): `GET https://www.essentiahealth.org/sxa/search/results?s={GUID}&itemid={GUID}&v={GUID}&p=10&o=Event%20Upcoming,Ascending` → JSON (148), each result an `Html` fragment (title/date/location as pre-rendered HTML — mapper must unwrap HTML-in-JSON). Location filterable to "Duluth, MN". Plain fetch, GUIDs are stable. → `structured-api`/new `sitecore-sxa-coveo`.
- **Embedded public Google Calendar ICS** (DISC): the `/schedule/` page embeds a GCal iframe → its ICS is `https://calendar.google.com/calendar/ical/{calId}%40group.calendar.google.com/public/basic.ics`. Plain fetch → `ical-import` (existing). ⚠ `X-WR-TIMEZONE: America/New_York` but times are Central — handle the tz mismatch (same class as NSSR's `UTC+0`).
- **WP custom post type** (no TEC): `GET {base}/wp-json/wp/v2/{cpt}` — DSSO `concert`, Ursa Minor `event`. Title/permalink confirmed but the DATE is in body prose (no ACF/JSON-LD) → mapper needs a content-regex or page-render. → `structured-api`/new `wp-custom-cpt`.

**Ready to wire (confirmed real data):**
- FDL Band (revize, 428, high, net-new tribal) · Essentia (sitecore-coveo, 148, med-high) · DISC (ical, high, tz-gotcha) · ~~FDLTCC~~ **wired 2026-07-31** · UWS (tribe-rest, high, Superior WI — see the 2026-07-31 sweep before wiring) · DSSO (wp-cpt, med) · Ursa Minor (wp-cpt, med).
- Ready TEC, **0 events right now** (re-poll at wire time): Zeitgeist Arts, Minnesota Ballet, Sacred Heart Music Center, ~~Spirit Mountain~~ **wired 2026-07-31** — all `tribe-rest`, zero new code.
  ⚠ **Zeitgeist Arts is `zeitgeistarts.com`, not `.org`.** The `.org` domain does not resolve, so the
  endpoint recorded here was never actually being polled. Corrected 2026-07-31; the correct domain
  still returns 0 events, as do Minnesota Ballet and Sacred Heart.

**No feed → html-scrape fallback:** Bayfront Festival Park (Wix, plain-text calendar block — easiest), LSC (`lsc.edu`, REST 401-locked, 1,537 events in one HTML page), Duluth Playhouse/NorShor (Webflow), Heritage Sports Center (Webflow, sparse), CSS/SaintsLife (CampusGroups per-org ICS, ~600 orgs, needs AJAX sniff).

**Social-only / no feed:** AICHO (Weebly blog, index password-gated), 1854 Treaty Authority (Joomla DPCalendar export not locatable), Clyde/Bent Paddle/Blacklist/Pizza Lucé (FB-only), Earth Rider (Wix Events + Eventbrite, unconfirmed), Wussow's (SimpleTix SPA, unconfirmed). **Dead:** The Rex (closed 2023). **Migrating:** St. Luke's→Aspirus (site unstable, recheck later).

## Empty/thin place-feed sweep (2026-07-31)

A different way to pick targets: instead of sweeping a *category* of institution, sweep the venues
that already have a registered place and a published per-venue feed **with no events in it**. An
empty place feed is a standing, self-maintaining list of "we know this venue exists and we have
nothing from it" — a better-aimed worklist than a category sweep, and it only became visible once
`places.html` listed all 78 venues with live counts.

**Wired (all `tribe-rest`, zero new code):**
- **Wild State Cider** (`wildstatecider.com`) — 33 upcoming, every event carrying its own venue
  string. Its place feed went **2 → 34**. Missed by the 2026-07-24 sweep because that sweep
  catalogued the Lincoln Park taprooms as FB-only *as a group*; true of Clyde/Bent Paddle/Blacklist,
  wrong about this one. **Lesson: never generalize a no-feed finding across a group of venues.**
- **Spirit Mountain** (`spiritmt.com`) — 2 upcoming. The re-poll the 2026-07-24 sweep asked for.
  Thin by nature: a ski hill's winter programming is not in this API in July — re-check seasonally
  rather than assuming breakage. ⚠ Its events arrive with **no venue string at all**, so they resolve
  to no place and never reach a place feed. Do NOT infer the venue from the source name: one of the
  two events is actually at Riverside Bar & Grill.
- **FDLTCC** (`fdltcc.edu`) — 3 upcoming. Was already on the "ready to wire" list above and simply
  never wired, which is exactly why its registered place feed was empty.

**Found live but deliberately NOT wired:**
- **UWS** (`uwsuper.edu`, tribe-rest) — endpoint healthy, **842 events**, but the sample is dominated
  by internal departmental meetings ("MCS Dept Meeting") carrying no venue. Wiring it would roughly
  double the corpus with institutional noise. Whether it belongs behind the `institutionalNotice`
  facet is a judgment call, not a drive-by. Decide before wiring.

**Confirmed no feed (probed 2026-07-31, don't re-probe blind):**
- **Big Top Chautauqua** (`bigtop.org`) — no TEC, no `?ical=1`, no `/feed/`, **zero JSON-LD blocks**;
  `/sitemap.xml` is the only structured artifact. Scrape candidate only, and it is in Bayfield WI.
- **Carmody Irish Pub** — root returns HTTP 200 with a **zero-byte body**; JS-only or gated.
- **Blacklist** — Squarespace, but `?format=json` yields no items on `/events`, `/calendar`,
  `/shows`, `/happenings`. Squarespace alone does not imply a reachable Events collection.
- **Zenith Bookstore, Carmody** — `?ical=1` returns **HTTP 200 with `text/html`**. A soft-404.
  **Always check `content-type`, never just the status code**, before believing an ICS endpoint.

**Expected-empty, not defects:** city parks and landmarks (Enger Tower, Olcott/McFarland/Webster/
Bennett/Carl Gullo Park) publish through the Parks catalog only when something is scheduled; venue
rooms and sub-venues (Rathskeller, SS William A. Irvin) are covered by their parent source.

## Reverse-engineering recipe (for a new/unknown site)

1. **Fingerprint by plain fetch** (browser UA): try `/wp-json/`, `/wp-json/tribe/events/v1/events`, `?ical=1`, `/feed/`, `/sitemap.xml`, `?format=json` (Squarespace), and grep the HTML for platform markers (`tribe-events`, `squarespace`, `Event Espresso`, `my-calendar`).
2. **If JS-rendered or gated → sniff the network:** headless Chromium, `page.on("response")` capturing any `content-type: json` or URL matching `/api/|graphql|\.ics|feed|events|calendar`; then **interact** (click the calendar, "next", an event) to trigger deferred/XHR loads — this is how REC1's `getActivitySessions` and the deferred-load pattern were found.
3. **If a specific endpoint is bot-gated:** in-page same-origin `page.evaluate(fetch)`, or pull embedded JSON-LD from the DOM.
4. **Confirm** the endpoint returns real data with title/date/venue before trusting it — **never emit a guessed URL** (anti-fabrication; mark unconfirmed `⚠`).
5. **Classify:** platform → adapter kind → confidence tier; add the source to `src/sources.ts` and (if a new platform) a playbook entry here.

---

## Buildable next (cracked, awaiting adapters)

Ranked by value; all endpoints CONFIRMED returning real data (sniffed 2026-07-23):
1. **Twin Ports Nightlife** — new `rss` adapter (Joomla/iCagenda RSS). Live-music value; trivial parse; 10-item cap.
2. **DECC** — `html-scrape` of the `swim-events-calendar` fragment (94 events in one request). Needs `cheerio`/`node-html-parser`.
3. **Duluth Farmers Market** — existing `ical-import` + the apex-host TLS handling. High confidence but thin (~2 events).
4. **Duluth Reader** — `html-scrape` with per-day iteration.
5. **Duluth Folk School** — new `structured-api` Event-Espresso mapper (`/wp-json/ee/v4.8.36/events`).

## Deferred / dead
- **Duluth Public Library** — Cloudflare Turnstile blocks bundled automation; needs anti-detect tooling or a harvested `cf_clearance`. Real calendar exists; revisit if prioritized.
- **On The Record** — no web-extractable events (scanned print-zine images). Not buildable under feed-first.
- **transistermag** — publication folded 2019; domain dead. Dropped.
