import Fastify from "fastify";
import { runPipeline, type PipelineResult, type PipelineStats } from "./pipeline.js";
import { buildFeed, parseFilter } from "./feed.js";
import { EVENT_TYPES, type DuluthEvent } from "./schema.js";
import { slug } from "./normalize.js";
import { logger } from "./logger.js";

const TTL_MS = 6 * 60 * 60 * 1000; // regenerate at most every 6h
let cache: { events: DuluthEvent[]; at: number; stats: PipelineStats } | null = null;
let inflight: Promise<PipelineResult> | null = null;

async function getEvents(): Promise<{ events: DuluthEvent[]; stats: PipelineStats }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!inflight) {
    inflight = runPipeline().finally(() => {
      inflight = null;
    });
  }
  const res = await inflight;
  cache = { events: res.events, at: Date.now(), stats: res.stats };
  return cache;
}

const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true }));

/** Discovery: what you can subscribe to. */
app.get("/sources", async () => {
  const { events } = await getEvents();
  const counts: Record<string, number> = {};
  for (const e of events) {
    const s = slug(e.source.name);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return { sources: counts, hint: "GET /feed.ics?source=<slug or substring>,..." };
});
app.get("/types", async () => {
  const { events } = await getEvents();
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
  return { types: EVENT_TYPES, counts, hint: "GET /feed.ics?type=live-music,class&multiDay=false" };
});
app.get("/stats", async () => (await getEvents()).stats);

/**
 * The subscribable feed. With no query it is everything; query params carve a sub-feed:
 *   /feed.ics?type=live-music,festival
 *   /feed.ics?source=legistar
 *   /feed.ics?type=class&multiDay=false      (single-day classes)
 *   /feed.ics?confidence=high&inDuluth=true
 */
app.get("/feed.ics", async (req, reply) => {
  const { events } = await getEvents();
  const ics = buildFeed(events, parseFilter(req.query as Record<string, unknown>));
  reply.header("Content-Type", "text/calendar; charset=utf-8");
  reply.header("Content-Disposition", 'inline; filename="duluth-events.ics"');
  return ics;
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then((addr) => logger.info({ addr }, "duluth-events feed server listening (GET /feed.ics, /sources, /types)"))
  .catch((err) => {
    logger.error(err, "server failed to start");
    process.exit(1);
  });
