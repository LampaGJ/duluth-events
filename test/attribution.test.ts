import { describe, it, expect } from "vitest";
import { creditsFor } from "../src/attribution.js";
import { PLACES } from "../src/places.js";
import type { PlaceInput } from "../src/schema.js";

const place = (provenance: PlaceInput["provenance"], id = "x"): PlaceInput => ({
  id,
  name: "X",
  address: { city: "Duluth", state: "MN", inDuluth: true },
  provenance,
});

describe("attribution", () => {
  it("credits OpenStreetMap for an osm-sourced place", () => {
    const credits = creditsFor([place({ source: "osm", ref: "way/123456" })]);
    expect(credits.map((c) => c.key)).toEqual(["osm"]);
    expect(credits[0]!.text).toContain("OpenStreetMap");
  });

  it("collapses nominatim onto the OpenStreetMap credit rather than crediting it twice", () => {
    // Nominatim IS OpenStreetMap's geocoder; two refs, one licence, one line on the page.
    const credits = creditsFor([
      place({ source: "osm", ref: "way/1" }, "a"),
      place({ source: "osm", ref: "nominatim:Wussow's Concert Cafe, Duluth, MN" }, "b"),
    ]);
    expect(credits).toHaveLength(1);
    expect(credits[0]!.key).toBe("osm");
  });

  it("owes NO dataset credit for our own manual research", () => {
    // `manual` with a cited URL is a fact we read off a venue's own page — no dataset licence
    // attaches to it, and claiming one would misstate where the data came from.
    expect(creditsFor([place({ source: "manual", ref: "https://example.org/about" })])).toEqual([]);
    expect(creditsFor([place({ source: "manual" })])).toEqual([]);
  });

  it("does not mistake a https ref for a dataset named 'https'", () => {
    // The regex that finds `overture:` in a ref would otherwise match the scheme of any URL.
    expect(() => creditsFor([place({ source: "web", ref: "https://duluthmn.gov/parks" })])).not.toThrow();
    expect(creditsFor([place({ source: "web", ref: "https://duluthmn.gov/parks" })])).toEqual([]);
  });

  it("credits Overture the moment a place is registered from it", () => {
    // The whole point of deriving credits: no human has to remember to add this line later.
    const credits = creditsFor([place({ source: "manual", ref: "overture:08f2ab0123456789" })]);
    expect(credits.map((c) => c.key)).toEqual(["overture"]);
    expect(credits[0]!.text).toContain("Overture Maps Foundation");
    expect(credits[0]!.url).toBe("https://docs.overturemaps.org/attribution/");
  });

  it("throws rather than silently shipping an uncredited dataset", () => {
    // Missing attribution is an invisible licence violation; a failed build is a one-line fix.
    expect(() => creditsFor([place({ source: "manual", ref: "foursquare:abc123" }, "bad")])).toThrow(/unknown dataset "foursquare"/);
  });

  it("every place in the real registry resolves to a registered dataset", () => {
    // This is the guard that actually protects the live page: it fails the build if someone adds a
    // place citing a dataset nobody credited.
    expect(() => creditsFor(PLACES)).not.toThrow();
    expect(creditsFor(PLACES).length).toBeGreaterThan(0);
  });

  it("credits exactly the datasets the shipped registry actually uses — no more", () => {
    // Over-crediting is a false provenance claim, and under-crediting is a licence violation, so
    // this pins the set exactly. `overture` joined it on 2026-08-13: `decc` is the first shipping
    // place whose name, address and coordinates were read from the vendored Overture record, and
    // the line appeared on the public page with no change to attribution.ts — which is precisely
    // the behaviour the previous expectation was written to predict.
    expect(creditsFor(PLACES).map((c) => c.key)).toEqual(["homegrown", "osm", "overture"]);
  });
});
