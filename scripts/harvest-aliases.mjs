/**
 * Harvest real-world venue-string variants observed in the live corpus for every REGISTERED place,
 * and flag any that are NOT already listed in that place's `nameAliases`/`addressAliases`. PRINTS
 * (writes a report) ONLY — never touches src/places.ts. Same discipline as scripts/places-propose.mjs:
 * the human paste is the id-stability guarantee, and every judgment stays visible in a git diff.
 *
 * The point is a feedback loop: real observed spellings accumulate into the registry over time,
 * instead of being guessed.
 *
 * Usage: npx tsx scripts/harvest-aliases.mjs
 *
 * Why this runs the LIVE pipeline instead of taking a `<feed.ics>` argument like places-propose.mjs
 * does: a built .ics feed cannot answer this question for a REGISTERED place. `emitFeed` writes
 * `X-PLACE-NAME`/LOCATION as the place's CANONICAL name once resolution succeeds (src/emit.ts) — the
 * raw variant string that actually fed the match is gone by the time the feed exists. The one place
 * `venueRaw` (the raw source text) and `place` (the resolved registry entry) still live on the SAME
 * object together is the in-memory `DuluthEvent`, before `emitFeed` ever runs — `finalizeEvent`
 * (src/classify.ts) spreads `...e` (keeping `venueRaw`) while adding `place`, and `dedupe` (src/
 * dedupe.ts) does the same on its primary. So this script calls `runPipeline()` directly, the exact
 * function `src/cli.ts` calls to build the feed, and reads both fields off its output before they'd
 * be flattened into one canonical string.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { progress } from "/Users/graham/.claude/lib/progress.mjs";
import { runPipeline } from "../src/pipeline.js";
import { PLACE_INDEX } from "../src/place-registry.js";
import { normalizeVenueKey, parseVenueString } from "../src/place-resolve.js";
import { cleanText, unescapeIcsText } from "../src/normalize.js";

const p = progress("harvest-aliases", { total: null });
p.log({ phase: "fetching sources" });
const { events, stats } = await runPipeline();
p.log({ phase: "sources fetched", fetchedTotal: stats.fetchedTotal, merged: stats.merged, failures: stats.failures });

/** Human-readable display form of a raw venue string — same cleanup order as normalizeVenueKey's own. */
const displayRaw = (raw) => cleanText(unescapeIcsText(raw));

// --- group every distinct raw venue string by the REGISTERED place id it resolved to ---
// Mirror resolvePlace's OWN two-key lookup (src/place-registry.ts): it matches primarily on
// normalizeVenueKey(parseVenueString(raw).name) and only falls back to normalizeVenueKey(raw)
// verbatim for a curator who aliased the literal packed "City, ST, Venue" form. Grouping on the raw
// string directly (skipping parseVenueString) would flag UMD's packed away-game venue field —
// "Duluth, MN, AMSOIL Arena" — as a "new" variant of Amsoil Arena on every single game, when it in
// fact already resolves cleanly through the EXISTING "AMSOIL Arena" alias via the parsed name; that
// was this script's first-draft bug, caught by eyeballing an early run where it was 21/23 of the
// "new" variants. Grouping/known-checks below use whichever of the two keys the corpus data itself
// resolved through, exactly matching resolvePlace's own precedence.
const byPlace = new Map(); // placeId -> Map<groupKey, { raw: string, count: number }>
let registeredEvents = 0;
for (const e of events) {
  if (!e.place || e.place.provisional) continue;
  registeredEvents++;
  const raw = e.venueRaw ?? "";
  if (!raw) continue;
  const parsed = parseVenueString(raw);
  const nameKey = normalizeVenueKey(parsed.name);
  if (!nameKey) continue;
  const fullKey = normalizeVenueKey(raw);
  // Group under the PARSED name — the clean venue identity, and the key resolvePlace checks first —
  // display text is the parsed name too, since that (not the packed raw) is what a curator pastes.
  let variants = byPlace.get(e.place.id);
  if (!variants) {
    variants = new Map();
    byPlace.set(e.place.id, variants);
  }
  const existing = variants.get(nameKey);
  if (existing) existing.count++;
  else variants.set(nameKey, { raw: displayRaw(parsed.name), fullKey, count: 1 });
}
p.log({ phase: "grouped", registeredPlaces: byPlace.size, registeredEvents });

// --- for each place, the set of keys ALREADY covered by its own name/address (canonical + aliases) ---
function knownKeysFor(place) {
  const keys = new Set([normalizeVenueKey(place.name)]);
  for (const a of place.nameAliases) keys.add(normalizeVenueKey(a));
  for (const a of place.addressAliases) keys.add(normalizeVenueKey(a));
  return keys;
}

let placesWithNew = 0;
let totalNewVariants = 0;
let out = `# Alias harvest — real observed venue-string variants per registered place\n\n`;
out += `Generated from a live pipeline run: ${stats.fetchedTotal} fetched, ${stats.merged} merged`;
out += stats.failures.length ? `, source failures: ${stats.failures.join(", ")}\n\n` : `, 0 source failures\n\n`;
out += `${byPlace.size} registered places have at least one event in this run; every distinct raw\n`;
out += `venue string is grouped under the place it resolved to. Variants already covered by that\n`;
out += `place's \`name\`/\`nameAliases\`/\`addressAliases\` are listed for confirmation only — variants\n`;
out += `flagged **NEW** are not yet in the registry. **This is a report, not a write — nothing here\n`;
out += `is auto-applied to \`src/places.ts\`.** Verify each NEW variant is really the same physical\n`;
out += `place before pasting; a merge is a one-way door (see Task 9c constraints).\n\n`;

// Rank places by how many NEW variants they'd add — the actionable ones float to the top.
const rows = [...byPlace.entries()].map(([placeId, variants]) => {
  const place = PLACE_INDEX.byId.get(placeId);
  const known = knownKeysFor(place);
  // A variant is confirmed if EITHER key resolvePlace would try is already registered — the parsed
  // name (the common case) or the verbatim packed string (the Bent Paddle Taproom precedent: a
  // curator can alias the literal "City, ST, Venue" form too).
  const isKnown = ([key, v]) => known.has(key) || known.has(v.fullKey);
  const newVariants = [...variants.entries()].filter((e) => !isKnown(e));
  const confirmedVariants = [...variants.entries()].filter((e) => isKnown(e));
  return { place, variants, newVariants, confirmedVariants };
});
rows.sort((a, b) => b.newVariants.length - a.newVariants.length || b.variants.size - a.variants.size);

for (const { place, newVariants, confirmedVariants } of rows) {
  if (newVariants.length === 0) continue; // nothing actionable — skip from the paste-ready section
  placesWithNew++;
  totalNewVariants += newVariants.length;

  out += `## ${place.name}  (id: \`${place.id}\`) — ${newVariants.length} new variant${newVariants.length === 1 ? "" : "s"}\n\n`;
  if (confirmedVariants.length) {
    out += `Already covered (${confirmedVariants.length}): ${confirmedVariants.map(([, v]) => `"${v.raw}"`).join(", ")}\n\n`;
  }
  out += "```ts\n";
  out += `nameAliases: ${JSON.stringify([...place.nameAliases])},  // current — append below, don't replace\n`;
  out += `// NEW, observed in the live corpus, not yet in the registry:\n`;
  const sortedNew = [...newVariants].sort((a, b) => b[1].count - a[1].count);
  out += `nameAliases: [\n`;
  for (const a of place.nameAliases) out += `  ${JSON.stringify(a)},\n`;
  for (const [, v] of sortedNew) out += `  ${JSON.stringify(v.raw)}, // NEW — observed ${v.count}x, not in registry\n`;
  out += `],\n`;
  out += "```\n\n";
}

if (placesWithNew === 0) {
  out += `No registered place had an observed variant outside its current \`nameAliases\`/\n`;
  out += `\`addressAliases\` in this run — the registry is caught up with this corpus snapshot.\n\n`;
}

out += `---\n\n# Confirmed-only places (every observed variant already in the registry)\n\n`;
const confirmedOnly = rows.filter((r) => r.newVariants.length === 0);
if (confirmedOnly.length === 0) {
  out += `(none)\n`;
} else {
  for (const { place, variants } of confirmedOnly) {
    out += `- **${place.name}** (\`${place.id}\`): ${variants.size} distinct variant${variants.size === 1 ? "" : "s"} observed, all covered\n`;
  }
}

mkdirSync("reports", { recursive: true });
writeFileSync("reports/alias-harvest.md", out);
p.done({ registeredPlaces: byPlace.size, placesWithNew, totalNewVariants });

console.log(`\nwrote reports/alias-harvest.md`);
console.log(`  registered places seen: ${byPlace.size}`);
console.log(`  places with NEW observed variants: ${placesWithNew}`);
console.log(`  total NEW variants flagged: ${totalNewVariants}`);
console.log(`\nreports/alias-harvest.md is NOT the registry. Review, then paste into src/places.ts.`);
