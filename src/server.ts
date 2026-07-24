import Fastify from "fastify";
import { runPipeline, type PipelineResult, type PipelineStats } from "./pipeline.js";
import { logger } from "./logger.js";

const TTL_MS = 6 * 60 * 60 * 1000; // regenerate at most every 6h
let cache: { ics: string; at: number; stats: PipelineStats } | null = null;
let inflight: Promise<PipelineResult> | null = null;

/** Serve from cache; regenerate at most once per TTL; coalesce concurrent regenerations. */
async function getFeed(): Promise<{ ics: string; stats: PipelineStats }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!inflight) {
    inflight = runPipeline().finally(() => {
      inflight = null;
    });
  }
  const res = await inflight;
  cache = { ics: res.ics, at: Date.now(), stats: res.stats };
  return cache;
}

const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true }));
app.get("/stats", async () => (cache ? cache.stats : { note: "no feed generated yet — GET /feed.ics first" }));
app.get("/feed.ics", async (_req, reply) => {
  const { ics } = await getFeed();
  reply.header("Content-Type", "text/calendar; charset=utf-8");
  reply.header("Content-Disposition", 'inline; filename="duluth-events.ics"');
  return ics;
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then((addr) => logger.info({ addr }, "duluth-events feed server listening (subscribe to /feed.ics)"))
  .catch((err) => {
    logger.error(err, "server failed to start");
    process.exit(1);
  });
