/**
 * Türkiye Kuşatması · geo-context markup.
 *
 * SINGLE source of truth for the geo-context SVG fragment drawn BEHIND Türkiye
 * inside the expanded geo-canvas.  The runtime component (TurkeyConquestMap, via
 * dangerouslySetInnerHTML) injects exactly this.
 *
 * ── CURRENT STATE: FLAT geometry render (Phase-2 art on hold) ────────────────
 * Per the geo-topology fix, this renders a flat sea base + the real neighbour
 * polygons at their TRUE registered position (no dilation, no exterior-contact
 * mask).  Neighbours are already subtracted against the Türkiye union at BUILD
 * time (see scripts/build-conquest-neighbors.ts), so:
 *   • no neighbour can overlap/fuse to Türkiye (Greece ∩ Türkiye = ∅);
 *   • sea-class neighbours (Greece, Cyprus) keep their real water gap — they are
 *     never snapped toward Türkiye and are NOT part of any contact mask.
 * Everything here is non-interactive and sits behind the region paths; region
 * geometry / hit-areas / coordinates are untouched.  The painterly biome/sea art
 * will be re-applied on top of this verified geometry in a later, approved pass.
 */
import {
  CONQUEST_GEO_VIEWBOX as VB,
  CONQUEST_TURKEY_UNION_D,
  CONQUEST_NEIGHBOR_LANDS,
} from "./conquest-neighbors";

const rectAttrs = `x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}"`;

/**
 * Returns the geo-context inner SVG (sea + neighbour land) as a markup string,
 * injected into a non-interactive <g> inside the map SVG (expanded viewBox).
 */
export function buildConquestGeoContextMarkup(): string {
  // Two clearly-distinct FLAT tones (no gradient/terrain) so land vs sea — and
  // every Türkiye↔neighbour gap — is unambiguous for the geometry proof.
  const land = CONQUEST_NEIGHBOR_LANDS
    .map(
      (n) =>
        `<path d="${n.d}" data-geo="${n.id}" data-cls="${n.cls}" fill="#41492f" ` +
        `stroke="rgba(168,186,150,0.42)" stroke-width="0.9" fill-rule="evenodd"/>`,
    )
    .join("");

  return `
  <!-- Flat sea base (clearly blue) -->
  <rect ${rectAttrs} fill="#16384b"/>
  <!-- Real neighbour land at true position (build-time subtracted by Türkiye).
       Sea-class (Greece/Cyprus) keep their real water gap. -->
  <g class="cq-geo-neighbors">${land}</g>
  <!-- Türkiye coastline so the land/sea edge reads clearly (not art). -->
  <path d="${CONQUEST_TURKEY_UNION_D}" fill="none" stroke="rgba(150,188,200,0.6)" stroke-width="1.3" stroke-linejoin="round" fill-rule="evenodd"/>`;
}
