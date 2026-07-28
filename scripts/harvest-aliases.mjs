/**
 * Surface what a human should register or alias NEXT, from a built .ics feed. PRINTS (writes a
 * report) ONLY — never touches src/places.ts. Same discipline as scripts/places-propose.mjs: the
 * human paste is the id-stability guarantee, and every judgment stays visible in a git diff.
 *
 * Usage: npx tsx scripts/harvest-aliases.mjs [feed.ics]   (default: duluth-events.ics)
 *
 * REORIENTED after fix-round-1 review (Task 9c, M2). The first draft tried to detect "raw venue
 * strings that resolved to a REGISTERED place but aren't in its nameAliases/addressAliases yet".
 * That check is STRUCTURALLY INERT and always reports zero, by construction, not by finding: a
 * place resolves to `provisional: false` (src/place-registry.ts's `resolvePlace`) ONLY when
 * `normalizeVenueKey(parsed.name)` or `normalizeVenueKey(raw)` already hits that place's own alias
 * index — the exact same function and the exact same index the "is it already known" check re-ran.
 * Whichever key caused the resolution is, tautologically, already in the "known" set. No amount of
 * live-vs-cached data fixes this; it is a logic error, not a data-freshness error. Proven live:
 * `resolvePlace("BAYFRONT FESTIVAL PARK!!!")` resolves to `bayfront-festival-park` (punctuation/case
 * already collapse — see Task 9c's normalization gaps), so `isKnown` for that raw string is `true` by
 * the same construction, for every registered place, always.
 *
 * The real drift signal lives on the PROVISIONAL side instead, so this script now reports:
 *   1. Provisional clusters, ranked by event count — a provisional id carrying several events (or
 *      several distinct raw spellings that already converge under normalization) is a REGISTRATION
 *      candidate. This is the tool's most valuable output.
 *   2. Near-miss provisional pairs — two DIFFERENT provisional ids whose normalized token sets are
 *      either identical (same words, different order — "Main Library, X" vs "X – Main Library") or
 *      one is a subset of the other. Normalization (deliberately) cannot derive either case: they are
 *      exactly the acronym/word-order/colloquial-name territory a STORED alias exists for. Purely
 *      mechanical (set equality / set containment on already-normalized tokens) — no fuzzy scoring.
 *   3. Registered-place confirmation — honestly relabeled: this lists which registered place each
 *      raw spelling observed IN THIS FEED resolved to, for a human to eyeball, not a gap-detector.
 *
 * Reads a pre-built .ics rather than running the live pipeline. Reuses `parseIcs` from
 * scripts/verify-phase1.mjs rather than re-implementing an ICS line-parser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseIcs } from "./verify-phase1.mjs";
import { unescapeIcsText, cleanText } from "../src/normalize.js";

const ICS = process.argv[2] ?? "duluth-events.ics";
const events = parseIcs(ICS);

const displayName = (raw) => cleanText(unescapeIcsText(raw ?? ""));

// --- split into provisional vs registered, both keyed by X-PLACE-ID ---
const provisional = new Map(); // id -> { id, count, variants: Map<rawDisplay, count> }
const registered = new Map(); // id -> { id, name, count }
let noPlace = 0;

for (const e of events) {
  const id = e["X-PLACE-ID"];
  if (!id) {
    noPlace++;
    continue;
  }
  const isProvisional = e["X-PLACE-PROVISIONAL"] === "true";
  const name = displayName(e["X-PLACE-NAME"]);
  if (isProvisional) {
    let cluster = provisional.get(id);
    if (!cluster) {
      cluster = { id, count: 0, variants: new Map() };
      provisional.set(id, cluster);
    }
    cluster.count++;
    cluster.variants.set(name, (cluster.variants.get(name) ?? 0) + 1);
  } else {
    let entry = registered.get(id);
    if (!entry) {
      entry = { id, name, count: 0 };
      registered.set(id, entry);
    }
    entry.count++;
  }
}

// --- 1. provisional clusters, ranked by event count ---
const clusters = [...provisional.values()].sort(
  (a, b) => b.count - a.count || b.variants.size - a.variants.size,
);

// --- 2. near-miss provisional pairs — mechanical set equality / containment on normalized tokens ---
// The provisional id IS the normalized key already (src/place-registry.ts's `provisionalId`:
// `~${normalizeVenueKey(parsed.name).replace(/\s+/g, "-")}`), so recovering the token set is just
// undoing that one substitution — lossless, since normalizeVenueKey's output only ever contains
// lowercase alphanumeric tokens separated by single spaces (no hyphens survive inside a token).
const tokensOf = (id) => id.slice(1).split("-").filter(Boolean);
const withTokens = clusters.map((c) => ({ ...c, tokens: new Set(tokensOf(c.id)) }));

const sameSet = [];
const containment = [];
for (let i = 0; i < withTokens.length; i++) {
  for (let j = i + 1; j < withTokens.length; j++) {
    const a = withTokens[i];
    const b = withTokens[j];
    const sortedA = [...a.tokens].sort().join(" ");
    const sortedB = [...b.tokens].sort().join(" ");
    if (sortedA === sortedB) {
      sameSet.push({ a, b });
      continue;
    }
    const [small, large] = a.tokens.size <= b.tokens.size ? [a, b] : [b, a];
    // Require the smaller set to carry >=2 tokens — a single shared generic word ("park", "arena")
    // is not evidence of the same place, it's evidence English has fewer venue nouns than venues.
    if (small.tokens.size >= 2 && [...small.tokens].every((t) => large.tokens.has(t))) {
      containment.push({ small, large });
    }
  }
}
sameSet.sort((x, y) => y.a.count + y.b.count - (x.a.count + x.b.count));
containment.sort((x, y) => y.small.count + y.large.count - (x.small.count + x.large.count));

// --- write the report ---
let out = `# Alias harvest — what to register or alias NEXT\n\n`;
out += `Source: \`${ICS}\` — ${events.length} events (${noPlace} with no place at all: sentinels).\n`;
out += `Provisional clusters: ${provisional.size}. Registered places observed: ${registered.size}.\n\n`;
out += `**This is a report, not a write — nothing here is auto-applied to \`src/places.ts\`.** Verify\n`;
out += `every candidate before pasting; a merge is a one-way door.\n\n`;

out += `## 1. Provisional clusters, ranked by event count — registration candidates\n\n`;
out += `A provisional id carrying several events, or several distinct raw spellings that already\n`;
out += `converge under normalization, is real evidence for ONE place worth registering. Top 40 shown;\n`;
out += `full counts for the rest are in the summary above.\n\n`;
if (clusters.length === 0) {
  out += `(none — every event in this feed already resolved to a registered place, or is a sentinel)\n\n`;
} else {
  for (const c of clusters.slice(0, 40)) {
    const variants = [...c.variants.entries()].sort((a, b) => b[1] - a[1]);
    out += `- \`${c.id}\` — ${c.count} event${c.count === 1 ? "" : "s"}, ${c.variants.size} distinct spelling${c.variants.size === 1 ? "" : "s"}: `;
    out += variants.map(([v, n]) => `"${v}"${n > 1 ? ` (${n}x)` : ""}`).join(", ");
    out += `\n`;
  }
  if (clusters.length > 40) out += `\n(${clusters.length - 40} more clusters, lower event count, not listed individually)\n`;
  out += `\n`;
}

out += `## 2. Near-miss provisional pairs — likely candidates for a STORED alias\n\n`;
out += `Normalization cannot derive these (acronyms, word order, colloquial names) — that's exactly\n`;
out += `what \`nameAliases\` is for. Verify each is really the same physical place before merging.\n\n`;
out += `### Same token set, different word order (${sameSet.length})\n\n`;
if (sameSet.length === 0) {
  out += `(none)\n\n`;
} else {
  for (const { a, b } of sameSet) {
    out += `- \`${a.id}\` (${a.count} event${a.count === 1 ? "" : "s"}) <-> \`${b.id}\` (${b.count} event${b.count === 1 ? "" : "s"})\n`;
  }
  out += `\n`;
}
out += `### Token containment — one id's tokens are a full subset of the other's (${containment.length})\n\n`;
if (containment.length === 0) {
  out += `(none)\n\n`;
} else {
  for (const { small, large } of containment) {
    out += `- \`${small.id}\` (${small.count} event${small.count === 1 ? "" : "s"}) ⊂ \`${large.id}\` (${large.count} event${large.count === 1 ? "" : "s"})\n`;
  }
  out += `\n`;
}

out += `## 3. Registered-place confirmation (not a gap-detector — see header)\n\n`;
out += `Every registered place this feed's events resolved to, with the count observed. Listed for\n`;
out += `eyeballing only: this cannot tell you about a raw spelling NOT already in the registry (see\n`;
out += `the header comment for why), only confirm which places this snapshot actually touched.\n\n`;
const registeredSorted = [...registered.values()].sort((a, b) => b.count - a.count);
for (const r of registeredSorted) {
  out += `- **${r.name}** (\`${r.id}\`): ${r.count} event${r.count === 1 ? "" : "s"}\n`;
}

mkdirSync("reports", { recursive: true });
writeFileSync("reports/alias-harvest.md", out);

console.log(`wrote reports/alias-harvest.md`);
console.log(`  provisional clusters: ${clusters.length} (top: ${clusters[0] ? `${clusters[0].id} (${clusters[0].count} events)` : "none"})`);
console.log(`  near-miss pairs: ${sameSet.length} same-token-set, ${containment.length} containment`);
console.log(`  registered places observed: ${registered.size}`);
console.log(`\nreports/alias-harvest.md is NOT the registry. Review, then paste into src/places.ts.`);
