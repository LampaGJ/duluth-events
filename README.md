# duluth-events

Aggregates Duluth, MN events from heterogeneous sources (first-party ICS feeds, HTML calendars, PDF brochures) into **one normalized, provenance-tagged, subscribable ICS feed**.

Built because no single Duluth calendar is comprehensive and the most-wanted sources (City Parks & Rec, the library, DECC) publish **no feed at all** — the only way to get them into a subscribable calendar is to ingest and re-emit our own.

## Design

Every source is mapped into one canonical event contract (`src/schema.ts`, Zod v4) before anything reaches the feed. The contract carries **per-event provenance**, and confidence is a **structural invariant** — an LLM reading a PDF brochure is capped at `low`; only a first-party `.ics` import can be `high`. A brochure guess can never validate as a first-party fact.

```
sources ──▶ adapters ──▶ DuluthEvent (validated) ──▶ fuzzy-merge dedupe ──▶ ical-generator ──▶ /feed.ics
 (ics/html/pdf)                                       (highest-confidence
                                                       copy wins; others
                                                       recorded in alsoListedIn)
```

Non-native iCal fields (cost, host, age, tickets, source) are carried **twice** in each VEVENT — a machine `X-` property and a human line appended to `DESCRIPTION` — so they survive in both feed-parsers and plain calendar apps. Every event's `DESCRIPTION` ends with a `Source: … · confidence:… · retrieved …` line.

## Run

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest (14 tests)
npm run pipeline       # fetch all enabled sources -> write duluth-events.ics
npm start              # serve the feed at http://localhost:3000/feed.ics (PORT env to change)
```

### Subscribe / sub-feeds

`GET /feed.ics` is the subscribable calendar. Query params carve a **sub-feed** — subscribe to exactly what you want:

- `?type=live-music,festival` — one or more event types
- `?type=class&multiDay=false` — single-day classes (`multiDay=true` for multi-week)
- `?source=legistar` — by source (substring of the source slug: `legistar`, `pdd`, `parks`…)
- `?confidence=high` · `?inDuluth=true` — quality / scope filters
- combine freely: `/feed.ics?type=live-music&inDuluth=true&confidence=high`

Every event is typed into a controlled `eventType` vocabulary (`live-music`, `class`, `meeting`, `market`, `festival`, `sports`, `performing-arts`, `film`, `visual-arts`, `family`, `food-drink`, `education`, `community`, `other`) and flagged `multiDay`. `GET /types` and `GET /sources` list what's available (with counts); `GET /stats` shows the last run; `GET /health` is a probe.

## Sources (`src/sources.ts`)

| Source | Adapter | Confidence | Status |
|---|---|---|---|
| **UMD Events** (LiveWhale) | ics-import | high | ✅ live (~277 events) |
| **Perfect Duluth Day** (The Events Calendar) | ics-import | high | ⚠️ Cloudflare JS challenge — plain fetch 403s; needs a headless fetcher |
| DoDuluth | ics-import | high | confirmed feed, possibly stale (disabled) |
| DECC | html-scrape | medium | stub (no feed) |
| Parks & Rec brochure | pdf-llm-extract | low | stub (PDF only) |
| Duluth Public Library | pdf-llm-extract | low | stub (PDF press releases) |

### Subscribe directly (no server needed)
- Perfect Duluth Day — `webcal://perfectduluthday.com/duluth-events/?ical=1` (broadest; your calendar app may clear the Cloudflare challenge even though a server can't)
- UMD — `https://calendar.d.umn.edu/live/ical/events`

## Status / next steps

Working today: the full **ICS-import → dedupe → emit → serve** loop (UMD live and validated; feed round-trips through node-ical).

Next, in priority order:
1. **Headless fetch for PDD** — route `fetchIcsText` through Playwright for Cloudflare-challenged sources so the "everything" base flows in.
2. **`pdf-llm-extract` adapter** (`src/adapters/pdf-llm.ts`) — fetch PDF → extract text (`unpdf`) → LLM structure → `DuluthEvent[]` (schema caps these at `low`). The only path for the Parks/Library events.
3. **`html-scrape` adapters** for DECC / Visit Duluth / Reader (`cheerio`).
4. Persist events (better-sqlite3/Drizzle) for stable UIDs + `LAST-MODIFIED` change detection across refreshes.

## Stack

Zod v4 · ical-generator · node-ical · Fastify · Pino · TypeScript · Vitest · tsx.
