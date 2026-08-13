import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrailsArtifactSchema, NeighborhoodsArtifactSchema, TrailConditionsArtifactSchema } from "../src/schema.js";
import { loadTrails } from "../src/trails.js";
import { loadNeighborhoods } from "../src/neighborhoods.js";
import { loadTrailConditions } from "../src/trail-conditions.js";

const TRAILS_PATH = "data/duluth-trails.json";
const NEIGHBORHOODS_PATH = "data/duluth-neighborhoods.json";
const TRAIL_CONDITIONS_PATH = "data/trail-conditions.json";

const tmpFiles: string[] = [];
afterEach(() => {
  while (tmpFiles.length) {
    const f = tmpFiles.pop()!;
    try {
      unlinkSync(f);
    } catch {
      // already gone — fine
    }
  }
});

function writeTmpJson(name: string, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "duluth-arcgis-test-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  tmpFiles.push(path);
  return path;
}

describe("TrailsArtifactSchema — parses the real committed artifact", () => {
  const text = readFileSync(TRAILS_PATH, "utf8");
  const raw = JSON.parse(text);

  it("parses without throwing", () => {
    expect(() => TrailsArtifactSchema.parse(raw)).not.toThrow();
  });

  it("recordCount matches trails.length", () => {
    const parsed = TrailsArtifactSchema.parse(raw);
    expect(parsed.recordCount).toBe(parsed.trails.length);
    expect(parsed.trails.length).toBeGreaterThan(0);
  });

  it("every trail carries all 8 uses and a valid season", () => {
    const parsed = TrailsArtifactSchema.parse(raw);
    for (const t of parsed.trails) {
      expect(t.uses).toHaveLength(8);
      expect(["summer", "winter", "both"]).toContain(t.season);
    }
  });

  it("records are sorted by id (deterministic write order)", () => {
    const parsed = TrailsArtifactSchema.parse(raw);
    const ids = parsed.trails.map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("loadTrails() returns the same records the raw parse does", () => {
    const trails = loadTrails(TRAILS_PATH);
    expect(trails.length).toBe(TrailsArtifactSchema.parse(raw).recordCount);
  });
});

describe("NeighborhoodsArtifactSchema — parses the real committed artifact", () => {
  const text = readFileSync(NEIGHBORHOODS_PATH, "utf8");
  const raw = JSON.parse(text);

  it("parses without throwing, and recordCount matches", () => {
    const parsed = NeighborhoodsArtifactSchema.parse(raw);
    expect(parsed.recordCount).toBe(parsed.neighborhoods.length);
    expect(parsed.recordCount).toBe(31);
  });

  it("loadNeighborhoods() round-trips through the loader", () => {
    const neighborhoods = loadNeighborhoods(NEIGHBORHOODS_PATH);
    expect(neighborhoods.length).toBe(31);
    expect(neighborhoods.every((n) => n.name.length > 0)).toBe(true);
  });
});

describe("TrailConditionsArtifactSchema — parses the real committed artifact", () => {
  const text = readFileSync(TRAIL_CONDITIONS_PATH, "utf8");
  const raw = JSON.parse(text);

  it("parses without throwing", () => {
    expect(() => TrailConditionsArtifactSchema.parse(raw)).not.toThrow();
  });

  it("recordCount matches trailConditions.length, and every discovered key produced a record", () => {
    const parsed = TrailConditionsArtifactSchema.parse(raw);
    expect(parsed.recordCount).toBe(parsed.trailConditions.length);
    expect(parsed.trailConditions.length).toBeGreaterThan(0);
    expect(parsed.keys.length).toBeGreaterThan(0);
    // Every trailCondition's own embedKey must be one of the discovered keys — the envelope's
    // `keys` list and the records it produced must not silently diverge.
    const keySet = new Set(parsed.keys);
    for (const c of parsed.trailConditions) {
      expect(keySet.has(c.embedKey)).toBe(true);
    }
  });

  it("`keys` is sorted (deterministic write order)", () => {
    const parsed = TrailConditionsArtifactSchema.parse(raw);
    expect(parsed.keys).toEqual([...parsed.keys].sort());
  });

  it("records are sorted by embedKey (deterministic write order)", () => {
    const parsed = TrailConditionsArtifactSchema.parse(raw);
    const keys = parsed.trailConditions.map((c) => c.embedKey);
    expect(keys).toEqual([...keys].sort());
  });

  it("loadTrailConditions() returns the same records the raw parse does", () => {
    const conditions = loadTrailConditions(TRAIL_CONDITIONS_PATH);
    expect(conditions.length).toBe(TrailConditionsArtifactSchema.parse(raw).recordCount);
  });
});

describe("loaders fail fast on a malformed record", () => {
  it("loadTrails throws when a record has an invalid season", () => {
    const good = TrailsArtifactSchema.parse(JSON.parse(readFileSync(TRAILS_PATH, "utf8")));
    const broken = {
      ...good,
      trails: [{ ...good.trails[0], season: "autumn" }], // not in the enum
      recordCount: 1,
    };
    const path = writeTmpJson("bad-trails-season.json", broken);
    expect(() => loadTrails(path)).toThrow();
  });

  it("loadTrails throws when GlobalID (id) is missing entirely", () => {
    const good = TrailsArtifactSchema.parse(JSON.parse(readFileSync(TRAILS_PATH, "utf8")));
    const { id: _drop, ...rest } = good.trails[0]!;
    const broken = { ...good, trails: [rest], recordCount: 1 };
    const path = writeTmpJson("bad-trails-no-id.json", broken);
    expect(() => loadTrails(path)).toThrow();
  });

  it("loadTrails throws when recordCount disagrees with trails.length (envelope invariant)", () => {
    const good = TrailsArtifactSchema.parse(JSON.parse(readFileSync(TRAILS_PATH, "utf8")));
    const broken = { ...good, trails: [good.trails[0]!], recordCount: 2 };
    const path = writeTmpJson("bad-trails-count.json", broken);
    expect(() => loadTrails(path)).toThrow();
  });

  it("loadNeighborhoods throws on a malformed record (missing name)", () => {
    const good = NeighborhoodsArtifactSchema.parse(JSON.parse(readFileSync(NEIGHBORHOODS_PATH, "utf8")));
    const { name: _drop, ...rest } = good.neighborhoods[0]!;
    const broken = { ...good, neighborhoods: [rest], recordCount: 1 };
    const path = writeTmpJson("bad-neighborhoods.json", broken);
    expect(() => loadNeighborhoods(path)).toThrow();
  });

  it("loadTrailConditions throws when a record is missing trailStatus", () => {
    const good = TrailConditionsArtifactSchema.parse(JSON.parse(readFileSync(TRAIL_CONDITIONS_PATH, "utf8")));
    const { trailStatus: _drop, ...rest } = good.trailConditions[0]!;
    const broken = { ...good, trailConditions: [rest], recordCount: 1, keys: [good.trailConditions[0]!.embedKey] };
    const path = writeTmpJson("bad-trail-conditions-no-status.json", broken);
    expect(() => loadTrailConditions(path)).toThrow();
  });

  it("loadTrailConditions throws when embedKey is missing entirely", () => {
    const good = TrailConditionsArtifactSchema.parse(JSON.parse(readFileSync(TRAIL_CONDITIONS_PATH, "utf8")));
    const { embedKey: _drop, ...rest } = good.trailConditions[0]!;
    const broken = { ...good, trailConditions: [rest], recordCount: 1, keys: [] };
    const path = writeTmpJson("bad-trail-conditions-no-embedkey.json", broken);
    expect(() => loadTrailConditions(path)).toThrow();
  });

  it("loadTrailConditions throws when recordCount disagrees with trailConditions.length (envelope invariant)", () => {
    const good = TrailConditionsArtifactSchema.parse(JSON.parse(readFileSync(TRAIL_CONDITIONS_PATH, "utf8")));
    const broken = { ...good, trailConditions: [good.trailConditions[0]!], recordCount: 2 };
    const path = writeTmpJson("bad-trail-conditions-count.json", broken);
    expect(() => loadTrailConditions(path)).toThrow();
  });

  it("loadTrailConditions throws when last24Precip is the wrong type (schema-drift tripwire)", () => {
    const good = TrailConditionsArtifactSchema.parse(JSON.parse(readFileSync(TRAIL_CONDITIONS_PATH, "utf8")));
    const broken = {
      ...good,
      trailConditions: [{ ...good.trailConditions[0]!, last24Precip: "0.1" }], // string, not number
      recordCount: 1,
      keys: [good.trailConditions[0]!.embedKey],
    };
    const path = writeTmpJson("bad-trail-conditions-precip-type.json", broken);
    expect(() => loadTrailConditions(path)).toThrow();
  });
});

/**
 * THE idempotency acceptance test: parsing the committed artifact and re-serializing it with the
 * exact writer convention (`JSON.stringify(parsed, null, 2) + "\n"`) must reproduce the file
 * byte-for-byte. This is what `scripts/fetch-arcgis.mjs`'s object-construction order and
 * TrailSchema/NeighborhoodSchema's field-declaration order are kept in lockstep FOR — see the
 * comment block above those schemas in src/schema.ts. If either drifts, this test catches it: Zod
 * rebuilds object output in SCHEMA field order, not input order (verified empirically — see the
 * task report), so a reordered schema field would silently reorder the re-serialized JSON even
 * though every individual value still parses correctly.
 */
describe("idempotency: parse -> re-serialize reproduces the committed file byte-for-byte", () => {
  it("data/duluth-trails.json", () => {
    const text = readFileSync(TRAILS_PATH, "utf8");
    const parsed = TrailsArtifactSchema.parse(JSON.parse(text));
    const reserialized = JSON.stringify(parsed, null, 2) + "\n";
    expect(reserialized).toBe(text);
  });

  it("data/duluth-neighborhoods.json", () => {
    const text = readFileSync(NEIGHBORHOODS_PATH, "utf8");
    const parsed = NeighborhoodsArtifactSchema.parse(JSON.parse(text));
    const reserialized = JSON.stringify(parsed, null, 2) + "\n";
    expect(reserialized).toBe(text);
  });

  it("data/trail-conditions.json", () => {
    const text = readFileSync(TRAIL_CONDITIONS_PATH, "utf8");
    const parsed = TrailConditionsArtifactSchema.parse(JSON.parse(text));
    const reserialized = JSON.stringify(parsed, null, 2) + "\n";
    expect(reserialized).toBe(text);
  });

  /**
   * Mutation-diagnostic proof, per project rule ("seventeen defects in this project's plan code
   * have been tests that looked like coverage and pinned nothing"): flip one boolean deep inside a
   * real record and confirm the SAME assertion above actually fails. If this test ever passed
   * despite the mutation, the byte-for-byte tests above would be decorative, not load-bearing.
   */
  it("mutation check: a single flipped field breaks the byte-for-byte assertion above", () => {
    const text = readFileSync(TRAILS_PATH, "utf8");
    const parsed = TrailsArtifactSchema.parse(JSON.parse(text));
    const firstTrail = parsed.trails[0]!;
    const firstUse = firstTrail.uses[0]!;
    const mutated = {
      ...parsed,
      trails: [{ ...firstTrail, uses: [{ ...firstUse, permitted: !firstUse.permitted }, ...firstTrail.uses.slice(1)] }, ...parsed.trails.slice(1)],
    };
    const reserialized = JSON.stringify(mutated, null, 2) + "\n";
    expect(reserialized).not.toBe(text);
  });

  /**
   * Same mutation-diagnostic proof for the trail-conditions artifact specifically (not just
   * inherited coverage from the trails.json test above) — flip `trailStatus` on the first record
   * and confirm the byte-for-byte assertion for data/trail-conditions.json actually fails.
   */
  it("mutation check: a single flipped trailStatus breaks the trail-conditions byte-for-byte assertion", () => {
    const text = readFileSync(TRAIL_CONDITIONS_PATH, "utf8");
    const parsed = TrailConditionsArtifactSchema.parse(JSON.parse(text));
    const first = parsed.trailConditions[0]!;
    const mutated = {
      ...parsed,
      trailConditions: [{ ...first, trailStatus: `${first.trailStatus}-MUTATED` }, ...parsed.trailConditions.slice(1)],
    };
    const reserialized = JSON.stringify(mutated, null, 2) + "\n";
    expect(reserialized).not.toBe(text);
  });
});
