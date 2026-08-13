import { PLACES } from "./places.js";
import { creditsFor } from "./attribution.js";
import { esc, STYLE, type Row } from "./render-index.js";

/**
 * @displayName Venue directory page
 * @strategicPurpose A place feed's URL contains a hand-set, permanently-stable id, but the landing
 *   page lists only the busiest handful — leaving most venue feeds real, served, and undiscoverable
 *   except by guessing the id. This page is the directory that makes every one of them reachable.
 * @tacticalObjective Render every registered place with its address, current event count, and feed
 *   links — including places with no events right now, which the landing page deliberately hides.
 */

/**
 * Unlike the landing page, this page lists places with a zero count rather than hiding them. An
 * empty venue feed is a dead link on a page of highlights, but on the complete directory its absence
 * would be the bug: the venue IS registered, its id IS stable, and a subscriber who adds it now
 * simply starts receiving events whenever that venue next publishes one.
 */
export function renderPlaces(rows: Row[], base: string): string {
  const webcalBase = base.replace(/^https?:\/\//, "webcal://");
  const countByFile = new Map(rows.map((r) => [r.file, r.count]));

  const listed = PLACES.map((p) => {
    const file = `place/${p.id}.ics`;
    return {
      name: p.name,
      where: [p.address.street, p.address.city, p.address.state].filter(Boolean).join(", "),
      count: countByFile.get(file) ?? 0,
      file,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const withEvents = listed.filter((p) => p.count > 0).length;
  const items = listed
    .map(
      (p) => `      <tr>
        <td><strong>${esc(p.name)}</strong><br><span class="d">${esc(p.where)}</span></td>
        <td class="n">${p.count}</td>
        <td class="l"><a href="${webcalBase}/feeds/${p.file}">Subscribe</a> · <a href="${base}/feeds/${p.file}">.ics</a></td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Venues — Duluth Events</title>
<style>
${STYLE}
</style>
</head>
<body>
  <h1>Venues</h1>
  <p class="sub">Every venue with its own feed — ${listed.length} in all, ${withEvents} with events on the calendar right now. Subscribe to one and you get that venue's events only. <a href="${base}/">← All feeds</a></p>
  <table>
    <tbody>
${items}
    </tbody>
  </table>
  <footer>
    <p>A venue showing <strong>0</strong> has no events in the current build. Its feed is still published and its URL is permanent, so subscribing now means you receive events as soon as that venue next publishes any.</p>
    <p>Venue addresses derived from: ${creditsFor()
      .map((c) => `<a href="${c.url}">${esc(c.text)}</a>`)
      .join(" · ")}.</p>
  </footer>
</body>
</html>
`;
}
