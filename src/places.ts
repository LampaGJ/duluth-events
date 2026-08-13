import type { PlaceInput } from "./schema.js";

/**
 * The canonical venue registry — the SOURCE OF TRUTH for place identity.
 *
 * @displayName Place Registry
 * @strategicPurpose Place ids appear in feed URLs, so they must never move. This file is curated and
 *   committed: `scripts/places-propose.mjs` PROPOSES entries but never writes here. The human paste
 *   IS the id-stability guarantee, and every judgment is visible in a git diff.
 * @tacticalObjective Map every venue-string variant a source emits onto one stable id, with a
 *   canonical address used to enrich events whose source supplied none.
 *
 * Adding an entry:
 *   1. `npm run places:propose` — prints paste-ready literals with provenance and a similarity score
 *   2. VERIFY the match yourself. A geocoder's confident wrong answer looks exactly like data:
 *      "Restaurant 301" resolved to "Perkins", "Sioux Falls" to "South Duluth Avenue".
 *   3. Paste here. Aliases may be written readably — buildPlaceIndex normalizes them on load.
 *
 * Typed as `PlaceInput[]` (the Zod INPUT type, `z.input<typeof PlaceSchema>`), not `Place[]` (the
 * post-parse output type) — these are hand-authored literals, parsed for the first time inside
 * buildPlaceIndex. `nameAliases` / `addressAliases` / `rooms` all default to `[]` in PlaceSchema, so
 * an entry with none of those need not write them at all.
 *
 * Address data from OpenStreetMap is ODbL; attribution ships in the feed footer.
 */
export const PLACES: PlaceInput[] = [
  {
    id: "bent-paddle-taproom",
    name: "Bent Paddle Brewing Co. — Brewery + Taproom",
    nameAliases: [
      "Bent Paddle Brewing",
      "Bent Paddle Taproom",
      "Bent Paddle Taproom 1832 W Michigan St.",
      "Bent Paddle Taproom // 1832 W Michigan St. // Duluth",
    ],
    addressAliases: ["1832 W Michigan St", "1832 W Michigan St, Duluth, MN, United States, Minnesota 55806"],
    address: { street: "1832 W Michigan St", city: "Duluth", state: "MN", inDuluth: true },
    rooms: ["The Yard"],
    provenance: {
      source: "manual",
      ref: "corpus + nominatim; street taken from the corpus listing, not the OSM 1912 result — corroborated by homegrown:Bent Paddle Brewing Company Taproom (1832 W Michigan St, Duluth, MN 55806); address left unchanged",
    },
  },
  {
    id: "lake-superior-estuarium",
    name: "Lake Superior Estuarium",
    addressAliases: ["3 Marina Drive", "3 Marina Dr"],
    address: { street: "3 Marina Drive", city: "Superior", state: "WI", geo: { lat: 46.7221, lon: -92.063 }, inDuluth: false },
    provenance: { source: "osm", ref: "nominatim:Lake Superior Estuarium, Superior, WI" },
  },
  {
    id: "wussows-concert-cafe",
    name: "Wussow's Concert Cafe",
    addressAliases: ["324 N Central Ave", "324 North Central Avenue"],
    address: { street: "324 North Central Avenue", city: "Duluth", state: "MN", geo: { lat: 46.7386, lon: -92.1662 }, inDuluth: true },
    provenance: { source: "osm", ref: "nominatim:Wussow's Concert Cafe, Duluth, MN" },
  },
  // --- Task 9: agent-resolved registrations (see reports/places-review.md) ---
  //
  // Merged from two raw strings, 39 events. The proposer matched BOTH to OSM way/208442373 —
  // which is Lincoln Park, the actual city park, NOT the Duluth Art Institute building in the
  // Lincoln Park neighbourhood. The id and aliases are kept; the OSM address is deliberately
  // NOT, because it belongs to a different place. City-only until someone verifies the street.
  // "Lincoln Park" (the park, 2 events) is left provisional on purpose: in this corpus that
  // string denotes a park, a neighbourhood, and this building, and nothing disambiguates it.
  {
    id: "dai-lincoln-park-building",
    name: "Duluth Art Institute — Lincoln Park Building",
    nameAliases: [
      "Lincoln Park Building",
      "DAI Lincoln Park Building",
      "Duluth Art Institute (Lincoln Park Building)",
    ],
    address: { city: "Duluth", state: "MN", inDuluth: true },
    provenance: { source: "manual", ref: "corpus; NOT osm way/208442373, which is Lincoln Park the park" },
  },
  {
    id: "amsoil-arena",
    name: "Amsoil Arena",
    nameAliases: ["AMSOIL Arena"],
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7804826, lon: -92.0996513 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/335615637" },
  },
  {
    id: "james-s-malosky-stadium",
    name: "James S. Malosky Stadium",
    addressAliases: ["1336 University Drive"],
    address: { street: "1336 University Drive", city: "Duluth", state: "MN", geo: { lat: 46.8191743, lon: -92.0796453 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/1198638859" },
  },
  {
    id: "marshall-w-alworth-planetarium",
    name: "Marshall W. Alworth Planetarium",
    nameAliases: ["Marshall W. Alworth Planetarium (MWAP)", "UMD Marshall W. Alworth Planetarium"],
    address: { city: "Duluth", state: "MN", geo: { lat: 46.8161223, lon: -92.0871729 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/94559878" },
  },
  {
    id: "whole-foods-co-op-hillside",
    name: "Whole Foods Co-op — Hillside",
    nameAliases: ["Whole Foods Co-op – Hillside"],
    addressAliases: ["610 East 4th Street"],
    address: { street: "610 East 4th Street", city: "Duluth", state: "MN", geo: { lat: 46.7955203, lon: -92.094182 }, inDuluth: true },
    provenance: { source: "manual", ref: "node/2267838756" },
  },
  {
    id: "glensheen-mansion",
    name: "Glensheen Mansion",
    nameAliases: ["Glensheen Mansion (G)"],
    addressAliases: ["3300 London Road"],
    address: { street: "3300 London Road", city: "Duluth", state: "MN", geo: { lat: 46.8151593, lon: -92.0517438 }, inDuluth: true },
    provenance: { source: "manual", ref: "way/475455988" },
  },
  {
    id: "superior-public-library",
    name: "Superior Public Library",
    nameAliases: ["Superior Public Library, 1530 Tower Ave., Superior, WI, 54880, United States"],
    address: { city: "Superior", state: "WI", geo: { lat: 46.7197108, lon: -92.1032291 }, inDuluth: false },
    provenance: { source: "osm", ref: "node/367808853" },
  },
  // Human sign-off (Phase 3, place-entity-resolution): both corpus strings name the same building —
  // 9 events "Duluth Public Library – Main Library" (DAI) + 2 events "Duluth Public Library" (PDD),
  // previously two different provisional ids. Overture has no clean "Main Library" record for the
  // library itself — only "Duluth Library Foundation" (gersId 29ab8856-72f9-42bb-a070-f598ffd157db),
  // a co-located but DIFFERENT organization at the same address, whose GERS id is deliberately NOT
  // borrowed here. gersId omitted: no defensible match for the library entity. Also in Overture, NOT
  // registered here (different addresses, different buildings): "Duluth Public Library Mt Royal" (105
  // Mount Royal Shopping Cir, gers 3d91f4bc-c0c8-44e4-a06f-8d058c9b6517) and "West Duluth Public
  // Library" (5830 Grand Ave, gers eaabb31a-76a6-46ca-b805-7b82c4fe5751).
  {
    id: "duluth-public-library-main",
    name: "Duluth Public Library — Main Library",
    nameAliases: ["Duluth Public Library – Main Library", "Duluth Public Library"],
    address: { street: "520 W Superior St", city: "Duluth", state: "MN", inDuluth: true },
    provenance: {
      source: "manual",
      ref: "address corroborated by osm:way/450026905 (Duluth Public Library, 520 W Superior St) and " +
        "overture:Duluth Library Foundation (29ab8856-72f9-42bb-a070-f598ffd157db, same address; " +
        "Foundation is a distinct org housed in the Main Library building, not registered as this place)",
    },
  },
  {
    id: "chambers-grove-park",
    name: "Chambers Grove Park",
    addressAliases: ["13419 West 3rd Street"],
    address: { street: "13419 West 3rd Street", city: "Duluth", state: "MN", geo: { lat: 46.661157, lon: -92.2825187 }, inDuluth: true },
    provenance: { source: "osm", ref: "relation/20980491" },
  },
  {
    id: "sheraton-duluth-hotel",
    name: "Sheraton Duluth Hotel",
    addressAliases: ["311 East Superior Street"],
    address: { street: "311 East Superior Street", city: "Duluth", state: "MN", geo: { lat: 46.7902931, lon: -92.0944423 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/450027183" },
  },
  {
    id: "duluth-folk-school",
    name: "Duluth Folk School",
    addressAliases: ["1917 West Superior Street"],
    address: { street: "1917 West Superior Street", city: "Duluth", state: "MN", geo: { lat: 46.7684932, lon: -92.1227713 }, inDuluth: true },
    provenance: { source: "manual", ref: "node/12611686774" },
  },
  {
    id: "whole-foods-co-op-denfeld",
    name: "Whole Foods Co-op — Denfeld",
    nameAliases: ["Whole Foods Co-op – Denfeld"],
    addressAliases: ["4426 Grand Avenue"],
    address: { street: "4426 Grand Avenue", city: "Duluth", state: "MN", geo: { lat: 46.7466211, lon: -92.1569992 }, inDuluth: true },
    provenance: { source: "manual", ref: "node/7020804947" },
  },
  {
    id: "massari-arena",
    name: "Massari Arena",
    nameAliases: ["Massari Arena (PE)"],
    address: { street: "Bartley Boulevard", city: "Pueblo", state: "CO", geo: { lat: 38.309303, lon: -104.5754996 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/480276785" },
  },
  {
    id: "sanford-center",
    name: "Sanford Center",
    addressAliases: ["1111 Event Center Drive Northeast"],
    address: { street: "1111 Event Center Drive Northeast", city: "Bemidji", state: "MN", geo: { lat: 47.4635217, lon: -94.8533435 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/170132265" },
  },
  {
    id: "wisconsin-point",
    name: "Wisconsin Point",
    nameAliases: ["Wisconsin Point, Superior WI"],
    address: { city: "Superior", state: "WI", geo: { lat: 46.6934576, lon: -91.9883277 }, inDuluth: false },
    provenance: { source: "osm", ref: "relation/12118654" },
  },
  {
    id: "bayfront-festival-park",
    name: "Bayfront Festival Park",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7785829, lon: -92.1020758 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/335612432" },
  },
  {
    id: "brighton-beach-park",
    name: "Brighton Beach Park",
    nameAliases: ["Brighton Beach (Kitchi Gammi)"],
    address: { city: "Duluth", state: "MN", geo: { lat: 46.8414809, lon: -91.9963446 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/516733271" },
  },
  {
    id: "ed-robson-arena",
    name: "Ed Robson Arena",
    addressAliases: ["849 North Tejon Street"],
    address: { street: "849 North Tejon Street", city: "Colorado Springs", state: "CO", geo: { lat: 38.8461172, lon: -104.8219947 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/962415373" },
  },
  {
    id: "gutterson-fieldhouse",
    name: "Gutterson Fieldhouse",
    addressAliases: ["60 Davis Road"],
    address: { street: "60 Davis Road", city: "Burlington", state: "VT", geo: { lat: 44.4693164, lon: -73.1944671 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/235380994" },
  },
  {
    id: "herb-brooks-national-hockey-center",
    name: "Herb Brooks National Hockey Center",
    addressAliases: ["1 Herb Brooks Way"],
    address: { street: "1 Herb Brooks Way", city: "Saint Cloud", state: "MN", geo: { lat: 45.5467254, lon: -94.1521912 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/310010291" },
  },
  {
    id: "labahn-arena",
    name: "LaBahn Arena",
    address: { street: "East Campus Mall", city: "Madison", state: "WI", geo: { lat: 43.0697714, lon: -89.3985559 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/193494687" },
  },
  {
    id: "mdu-resources-community-bowl",
    name: "MDU Resources Community Bowl",
    addressAliases: ["1701 Canary Avenue"],
    address: { street: "1701 Canary Avenue", city: "Bismarck", state: "ND", geo: { lat: 46.8220445, lon: -100.8215332 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/867792017" },
  },
  {
    id: "midco-arena",
    name: "Midco Arena",
    address: { street: "West 33rd Street", city: "Sioux Falls", state: "SD", geo: { lat: 43.5215648, lon: -96.7402299 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/1328539990" },
  },
  {
    id: "mullett-arena",
    name: "Mullett Arena",
    addressAliases: ["411 South Packard Drive"],
    address: { street: "411 South Packard Drive", city: "Tempe", state: "AZ", geo: { lat: 33.426643, lon: -111.9284887 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/1125289643" },
  },
  {
    id: "northern-waters-smokehaus",
    name: "Northern Waters Smokehaus",
    addressAliases: ["394 Lake Avenue South"],
    address: { street: "394 Lake Avenue South", city: "Duluth", state: "MN", geo: { lat: 46.7818773, lon: -92.094579 }, inDuluth: true },
    provenance: { source: "osm", ref: "node/1489708269" },
  },
  {
    id: "pier-b-resort-hotel",
    name: "Pier B Resort Hotel",
    nameAliases: ["Pier B Resort"],
    addressAliases: ["800 West Railroad Street"],
    address: { street: "800 West Railroad Street", city: "Duluth", state: "MN", geo: { lat: 46.7765579, lon: -92.1033367 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/947737006" },
  },
  {
    id: "ralph-engelstad-arena",
    name: "Ralph Engelstad Arena",
    addressAliases: ["10th Avenue North"],
    address: { street: "10th Avenue North", city: "Grand Forks", state: "ND", geo: { lat: 47.9277802, lon: -97.071572 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/78483351" },
  },
  {
    id: "the-caddy-shack-indoor-golf-pub",
    name: "The Caddy Shack Indoor Golf & Pub",
    nameAliases: ["Caddy Shack"],
    addressAliases: ["2023 West Superior Street"],
    address: { street: "2023 West Superior Street", city: "Duluth", state: "MN", geo: { lat: 46.76737, lon: -92.1240144 }, inDuluth: true },
    provenance: { source: "osm", ref: "node/8576355164" },
  },
  {
    id: "weber-music-hall",
    name: "Weber Music Hall (WMH)",
    addressAliases: ["1151 University Drive"],
    address: { street: "1151 University Drive", city: "Duluth", state: "MN", geo: { lat: 46.8182481, lon: -92.0831011 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/94502287" },
  },
  {
    id: "wild-state-cider",
    name: "Wild State Cider",
    addressAliases: ["2515 West Superior Street"],
    address: { street: "2515 West Superior Street", city: "Duluth", state: "MN", geo: { lat: 46.7629144, lon: -92.1302147 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/636708464" },
  },
  {
    id: "alex-nemzek-soccer-field",
    name: "Alex Nemzek Soccer Field",
    nameAliases: ["Nemzek Soccer Field"],
    addressAliases: ["5th Avenue South"],
    address: { street: "5th Avenue South", city: "Moorhead", state: "MN", geo: { lat: 46.868761, lon: -96.7511773 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/186358928" },
  },
  {
    id: "alex-nemzek-stadium",
    name: "Alex Nemzek Stadium",
    addressAliases: ["6th Avenue Southeast"],
    address: { street: "6th Avenue Southeast", city: "Moorhead", state: "MN", geo: { lat: 46.8670381, lon: -96.7507687 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/912955853" },
  },
  {
    id: "barnett-center",
    name: "Barnett Center",
    addressAliases: ["15th Avenue Southeast"],
    address: { street: "15th Avenue Southeast", city: "Aberdeen", state: "SD", geo: { lat: 45.4496728, lon: -98.4804285 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/248419952" },
  },
  {
    id: "bennett-park",
    name: "Bennett Park",
    address: { city: "Hibbing", state: "MN", geo: { lat: 47.4340531, lon: -92.9366747 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/492422555" },
  },
  {
    id: "big-top-chautauqua",
    name: "Big Top Chautauqua",
    address: { street: "Ski Hill Road", city: "Town of Bayfield", state: "WI", geo: { lat: 46.7766225, lon: -90.8939238 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/945296491" },
  },
  {
    id: "carl-gullo-park",
    name: "Carl Gullo Park",
    nameAliases: ["Carl Cullo Park"],
    addressAliases: ["510 26th Avenue East"],
    address: { street: "510 26th Avenue East", city: "Superior", state: "WI", geo: { lat: 46.7009127, lon: -92.0457331 }, inDuluth: false },
    provenance: { source: "osm", ref: "way/459275747" },
  },
  {
    id: "chet-anderson-stadium",
    name: "Chet Anderson Stadium",
    addressAliases: ["1514 Birchmont Drive Northeast"],
    address: { street: "1514 Birchmont Drive Northeast", city: "Bemidji", state: "MN", geo: { lat: 47.4838477, lon: -94.8719135 }, inDuluth: false },
    provenance: { source: "manual", ref: "relation/19059359" },
  },
  {
    id: "duluth-heights-park",
    name: "Duluth Heights Park",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.8064585, lon: -92.1337386 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/1154050228" },
  },
  {
    id: "elmen-center",
    name: "Elmen Center",
    address: { street: "West 33rd Street", city: "Sioux Falls", state: "SD", geo: { lat: 43.5218053, lon: -96.7421082 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/302324929" },
  },
  {
    id: "enger-tower",
    name: "Enger Tower",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7761105, lon: -92.1249586 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/206457171" },
  },
  {
    id: "fond-du-lac-tribal-and-community-college",
    name: "Fond du Lac Tribal and Community College",
    addressAliases: ["2101 14th Street"],
    address: { street: "2101 14th Street", city: "Cloquet", state: "MN", geo: { lat: 46.6899868, lon: -92.4525124 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/37690352" },
  },
  {
    id: "gangelhoff-center",
    name: "Gangelhoff Center",
    address: { street: "North Hamline Avenue", city: "Saint Paul", state: "MN", geo: { lat: 44.9479883, lon: -93.1577485 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/307757184" },
  },
  {
    id: "great-lakes-aquarium",
    name: "Great Lakes Aquarium",
    addressAliases: ["353 Harbor Drive"],
    address: { street: "353 Harbor Drive", city: "Duluth", state: "MN", geo: { lat: 46.7789702, lon: -92.1001071 }, inDuluth: true },
    provenance: { source: "manual", ref: "way/167029140" },
  },
  {
    id: "harrison-park",
    name: "Harrison Park",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7603474, lon: -92.1382112 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/583984800" },
  },
  {
    id: "heikkila-hcams",
    name: "Heikkila Chemistry and Advanced Materials Science",
    nameAliases: ["Heikkila Chemistry and Advanced Materials Science (HCAMS)"],
    addressAliases: ["1038 University Drive"],
    address: { street: "1038 University Drive", city: "Duluth", state: "MN", geo: { lat: 46.8162581, lon: -92.0849683 }, inDuluth: true },
    provenance: { source: "manual", ref: "way/664678875" },
  },
  {
    id: "husky-stadium",
    name: "Husky Stadium",
    addressAliases: ["1111 3rd Avenue South"],
    address: { street: "1111 3rd Avenue South", city: "Saint Cloud", state: "MN", geo: { lat: 45.547694, lon: -94.1508726 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/148596765" },
  },
  {
    id: "leif-erikson-park",
    name: "Leif Erikson Park",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7962389, lon: -92.0831065 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/48557946" },
  },
  {
    id: "mcfarland-park",
    name: "McFarland Park",
    address: { city: "Carlton", state: "MN", geo: { lat: 46.6639852, lon: -92.430785 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/458391482" },
  },
  {
    id: "merritt-park",
    name: "Merritt Park",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7542337, lon: -92.1565992 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/583984796" },
  },
  {
    id: "morgan-park",
    name: "Morgan Park",
    addressAliases: ["1302 88th Avenue West"],
    address: { street: "1302 88th Avenue West", city: "Duluth", state: "MN", geo: { lat: 46.6874372, lon: -92.2093239 }, inDuluth: true },
    provenance: { source: "osm", ref: "relation/20976839" },
  },
  {
    id: "observation-park",
    name: "Observation Park",
    nameAliases: ["Observation Park - Field"],
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7796711, lon: -92.1126557 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/583984817" },
  },
  {
    id: "olcott-park",
    name: "Olcott Park",
    address: { city: "Virginia", state: "MN", geo: { lat: 47.5289881, lon: -92.5501363 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/146999258" },
  },
  {
    id: "piedmont-community-center",
    name: "Piedmont Community Center",
    nameAliases: ["Piedmont Community Recreation Center"],
    addressAliases: ["2302 West 23rd Street"],
    address: { street: "2302 West 23rd Street", city: "Duluth", state: "MN", geo: { lat: 46.7802511, lon: -92.1516893 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/1306967700" },
  },
  {
    id: "pizza-luce",
    name: "Pizza Lucé",
    addressAliases: ["11 East Superior Street"],
    address: { street: "11 East Superior Street", city: "Duluth", state: "MN", geo: { lat: 46.7871473, lon: -92.0982094 }, inDuluth: true },
    provenance: { source: "osm", ref: "node/2611363182" },
  },
  {
    id: "portland-square",
    name: "Portland Square",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7999954, lon: -92.0900613 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/48572684" },
  },
  {
    id: "rathskeller",
    name: "Rathskeller",
    nameAliases: ["The Rathskeller"],
    addressAliases: ["299 E Michigan st"],
    address: { street: "299 E Michigan st", city: "Duluth", state: "MN", geo: { lat: 46.7884758, lon: -92.0953754 }, inDuluth: true },
    provenance: { source: "osm", ref: "node/6520745662" },
  },
  {
    id: "rice-auditorium",
    name: "Rice Auditorium",
    address: { street: "Lindahl Drive", city: "Wayne", state: "NE", geo: { lat: 42.2431413, lon: -97.0166373 }, inDuluth: false },
    provenance: { source: "manual", ref: "node/366491594" },
  },
  {
    id: "sea-foam-stadium",
    name: "Sea Foam Stadium",
    address: { street: "Concordia Avenue", city: "Saint Paul", state: "MN", geo: { lat: 44.9504034, lon: -93.1581235 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/183869029" },
  },
  {
    id: "second-harvest-northland",
    name: "Second Harvest Northland",
    addressAliases: ["2302 Commonwealth Avenue"],
    address: { street: "2302 Commonwealth Avenue", city: "Duluth", state: "MN", geo: { lat: 46.6798808, lon: -92.2255148 }, inDuluth: true },
    provenance: { source: "manual", ref: "node/13938459157" },
  },
  {
    id: "sir-benedicts-tavern-on-the-lake",
    name: "Sir Benedict's Tavern on the Lake",
    nameAliases: ["Sir Benedict’s Tavern on the Lake"],
    // "805 E Superior St Duluth" (3 events, left provisional in Task 9 as unverified) is this venue's
    // corpus street address, per Homegrown's `address` field for "Sir Benedict's Tavern on the Lake"
    // (data/homegrown-venues.json) — confirms the proposer's earlier WEAK/TIED guess of the
    // Duluth-Superior Friends Meeting was wrong.
    addressAliases: ["805 East Superior Street", "805 E Superior St Duluth"],
    address: { street: "805 East Superior Street", city: "Duluth", state: "MN", geo: { lat: 46.7948942, lon: -92.0883328 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/745160361" },
  },
  {
    id: "split-rock-lighthouse",
    name: "Split Rock Lighthouse",
    address: { street: "Little Two Harbors Trail", city: "Beaver Bay Township", state: "MN", geo: { lat: 47.2000961, lon: -91.3670173 }, inDuluth: false },
    provenance: { source: "manual", ref: "way/390175205" },
  },
  {
    id: "ss-william-a-irvin",
    name: "SS William A. Irvin",
    nameAliases: ["William A. Irvin Museum"],
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7827937, lon: -92.0972273 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/170788432" },
  },
  {
    id: "wade-stadium",
    name: "Wade Stadium",
    address: { city: "Duluth", state: "MN", geo: { lat: 46.7542675, lon: -92.1438591 }, inDuluth: true },
    provenance: { source: "osm", ref: "way/38404087" },
  },
  {
    id: "webster-park",
    name: "Webster Park",
    address: { city: "Superior", state: "WI", geo: { lat: 46.6701194, lon: -92.1035181 }, inDuluth: false },
    provenance: { source: "osm", ref: "way/438913638" },
  },
  {
    id: "zeitgeist-teatro-zuccone",
    name: "Zeitgeist Teatro Zuccone",
    nameAliases: ["Zeitgeist Teatro"],
    addressAliases: ["222 East Superior Street"],
    address: { street: "222 East Superior Street", city: "Duluth", state: "MN", geo: { lat: 46.789328, lon: -92.0946193 }, inDuluth: true },
    provenance: { source: "manual", ref: "way/450102681" },
  },
  {
    id: "zenith-bookstore",
    name: "Zenith Bookstore",
    addressAliases: ["318 North Central Avenue"],
    address: { street: "318 North Central Avenue", city: "Duluth", state: "MN", geo: { lat: 46.7383439, lon: -92.1661835 }, inDuluth: true },
    provenance: { source: "manual", ref: "way/874210411" },
  },
  // --- Task 9b: TIER-0 Homegrown-resolved registrations (see reports/places-review.md) ---
  //
  // data/homegrown-venues.json (LampaGJ/duluth-homegrown-map, first-party curated Duluth-area music
  // venues) added as TIER 0 in scripts/places-propose.mjs, checked before the OSM cache. Every entry
  // below matched sim=1.0 (exact name, except Chester Bowl Park at 0.5), untied, no id collision —
  // exactly the venues OSM's machine-tagged extract either lacked or handled worse.
  {
    id: "spirit-of-the-lake-community-arts",
    name: "Spirit of the Lake Community Arts",
    addressAliases: ["5401 E Superior St"],
    address: { street: "5401 E Superior St", city: "Duluth", state: "MN", geo: { lat: 46.836579604547, lon: -92.015789835914 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Spirit of the Lake Community Arts" },
  },
  {
    id: "sacred-heart-music-center",
    name: "Sacred Heart Music Center",
    addressAliases: ["201 W 4th St"],
    address: { street: "201 W 4th St", city: "Duluth", state: "MN", geo: { lat: 46.787692520158, lon: -92.105160925143 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Sacred Heart Music Center" },
  },
  {
    id: "carmody-irish-pub",
    name: "Carmody Irish Pub",
    addressAliases: ["308 E Superior St"],
    address: { street: "308 E Superior St", city: "Duluth", state: "MN", geo: { lat: 46.789843285431, lon: -92.094266192385 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Carmody Irish Pub" },
  },
  {
    id: "lake-superior-zoo",
    name: "Lake Superior Zoo",
    addressAliases: ["7210 Fremont St"],
    address: { street: "7210 Fremont St", city: "Duluth", state: "MN", geo: { lat: 46.726102758099, lon: -92.189541282372 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Lake Superior Zoo" },
  },
  {
    id: "blacklist-brewing-company",
    name: "Blacklist Brewing Company",
    addressAliases: ["206 E Superior St"],
    address: { street: "206 E Superior St", city: "Duluth", state: "MN", geo: { lat: 46.788905821481, lon: -92.095530643692 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Blacklist Brewing Company" },
  },
  {
    id: "dubh-linn-irish-pub",
    name: "Dubh Linn Irish Pub",
    addressAliases: ["109 W Superior St"],
    address: { street: "109 W Superior St", city: "Duluth", state: "MN", geo: { lat: 46.785920458056, lon: -92.099647079258 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Dubh Linn Irish Pub" },
  },
  {
    id: "duluth-flame-nightclub",
    name: "Duluth Flame Nightclub",
    nameAliases: ["Flame Nightclub Duluth"],
    addressAliases: ["28 N 1st Ave W"],
    address: { street: "28 N 1st Ave W", city: "Duluth", state: "MN", geo: { lat: 46.786240293161, lon: -92.099719402185 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Duluth Flame Nightclub" },
  },
  {
    id: "ritual-marketplace",
    name: "Ritual Marketplace",
    addressAliases: ["1323 Broadway St"],
    address: { street: "1323 Broadway St", city: "Superior", state: "WI", geo: { lat: 46.726653970121, lon: -92.096711820575 }, inDuluth: false },
    provenance: { source: "manual", ref: "homegrown:Ritual Marketplace" },
  },
  {
    id: "chester-bowl-park",
    name: "Chester Bowl Park",
    nameAliases: ["Chester Bowl Park, 1801 E Skyline Parkway"],
    addressAliases: ["1800 E Skyline Pkwy"],
    address: { street: "1800 E Skyline Pkwy", city: "Duluth", state: "MN", geo: { lat: 46.812726321548, lon: -92.09157600947 }, inDuluth: true },
    provenance: { source: "manual", ref: "homegrown:Chester Bowl Park" },
  },
];
