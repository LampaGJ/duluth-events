import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverturePlacesArtifactSchema, loadOverturePlaces } from "../src/overture.js";

const PATH = "data/overture-places.json";

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
  const dir = mkdtempSync(join(tmpdir(), "duluth-overture-test-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  tmpFiles.push(path);
  return path;
}

describe("OverturePlacesArtifactSchema — parses the real committed artifact", () => {
  const text = readFileSync(PATH, "utf8");
  const raw = JSON.parse(text);

  it("parses without throwing", () => {
    expect(() => OverturePlacesArtifactSchema.parse(raw)).not.toThrow();
  });

  it("recordCount matches places.length, and preFilterCount >= recordCount", () => {
    const parsed = OverturePlacesArtifactSchema.parse(raw);
    expect(parsed.recordCount).toBe(parsed.places.length);
    expect(parsed.places.length).toBeGreaterThan(0);
    expect(parsed.preFilterCount).toBeGreaterThanOrEqual(parsed.recordCount);
  });

  it("records are sorted by gersId (deterministic write order)", () => {
    const parsed = OverturePlacesArtifactSchema.parse(raw);
    const ids = parsed.places.map((p) => p.gersId);
    expect(ids).toEqual([...ids].sort());
  });

  it("every record's gersId is unique", () => {
    const parsed = OverturePlacesArtifactSchema.parse(raw);
    const ids = parsed.places.map((p) => p.gersId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every record carries a non-blank address.freeform (the addressless-point filter held)", () => {
    const parsed = OverturePlacesArtifactSchema.parse(raw);
    for (const p of parsed.places) {
      expect(p.address.freeform.trim().length).toBeGreaterThan(0);
    }
  });

  it("sourceWatermark equals releaseVersion (no wall-clock timestamp)", () => {
    const parsed = OverturePlacesArtifactSchema.parse(raw);
    expect(parsed.sourceWatermark).toBe(parsed.releaseVersion);
    expect(parsed.sourceWatermark).not.toMatch(/^\d{4}-\d{2}-\d{2}T/); // not an ISO instant
  });

  it("loadOverturePlaces() returns the same records the raw parse does", () => {
    const places = loadOverturePlaces(PATH);
    expect(places.length).toBe(OverturePlacesArtifactSchema.parse(raw).recordCount);
  });
});

describe("loadOverturePlaces fails fast on a malformed record", () => {
  it("throws when a record has an out-of-range confidence", () => {
    const good = OverturePlacesArtifactSchema.parse(JSON.parse(readFileSync(PATH, "utf8")));
    const broken = {
      ...good,
      places: [{ ...good.places[0]!, confidence: 1.5 }],
      recordCount: 1,
      preFilterCount: good.preFilterCount,
    };
    const path = writeTmpJson("bad-overture-confidence.json", broken);
    expect(() => loadOverturePlaces(path)).toThrow();
  });

  it("throws when gersId is missing entirely", () => {
    const good = OverturePlacesArtifactSchema.parse(JSON.parse(readFileSync(PATH, "utf8")));
    const { gersId: _drop, ...rest } = good.places[0]!;
    const broken = { ...good, places: [rest], recordCount: 1 };
    const path = writeTmpJson("bad-overture-no-gersid.json", broken);
    expect(() => loadOverturePlaces(path)).toThrow();
  });

  it("throws when recordCount disagrees with places.length (envelope invariant)", () => {
    const good = OverturePlacesArtifactSchema.parse(JSON.parse(readFileSync(PATH, "utf8")));
    const broken = { ...good, places: [good.places[0]!], recordCount: 2 };
    const path = writeTmpJson("bad-overture-count.json", broken);
    expect(() => loadOverturePlaces(path)).toThrow();
  });
});

/**
 * THE idempotency acceptance test, same discipline as test/reference-data.test.ts: parsing the
 * committed artifact and re-serializing it with the fetcher's exact writer convention
 * (`JSON.stringify(parsed, null, 2) + "\n"`) must reproduce the file byte-for-byte. This is what
 * `scripts/fetch-overture.mjs`'s SELECT-clause field order and `OverturePlaceSchema`'s field
 * declaration order are kept in lockstep FOR.
 */
describe("idempotency: parse -> re-serialize reproduces the committed file byte-for-byte", () => {
  it("data/overture-places.json", () => {
    const text = readFileSync(PATH, "utf8");
    const parsed = OverturePlacesArtifactSchema.parse(JSON.parse(text));
    const reserialized = JSON.stringify(parsed, null, 2) + "\n";
    expect(reserialized).toBe(text);
  });

  /**
   * Mutation-diagnostic proof, per project rule ("nineteen defects in this project's plan code have
   * been tests that looked like coverage and pinned nothing"): flip one field deep inside a real
   * record and confirm the SAME assertion above actually fails. If this test ever passed despite the
   * mutation, the byte-for-byte test above would be decorative, not load-bearing.
   */
  it("mutation check: a single flipped operatingStatus breaks the byte-for-byte assertion above", () => {
    const text = readFileSync(PATH, "utf8");
    const parsed = OverturePlacesArtifactSchema.parse(JSON.parse(text));
    const first = parsed.places[0]!;
    const mutated = {
      ...parsed,
      places: [{ ...first, operatingStatus: first.operatingStatus === "open" ? "permanently_closed" : "open" }, ...parsed.places.slice(1)],
    };
    const reserialized = JSON.stringify(mutated, null, 2) + "\n";
    expect(reserialized).not.toBe(text);
  });

  /** Second independent mutation target — a reordered array field (sourceDatasets) must also be
   *  caught, proving the byte-for-byte check isn't only sensitive to scalar fields. */
  it("mutation check: a reordered sourceDatasets array breaks the byte-for-byte assertion above", () => {
    const text = readFileSync(PATH, "utf8");
    const parsed = OverturePlacesArtifactSchema.parse(JSON.parse(text));
    const withMultiSource = parsed.places.find((p) => p.sourceDatasets.length > 1);
    expect(withMultiSource).toBeDefined();
    const mutatedRecord = { ...withMultiSource!, sourceDatasets: [...withMultiSource!.sourceDatasets].reverse() };
    const mutated = { ...parsed, places: parsed.places.map((p) => (p.gersId === mutatedRecord.gersId ? mutatedRecord : p)) };
    const reserialized = JSON.stringify(mutated, null, 2) + "\n";
    expect(reserialized).not.toBe(text);
  });
});
