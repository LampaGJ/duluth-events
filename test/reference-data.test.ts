import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrailsArtifactSchema, NeighborhoodsArtifactSchema } from "../src/schema.js";
import { loadTrails } from "../src/trails.js";
import { loadNeighborhoods } from "../src/neighborhoods.js";

const TRAILS_PATH = "data/duluth-trails.json";
const NEIGHBORHOODS_PATH = "data/duluth-neighborhoods.json";

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
});
