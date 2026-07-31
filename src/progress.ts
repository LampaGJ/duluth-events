import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";

/**
 * @displayName Pollable progress heartbeat
 * @strategicPurpose The pipeline fetches 17 live sources and routinely runs past two minutes. Without
 *   a pollable snapshot the only way to know where it is mid-run is to block on it or grep a log
 *   stream, so a stalled source is indistinguishable from a slow one.
 * @tacticalObjective Write a latest-state JSON snapshot plus an append-only history, so run status
 *   can be read at any moment with a single file read and no coordination with the running process.
 *
 * This deliberately reimplements the shared heartbeat contract rather than importing the local
 * helper it mirrors: this file ships to CI, where an absolute path into a developer's home directory
 * does not exist. Same on-disk contract, no external dependency.
 */

export interface Progress {
  tick: (done: number, extra?: Record<string, unknown>) => void;
  done: (extra?: Record<string, unknown>) => void;
}

export function progress(job: string, opts: { total?: number } = {}): Progress {
  const dir = "reports/.progress";
  const startedAt = Date.now();
  mkdirSync(dir, { recursive: true });

  const write = (done: number, extra: Record<string, unknown>, finished: boolean) => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = elapsed > 0 ? done / elapsed : 0;
    const snap = {
      job,
      ts: new Date().toISOString(),
      done,
      total: opts.total,
      pct: opts.total ? Math.round((done / opts.total) * 100) : undefined,
      rate_per_s: Number(rate.toFixed(3)),
      eta_s: opts.total && rate > 0 ? Math.round((opts.total - done) / rate) : undefined,
      finished,
      ...extra,
    };
    const line = JSON.stringify(snap);
    // Snapshot is rewritten (latest state); history is appended (how it got there). A failed write
    // must never take the pipeline down with it — progress reporting is diagnostics, not the job.
    try {
      writeFileSync(`${dir}/${job}.json`, line + "\n");
      appendFileSync(`${dir}/${job}.jsonl`, line + "\n");
    } catch {
      /* diagnostics only */
    }
  };

  return {
    tick: (done, extra = {}) => write(done, extra, false),
    done: (extra = {}) => write(opts.total ?? 0, extra, true),
  };
}
