/**
 * Türkiye Kuşatması · geo-context painterly markup (Phase 2).
 *
 * SINGLE source of truth for the geo-context SVG fragment (defs + layers) drawn
 * BEHIND Türkiye inside the expanded geo-canvas.  Both the runtime component
 * (TurkeyConquestMap, via dangerouslySetInnerHTML) and the headless QA harness
 * import THIS builder, so the production screenshot is byte-identical to what
 * ships — no parallel hand-authored SVG.
 *
 * Design contract (Phase 2):
 *  • Vector neighbour polygons are GEOMETRY/MASK source only; land is rendered
 *    with painterly material (muted terrain texture + per-biome tonal wash),
 *    biome-tinted: warm/dry Levant–Mesopotamia, cold-brown Iran plateau, cool
 *    alpine Caucasus, low-contrast green Balkans/Greece, neutral Cyprus.
 *  • Sea is alive: depth gradient + soft tonal variation + coastal shallows +
 *    a faint foam rim + controlled fog.
 *  • Türkiye's outer border reads via SOFT coast/rim + light haze + terrain
 *    transition — NO high-contrast political line, NO hard raster border (the
 *    affine residual stays invisible).  Neighbours are low-contrast so Türkiye's
 *    high-contrast playable terrain stays dominant.
 *  • Everything here is non-interactive and sits behind the region paths; region
 *    geometry / hit-areas / coordinates are untouched.
 */
import {
  CONQUEST_GEO_VIEWBOX as VB,
  CONQUEST_TURKEY_UNION_D,
  CONQUEST_NEIGHBOR_LANDS,
} from "./conquest-neighbors";

// ── Biome assignment + palette (muted, low-contrast on purpose) ───────────────
type Biome = "levant" | "iran" | "caucasus" | "balkans" | "cyprus";
const BIOME_OF: Record<string, Biome> = {
  syria: "levant", iraq: "levant",
  iran: "iran",
  georgia: "caucasus", armenia: "caucasus", azerbaijan: "caucasus",
  greece: "balkans", bulgaria: "balkans",
  cyprus: "cyprus",
};

// base = solid muted floor; toneTop→toneBot = vertical wash for relief depth.
const BIOME_PALETTE: Record<Biome, { base: string; toneTop: string; toneBot: string }> = {
  levant:   { base: "#3b3522", toneTop: "#4b4530", toneBot: "#2c2718" }, // warm / dry
  iran:     { base: "#34302a", toneTop: "#433c30", toneBot: "#272219" }, // cold-brown plateau
  caucasus: { base: "#2f3a38", toneTop: "#3c4a46", toneBot: "#222d2b" }, // cool alpine
  balkans:  { base: "#323d2b", toneTop: "#3f4c30", toneBot: "#26301d" }, // low-contrast green
  cyprus:   { base: "#3a3d31", toneTop: "#474a3b", toneBot: "#2c2e24" }, // neutral Mediterranean
};

const rectAttrs = `x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}"`;

function biomeGroups(): { clips: string; fills: string } {
  const byBiome = new Map<Biome, string[]>();
  for (const land of CONQUEST_NEIGHBOR_LANDS) {
    const b = BIOME_OF[land.id];
    if (!b) continue;
    if (!byBiome.has(b)) byBiome.set(b, []);
    byBiome.get(b)!.push(land.d);
  }
  let clips = "";
  let fills = "";
  for (const [biome, ds] of byBiome) {
    const paths = ds.map((d) => `<path d="${d}" fill-rule="evenodd"/>`).join("");
    clips += `<clipPath id="cqBiome-${biome}">${paths}</clipPath>`;
    const p = BIOME_PALETTE[biome];
    fills +=
      `<g clip-path="url(#cqBiome-${biome})">` +
        `<rect ${rectAttrs} fill="${p.base}"/>` +
        `<rect ${rectAttrs} fill="url(#cqNbTerrain)" opacity="0.34"/>` +
        `<rect ${rectAttrs} fill="url(#cqTone-${biome})" opacity="0.42"/>` +
      `</g>`;
  }
  return { clips, fills };
}

function toneGradients(): string {
  return (Object.keys(BIOME_PALETTE) as Biome[])
    .map((b) => {
      const p = BIOME_PALETTE[b];
      return `<linearGradient id="cqTone-${b}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="${p.toneTop}"/>` +
        `<stop offset="100%" stop-color="${p.toneBot}"/></linearGradient>`;
    })
    .join("");
}

export interface GeoContextOptions {
  /** Terrain texture URL — web path in app, file:// in the headless harness. */
  terrainHref: string;
}

/**
 * Returns the geo-context inner SVG (defs + layers) as a markup string, to be
 * injected into a non-interactive <g> inside the map SVG (expanded viewBox).
 */
export function buildConquestGeoContextMarkup({ terrainHref }: GeoContextOptions): string {
  const { clips, fills } = biomeGroups();
  const cx = VB.x + VB.w / 2;
  const cy = VB.y + VB.h * 0.46;

  return `
  <defs>
    <radialGradient id="cqSeaDepth" cx="${(((cx - VB.x) / VB.w) * 100).toFixed(1)}%" cy="${(((cy - VB.y) / VB.h) * 100).toFixed(1)}%" r="72%">
      <stop offset="0%" stop-color="#16384a"/>
      <stop offset="52%" stop-color="#0e2a38"/>
      <stop offset="100%" stop-color="#071620"/>
    </radialGradient>
    ${toneGradients()}
    <pattern id="cqNbTerrain" patternUnits="userSpaceOnUse" x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}">
      <image href="${terrainHref}" x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}" preserveAspectRatio="xMidYMid slice"/>
    </pattern>
    <filter id="cqGrain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0" result="g"/>
      <feComponentTransfer in="g"><feFuncA type="linear" slope="0.04" intercept="0"/></feComponentTransfer>
    </filter>
    <filter id="cqSeaWaves" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="4" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0" result="g"/>
      <feComponentTransfer in="g"><feFuncA type="linear" slope="0.05" intercept="0"/></feComponentTransfer>
    </filter>
    <filter id="cqFogBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="26"/></filter>
    <filter id="cqShallowBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="cqHazeBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="cqFoamBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.2"/></filter>
    ${clips}
    <!-- Hard exterior mask: neighbours never cover Türkiye, no sea reveal on
         land borders (softness comes from haze/rim, not a feathered mask). -->
    <mask id="cqExMask" maskUnits="userSpaceOnUse" x="${VB.x}" y="${VB.y}" width="${VB.w}" height="${VB.h}">
      <rect ${rectAttrs} fill="#fff"/>
      <path d="${CONQUEST_TURKEY_UNION_D}" fill="#000" fill-rule="evenodd"/>
    </mask>
  </defs>

  <!-- L1 · sea base + depth -->
  <rect ${rectAttrs} fill="url(#cqSeaDepth)"/>
  <g filter="url(#cqFogBlur)" opacity="0.5">
    <ellipse cx="${VB.x + VB.w * 0.32}" cy="${VB.y + VB.h * 0.30}" rx="${VB.w * 0.22}" ry="${VB.h * 0.22}" fill="#15414f" opacity="0.5"/>
    <ellipse cx="${VB.x + VB.w * 0.74}" cy="${VB.y + VB.h * 0.78}" rx="${VB.w * 0.24}" ry="${VB.h * 0.26}" fill="#06141d" opacity="0.55"/>
    <ellipse cx="${VB.x + VB.w * 0.12}" cy="${VB.y + VB.h * 0.82}" rx="${VB.w * 0.16}" ry="${VB.h * 0.22}" fill="#06141d" opacity="0.45"/>
  </g>
  <rect ${rectAttrs} filter="url(#cqSeaWaves)" opacity="0.5"/>

  <!-- L2 · coastal shallows hugging Türkiye (sea sides; covered by land on borders) -->
  <path d="${CONQUEST_TURKEY_UNION_D}" fill="none" stroke="#1b4651" stroke-width="24" stroke-linejoin="round" filter="url(#cqShallowBlur)" opacity="0.55" fill-rule="evenodd"/>
  <path d="${CONQUEST_TURKEY_UNION_D}" fill="none" stroke="#23525e" stroke-width="9" stroke-linejoin="round" filter="url(#cqShallowBlur)" opacity="0.4" fill-rule="evenodd"/>

  <!-- L3 · neighbour land (painterly, exterior-masked, biome-tinted) -->
  <g mask="url(#cqExMask)">
    ${fills}
    <rect ${rectAttrs} filter="url(#cqGrain)" opacity="0.55"/>
  </g>

  <!-- L4 · soft contact: haze veils over the Türkiye↔neighbour border (wider, faint
       outer pass + tighter inner pass → land borders read as soft mist/terrain
       transition, never a hard political line). -->
  <path d="${CONQUEST_TURKEY_UNION_D}" fill="none" stroke="#7a979d" stroke-width="40" stroke-linejoin="round" filter="url(#cqHazeBlur)" opacity="0.10" fill-rule="evenodd"/>
  <path d="${CONQUEST_TURKEY_UNION_D}" fill="none" stroke="#7a979d" stroke-width="22" stroke-linejoin="round" filter="url(#cqHazeBlur)" opacity="0.14" fill-rule="evenodd"/>

  <!-- L5 · faint foam rim (soft, low-contrast — reads as coast, not a border) -->
  <path d="${CONQUEST_TURKEY_UNION_D}" fill="none" stroke="#69939b" stroke-width="1.3" stroke-linejoin="round" filter="url(#cqFoamBlur)" opacity="0.30" fill-rule="evenodd"/>

  <!-- L6 · distant fog veils (canvas edges) -->
  <g filter="url(#cqFogBlur)">
    <ellipse cx="${VB.x + VB.w * 0.06}" cy="${VB.y + VB.h * 0.18}" rx="${VB.w * 0.20}" ry="${VB.h * 0.16}" fill="#6f8a92" opacity="0.05"/>
    <ellipse cx="${VB.x + VB.w * 0.94}" cy="${VB.y + VB.h * 0.16}" rx="${VB.w * 0.20}" ry="${VB.h * 0.16}" fill="#6f8a92" opacity="0.045"/>
    <ellipse cx="${VB.x + VB.w * 0.50}" cy="${VB.y + VB.h * 0.04}" rx="${VB.w * 0.30}" ry="${VB.h * 0.10}" fill="#6f8a92" opacity="0.04"/>
    <ellipse cx="${VB.x + VB.w * 0.86}" cy="${VB.y + VB.h * 0.92}" rx="${VB.w * 0.22}" ry="${VB.h * 0.13}" fill="#5a727a" opacity="0.05"/>
  </g>`;
}
