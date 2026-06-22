/**
 * Kuşatma Master Board — build tool (V2: neighbor geography).
 *
 * Produces, from the live region geometry (the single source of truth):
 *   board-source.svg            procedural board background, V2 (committed)
 *   preview/board-4020.png      4020×1960 raster — exact 4× of 1005×490 (gitignored)
 *   export/master-board-v2.webp 3015×1470 runtime-candidate — exact 3× (committed)
 *   preview/board-v2-clean-overlay.png       clean: board + runtime sim, no annotations
 *   preview/board-v2-diagnostic-overlay.png  diagnostic: + mask line + safe zones
 *   preview/board-v1-v2-comparison.png       V1 (deniz boşluğu) vs V2 (komşular)
 *   export/master-board-v1.webp keeps the accepted V1 candidate for the record
 *
 * It writes NO runtime files, touches nothing under src/, and never commits.
 *
 * V2 goal: Türkiye no longer floats in a generic sea void. Real border
 * neighbours are FELT (low-contrast, readable) in correct directions.
 *
 * GEOMETRY SOURCE (reported explicitly):
 *   - SHARED borders: Türkiye union from src/modes/conquest/maps/turkey-regions.ts.
 *     The single source of truth. Every neighbour mass is drawn OVERSIZED,
 *     intruding past the border into Türkiye, then clipped by the exterior mask,
 *     so the shared edge IS the union edge: no gap, no double coast, no sea band.
 *   - Neighbour OUTER silhouettes: authored low-detail directional masses, NOT a
 *     country dataset. public/data/countries-110m.json (Natural Earth 110m) exists
 *     but is stored for a geoNaturalEarth1 projection that is incompatible with
 *     this stylized, non-projected union: snapping real polygons to it would
 *     create seams (violates the #1 rule), and 110m coastlines would read as a
 *     second playable map (violates "no dense borders / not a second map"). So
 *     the dataset informs DIRECTIONS only; shapes stay abstract and soft.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT     = "/Users/enesk/Desktop/world-quiz";
const SRC      = `${ROOT}/src/modes/conquest/maps/turkey-regions.ts`;
const DIR      = `${ROOT}/design/conquest/board`;
const TERRAIN  = `${ROOT}/public/assets/backgrounds/turkey-terrain-texture.png`;
const CHROME   = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1005, H = 490;
// Exact integer multiples of the 1005×490 coordinate system (no arbitrary
// rounding) so the raster/export register 1:1 with the runtime SVG.
const SRC_MULT = 4, EXP_MULT = 3;
const OUT_W = W * SRC_MULT, OUT_H = H * SRC_MULT;   // 4020 × 1960
const WEBP_W = W * EXP_MULT, WEBP_H = H * EXP_MULT; // 3015 × 1470

mkdirSync(`${DIR}/preview`, { recursive: true });
mkdirSync(`${DIR}/export`,  { recursive: true });

// ── 1. geometry (single source of truth) ────────────────────────────────
const raw = readFileSync(SRC, "utf8");
const re = /\{\s*id:\s*"([^"]+)",\s*d:\s*"([^"]+)"\s*\}/g;
const regions = [];
for (let m; (m = re.exec(raw)); ) regions.push({ id: m[1], d: m[2] });
if (regions.length !== 25) throw new Error(`expected 25 regions, got ${regions.length}`);
const unionPaths = (idp) =>
  regions.map(({ id, d }) => `      <path id="${idp}-${id}" d="${d}"/>`).join("\n");

// ── art constants (tunable) ──────────────────────────────────────────────
const C = {
  seaDeep:  "#091f26", seaMid: "#0d2f38", seaLift: "#123f49",
  shallow:  "#225a62", foam: "#4a868c", fog: "#6fa1a6",
  turkeyHi: "#1a2a31", turkeyLo: "#121f26",
  // V1-only distant blobs (kept for the comparison render)
  landBase: "#264f59", landHi: "#34626a", landLo: "#1a3b44",
};

// V2 neighbour palette — all low-chroma, dark, matte, LOWER contrast than the
// Türkiye landmass; each region tinted to its character.
const NB = {
  sepStroke: "#5c7d82",                          // faint inter-neighbour separators
  apron:  "#223e44",                             // neutral land-border backfill
  west:   { fill:"#21424a", hi:"#2c525a", lo:"#18353c" }, // Greece + Balkans
  cauc:   { fill:"#244a52", hi:"#35616b", lo:"#1a3b43" }, // Georgia/Armenia (cool, mountains)
  iran:   { fill:"#233f44", hi:"#2e4d52", lo:"#19333a" }, // Iran
  meso:   { fill:"#2c362f", hi:"#39453a", lo:"#20281f" }, // Iraq+Syria (earthy, dark, muted)
  island: "#21424a", cyprus: "#233f45",
};

// Land-border apron: GUARANTEES neighbour land (never sea) just outside every
// shared LAND border. Drawn UNDER the coloured masses; clipped to the exterior
// mask so its Türkiye-facing edge IS the union edge (no gap / sea band). Covers
// East + SE + S(east of Hatay) and the NW Thrace border; deliberately excludes
// the Black Sea (N), Aegean (W) and Mediterranean (S-centre, x<~540) so those
// sea coasts keep open water. The diagonal return cuts through Türkiye and is
// clipped away.
const APRONS = [
  "M 1090 -40 L 1090 510 L 538 510 L 545 418 L 862 -40 Z",   // East + SE + S
  "M -90 -40 L 66 -40 L 70 64 L 44 130 L 8 150 L -90 150 Z",  // NW Thrace
];

// V2 neighbour masses. Each is OVERSIZED and intrudes past the union border;
// the exterior mask snaps the shared edge to the union. Directions match the
// real layout: Greece W, Balkans NW, Caucasus NE, Iran E, Iraq/Syria SE→S.
const NEIGHBORS = [
  { id:"west", c:NB.west,                       // Greece/Balkans, intrude Thrace W
    d:"M -90 -40 L 30 -40 C 48 -10, 58 25, 64 58 C 62 85, 50 108, 30 132 C -10 162, -60 160, -90 150 Z",
    relief:[{cx:-6,cy:40,rx:30,ry:16,t:"hi",o:0.4},{cx:18,cy:96,rx:22,ry:12,t:"lo",o:0.35}] },
  { id:"westS", c:NB.west,                       // Greek mainland down the Aegean W (off-frame)
    d:"M -90 150 L 8 150 C 2 188, 12 222, 4 258 C 12 298, -8 326, -90 330 Z",
    relief:[{cx:-20,cy:230,rx:26,ry:30,t:"lo",o:0.3}] },
  { id:"cauc", c:NB.cauc,                        // Georgia/Armenia NE, intrude NE border
    d:"M 1090 -40 L 1090 172 C 1010 168, 945 148, 898 124 C 872 100, 884 62, 845 30 C 900 4, 988 -14, 1090 -40 Z",
    relief:[{cx:948,cy:64,rx:34,ry:9,t:"hi",o:0.5},{cx:972,cy:104,rx:28,ry:8,t:"hi",o:0.42},{cx:922,cy:92,rx:24,ry:7,t:"lo",o:0.4}] },
  { id:"iran", c:NB.iran,                        // Iran E, intrude E border
    d:"M 1090 150 L 1090 342 C 1000 338, 968 304, 972 256 C 966 214, 984 184, 1090 160 Z",
    relief:[{cx:1020,cy:250,rx:26,ry:10,t:"hi",o:0.4},{cx:1000,cy:300,rx:22,ry:8,t:"lo",o:0.34}] },
  { id:"iraq", c:NB.meso,                        // Iraq SE, intrude SE border
    d:"M 1090 315 L 1090 510 L 868 510 C 896 460, 866 414, 838 372 C 884 350, 986 348, 1090 315 Z",
    relief:[{cx:960,cy:430,rx:30,ry:12,t:"hi",o:0.34},{cx:920,cy:460,rx:24,ry:9,t:"lo",o:0.34}] },
  { id:"syria", c:NB.meso,                       // Syria S, intrude S land border (stops W of Hatay)
    d:"M 905 510 L 545 510 C 555 432, 576 398, 606 380 C 678 362, 770 354, 856 350 C 890 348, 905 380, 905 470 Z",
    relief:[{cx:700,cy:452,rx:46,ry:12,t:"hi",o:0.28},{cx:620,cy:478,rx:34,ry:9,t:"lo",o:0.3}] },
  { id:"cyprus", c:{fill:NB.cyprus,hi:NB.cyprus,lo:NB.cyprus}, // optional faint Mediterranean island
    d:"M 452 488 C 470 480, 506 480, 526 486 C 512 496, 476 498, 452 488 Z", relief:[] },
];
// Aegean islands (in the western sea gap; over sea, correct).
const ISLANDS = [
  {x:30,y:178,r:7},{x:20,y:212,r:5},{x:46,y:236,r:6},{x:26,y:270,r:5},
  {x:54,y:300,r:6.5},{x:18,y:302,r:4.5},{x:64,y:262,r:5},{x:40,y:330,r:5.5},
];
// Faint inter-neighbour separators (thinner + far fainter than region borders).
const SEPARATORS = [
  "M 1004 150 C 990 178, 968 196, 952 210",   // Caucasus | Iran
  "M 1004 322 C 992 308, 974 300, 958 298",   // Iran | Iraq
  "M 902 470 C 900 440, 898 416, 884 398",    // Iraq | Syria
  "M 16 60 C 30 70, 44 78, 56 86",            // Greece | Balkans (mostly off-frame)
];

const FOG = [
  { cx: 40,  cy: 110, rx: 130, ry: 90, o: 0.06 },
  { cx: 990, cy: 90,  rx: 140, ry: 95, o: 0.05 },
  { cx: 930, cy: 470, rx: 170, ry: 90, o: 0.05 },
  { cx: 502, cy: 478, rx: 260, ry: 70, o: 0.04 },
  { cx: 250, cy: 470, rx: 150, ry: 70, o: 0.04 },
];

// ── 2. SVG composition (variant-aware: "v1" distant blobs, "v2" neighbours) ─
const fogEls = FOG.map(f =>
  `      <ellipse cx="${f.cx}" cy="${f.cy}" rx="${f.rx}" ry="${f.ry}" fill="${C.fog}" opacity="${f.o}"/>`
).join("\n");

// V1 distant blobs (kept ONLY to render the comparison's "before").
const DISTANT = {
  balkans: "M-60-20 C35,25 22,80 46,120 C26,150 44,188 22,224 C2,250 -30,256 -70,240 Z",
  balkansHi: "M-60-20 C20,20 14,70 30,108 C16,140 28,176 12,210 C-6,232 -40,236 -70,222 Z",
  islands: [ { x: 12, y: 132, r: 6.5 }, { x: 6, y: 172, r: 4.5 }, { x: 22, y: 206, r: 5 } ],
  caucasus: "M1075-20 C1010,18 1022,66 992,92 C1016,120 1000,162 1026,190 L1075,190 Z",
  caucasusHi: "M1075-20 C1018,14 1028,58 1004,84 C1022,112 1010,150 1030,176 L1075,176 Z",
  levant: "M770,520 C805,470 880,452 940,462 C1000,452 1060,470 1085,520 Z",
  levantHi: "M790,520 C820,484 888,468 938,476 C992,468 1046,482 1070,520 Z",
};

function v1Layers() {
  const islandEls = DISTANT.islands.map(i =>
    `      <ellipse cx="${i.x}" cy="${i.y}" rx="${i.r}" ry="${i.r*0.7}" fill="${C.landBase}"/>`).join("\n");
  return `
    <g filter="url(#softBig)">
      <path d="${DISTANT.balkans}"  fill="${C.landBase}"/>
      <path d="${DISTANT.caucasus}" fill="${C.landBase}"/>
      <path d="${DISTANT.levant}"   fill="${C.landBase}"/>
${islandEls}
      <path d="${DISTANT.balkansHi}"  fill="${C.landHi}" opacity="0.55"/>
      <path d="${DISTANT.caucasusHi}" fill="${C.landHi}" opacity="0.5"/>
      <path d="${DISTANT.levantHi}"   fill="${C.landHi}" opacity="0.5"/>
    </g>
    <g filter="url(#softFog)">
${fogEls}
    </g>
    <g filter="url(#shelfBlur)" opacity="0.55"><use href="#union" fill="${C.shallow}"/></g>
    <g fill="none" stroke="${C.foam}" stroke-width="1" stroke-linejoin="round" opacity="0.22" fill-rule="evenodd">
${unionPaths("fo")}
    </g>
    <rect x="0" y="0" width="${W}" height="${H}" filter="url(#grain)"/>`;
}

function v2Layers() {
  const neighborGroup = NEIGHBORS.map(n => {
    const relief = (n.relief||[]).map(r =>
      `        <ellipse cx="${r.cx}" cy="${r.cy}" rx="${r.rx}" ry="${r.ry}" fill="${r.t==="hi"?n.c.hi:n.c.lo}" opacity="${r.o}"/>`).join("\n");
    return `      <g>\n        <path d="${n.d}" fill="${n.c.fill}"/>\n${relief}\n      </g>`;
  }).join("\n");
  const islandEls = ISLANDS.map(i =>
    `      <ellipse cx="${i.x}" cy="${i.y}" rx="${i.r}" ry="${i.r*0.62}" fill="${NB.island}"/>`).join("\n");
  const apronEls = APRONS.map(d =>
    `      <path d="${d}" fill="${NB.apron}"/>`).join("\n");
  const sepEls = SEPARATORS.map(s =>
    `      <path d="${s}" fill="none" stroke="${NB.sepStroke}" stroke-width="0.4" opacity="0.16"/>`).join("\n");
  return `
    <!-- shallow-water shelf (under neighbours so sea coasts keep it) -->
    <g filter="url(#shelfBlur)" opacity="0.55"><use href="#union" fill="${C.shallow}"/></g>
    <!-- faint coastline foam (covered by neighbours along land borders) -->
    <g fill="none" stroke="${C.foam}" stroke-width="1" stroke-linejoin="round" opacity="0.22" fill-rule="evenodd">
${unionPaths("fo")}
    </g>
    <!-- NEIGHBOURS: soft, low-contrast; oversized + clipped to exterior so the
         shared border IS the union edge (no gap / double coast / sea band).
         Apron first (neutral land-border backfill), coloured masses on top. -->
    <g filter="url(#neighborBlur)">
${apronEls}
${neighborGroup}
${islandEls}
    </g>
    <!-- faint inter-neighbour separators (thinner + fainter than region borders) -->
    <g>
${sepEls}
    </g>
    <!-- atmospheric fog veils -->
    <g filter="url(#softFog)">
${fogEls}
    </g>
    <rect x="0" y="0" width="${W}" height="${H}" filter="url(#grain)"/>`;
}

function boardSvg(variant) {
  const tag = variant === "v2" ? "V2 (komşu coğrafya)" : "V1 (deniz boşluğu)";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Kuşatma Master Board — ${tag} (board background ART ONLY).
  Coordinate system 0 0 ${W} ${H}, identical to the runtime Türkiye SVG.
  Geometry source: src/modes/conquest/maps/turkey-regions.ts (25-path union).
  Neighbours are authored directional masses snapped to the union via the
  exterior mask; no country dataset, no labels/cities/roads/icons.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
     width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="seaGrad" cx="50%" cy="42%" r="74%">
      <stop offset="0%" stop-color="${C.seaLift}"/>
      <stop offset="55%" stop-color="${C.seaMid}"/>
      <stop offset="100%" stop-color="${C.seaDeep}"/>
    </radialGradient>
    <linearGradient id="turkeyFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.turkeyHi}"/>
      <stop offset="100%" stop-color="${C.turkeyLo}"/>
    </linearGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" stitchTiles="stitch" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0" result="g"/>
      <feComponentTransfer in="g"><feFuncA type="linear" slope="0.05" intercept="0"/></feComponentTransfer>
    </filter>
    <filter id="softBig" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="neighborBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="softFog" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="shelfBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>

    <mask id="exteriorMask">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
      <g fill="#000" stroke="#000" stroke-width="1.2" stroke-linejoin="round" fill-rule="evenodd">
${unionPaths("ex")}
      </g>
    </mask>
    <mask id="interiorMask">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#000"/>
      <g fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round" fill-rule="evenodd">
${unionPaths("in")}
      </g>
    </mask>
    <g id="union" fill-rule="evenodd">
${unionPaths("sh")}
    </g>
  </defs>

  <!-- L1 · sea base gradient -->
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#seaGrad)"/>

  <!-- exterior-clipped board: nothing can sit inside Türkiye -->
  <g mask="url(#exteriorMask)">
    <!-- sea tone variation -->
    <g filter="url(#softFog)" opacity="0.5">
      <ellipse cx="300" cy="150" rx="220" ry="120" fill="${C.seaLift}" opacity="0.35"/>
      <ellipse cx="760" cy="300" rx="240" ry="140" fill="${C.seaDeep}" opacity="0.40"/>
      <ellipse cx="120" cy="380" rx="180" ry="120" fill="${C.seaDeep}" opacity="0.35"/>
    </g>
${variant === "v2" ? v2Layers() : v1Layers()}
  </g>

  <!-- L6 · Türkiye interior knock-out (opaque, calm, neutral) -->
  <g mask="url(#interiorMask)">
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#turkeyFill)"/>
    <rect x="0" y="0" width="${W}" height="${H}" filter="url(#grain)" opacity="0.5"/>
  </g>
</svg>
`;
}

// board-source.svg is the V2 canonical source; _v1.svg is a temp for comparison.
writeFileSync(`${DIR}/board-source.svg`, boardSvg("v2"));
const v1Svg = `${DIR}/preview/_v1.svg`;
writeFileSync(v1Svg, boardSvg("v1"));
console.log("✓ board-source.svg (V2)");

// ── 3. rasterize (headless Chrome) ───────────────────────────────────────
function chromeShot(fileUrl, outPng, w, h) {
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--force-device-scale-factor=1",
    "--hide-scrollbars", "--default-background-color=00000000",
    `--screenshot=${outPng}`, `--window-size=${w},${h}`, fileUrl,
  ], { stdio: "ignore" });
}
const rasterHtml = `${DIR}/preview/_raster.html`;
writeFileSync(rasterHtml,
  `<!doctype html><meta charset=utf-8><style>html,body{margin:0}img{display:block;width:${OUT_W}px;height:${OUT_H}px}</style>` +
  `<img src="file://${DIR}/board-source.svg">`);
chromeShot(`file://${rasterHtml}`, `${DIR}/preview/board-4020.png`, OUT_W, OUT_H);
console.log(`✓ preview/board-4020.png (${OUT_W}×${OUT_H}, exact ${SRC_MULT}×)`);

// ── 4. sharp resize + WebP encode ────────────────────────────────────────
const sharp = require(`${ROOT}/node_modules/sharp`);
await sharp(`${DIR}/preview/board-4020.png`)
  .resize(WEBP_W, WEBP_H, { fit: "fill" })
  .webp({ quality: 82, effort: 5 })
  .toFile(`${DIR}/export/master-board-v2.webp`);
console.log(`✓ export/master-board-v2.webp (${WEBP_W}×${WEBP_H}, exact ${EXP_MULT}×)`);

// ── 5. runtime simulation overlays ───────────────────────────────────────
const REGION_LABELS = {
  trakya:"Trakya", istanbul_kocaeli:"İstanbul", guney_marmara:"G. Marmara",
  bati_karadeniz:"Batı Kara.", orta_karadeniz:"Orta Kara.", dogu_karadeniz:"Doğu Kara.",
  kuzeydogu_anadolu:"KD Anadolu", kuzey_ege:"Kuzey Ege", guney_ege:"Güney Ege",
  bati_akdeniz:"Batı Akd.", cukurova:"Çukurova", ic_bati_anadolu:"İç Batı",
  ankara_cevre:"Ankara", konya_karaman:"Konya", kapadokya:"Kapadokya",
  orta_anadolu:"Orta Anad.", erzurum_kars:"Erzurum", van_hakkari:"Van",
  malatya_elazig:"Malatya", firat_hatti:"Fırat", dicle_hatti:"Dicle",
  antep_kilis:"Antep", hatay_osmaniye:"Hatay", mardin_sirnak:"Mardin", kars:"Kars",
};
const REGION_LABEL_POS = {
  trakya:{x:90,y:56}, istanbul_kocaeli:{x:190,y:85}, guney_marmara:{x:130,y:155},
  bati_karadeniz:{x:378,y:68}, orta_karadeniz:{x:508,y:110}, dogu_karadeniz:{x:720,y:132},
  kuzeydogu_anadolu:{x:710,y:195}, kars:{x:915,y:188}, kuzey_ege:{x:112,y:243},
  guney_ege:{x:132,y:320}, bati_akdeniz:{x:235,y:345}, cukurova:{x:462,y:374},
  ic_bati_anadolu:{x:255,y:205}, ankara_cevre:{x:380,y:165}, konya_karaman:{x:352,y:298},
  kapadokya:{x:490,y:270}, orta_anadolu:{x:555,y:195}, erzurum_kars:{x:820,y:172},
  van_hakkari:{x:906,y:258}, malatya_elazig:{x:678,y:268}, firat_hatti:{x:648,y:320},
  dicle_hatti:{x:785,y:285}, antep_kilis:{x:610,y:368}, hatay_osmaniye:{x:552,y:386},
  mardin_sirnak:{x:837,y:339},
};
const SAMPLE_OWN = {
  trakya:"blue", istanbul_kocaeli:"blue", ic_bati_anadolu:"blue", ankara_cevre:"blue",
  van_hakkari:"red", erzurum_kars:"red", dicle_hatti:"red", mardin_sirnak:"red",
  cukurova:"green", konya_karaman:"green", kapadokya:"green",
};
const OWN = {
  blue:{f:"rgba(59,130,246,0.22)",b:"rgba(59,130,246,0.74)",t:"#93c5fd"},
  red: {f:"rgba(239,68,68,0.22)", b:"rgba(239,68,68,0.74)", t:"#fca5a5"},
  green:{f:"rgba(34,197,94,0.22)",b:"rgba(34,197,94,0.74)",t:"#86efac"},
  neutral:{f:"rgba(148,163,184,0.13)",b:"rgba(148,196,228,0.62)",t:"rgba(203,213,225,0.82)"},
};
const fillPaths = regions.map(({id,d})=>{
  const o = OWN[SAMPLE_OWN[id] || "neutral"];
  return `      <path d="${d}" fill="${o.f}" stroke="${o.b}" stroke-width="1" fill-rule="evenodd"/>`;
}).join("\n");
const labelEls = regions.map(({id})=>{
  const p = REGION_LABEL_POS[id]; if(!p) return "";
  const o = OWN[SAMPLE_OWN[id] || "neutral"];
  return `      <text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="middle" `+
         `font-family="'DM Sans',sans-serif" font-size="9.5" font-weight="700" fill="${o.t}" `+
         `style="paint-order:stroke" stroke="rgba(8,15,22,0.8)" stroke-width="2.2">${REGION_LABELS[id]}</text>`;
}).join("\n");

const terrainPatId = "terrainImg";
const diagnosticLayer = `
    <g fill="none" fill-rule="evenodd" stroke="#ff5cc8" stroke-width="0.5" stroke-dasharray="3 2.4" opacity="0.85">
${unionPaths("dg")}
    </g>
    <g font-family="'DM Sans',sans-serif" pointer-events="none">
      <rect x="14" y="14" width="${W-28}" height="${H-28}" fill="none" stroke="#58a6ff" stroke-width="0.8" stroke-dasharray="6 5" opacity="0.5"/>
      <rect x="0" y="0" width="${W}" height="46" fill="#58a6ff" opacity="0.08"/>
      <line x1="0" y1="46" x2="${W}" y2="46" stroke="#58a6ff" stroke-width="0.8" stroke-dasharray="4 4" opacity="0.5"/>
      <rect x="${W/2-235}" y="${H-84}" width="470" height="70" rx="12" fill="#58a6ff" opacity="0.08"/>
      <rect x="${W/2-235}" y="${H-84}" width="470" height="70" rx="12" fill="none" stroke="#58a6ff" stroke-width="0.8" stroke-dasharray="5 4" opacity="0.6"/>
      <text x="${W/2}" y="${H-44}" text-anchor="middle" fill="#cfe0ee" font-size="8">soru kartı overlay</text>
      <line x1="${W-210}" y1="50" x2="${W-210}" y2="${H-90}" stroke="#7d8590" stroke-width="0.8" stroke-dasharray="3 5" opacity="0.5"/>
      <text x="${W-150}" y="64" text-anchor="middle" fill="#cfe0ee" font-size="8">sağ panel</text>
      <text x="84" y="30" fill="#cfe0ee" font-size="8">header overlay</text>
    </g>`;

function simSvg(diagnostic, scale) {
  return `<svg style="width:${W*scale}px;height:${H*scale}px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="${terrainPatId}" patternUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
        <image href="file://${TERRAIN}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>
      </pattern>
    </defs>
    <g opacity="0.82" style="filter:saturate(0.72) brightness(0.88) contrast(0.92)">
${regions.map(({id,d})=>`      <path d="${d}" fill="url(#${terrainPatId})" fill-rule="evenodd"/>`).join("\n")}
    </g>
    <g>
${fillPaths}
    </g>
    <g>
${labelEls}
    </g>${diagnostic ? diagnosticLayer : ""}
  </svg>`;
}
function stageHtml(boardPath, diagnostic, scale, label) {
  return `<div class="stage" style="width:${W*scale}px;height:${H*scale}px">
    ${label ? `<div class="lbl">${label}</div>` : ""}
    <img style="width:${W*scale}px;height:${H*scale}px" src="file://${boardPath}">
    ${simSvg(diagnostic, scale)}
  </div>`;
}
function renderPage(body, outPng, w, h) {
  const html = `${DIR}/preview/_pg.html`;
  writeFileSync(html, `<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;background:#05121b;font-family:'DM Sans',sans-serif}
.col{display:flex;flex-direction:column;gap:14px;padding:14px;width:max-content}
.stage{position:relative}
.stage>img,.stage>svg{position:absolute;top:0;left:0}
.lbl{position:absolute;top:9px;left:11px;z-index:5;color:#e6f0f7;font-size:17px;font-weight:700;letter-spacing:.03em;background:rgba(5,18,27,.6);padding:3px 10px;border-radius:6px}</style>
<div class="col">${body}</div>`);
  chromeShot(`file://${html}`, outPng, w, h);
  rmSync(html);
}

const SCALE = 3, PAD = 14;
renderPage(stageHtml(`${DIR}/board-source.svg`, false, SCALE),
  `${DIR}/preview/board-v2-clean-overlay.png`, W*SCALE + PAD*2, H*SCALE + PAD*2);
console.log("✓ preview/board-v2-clean-overlay.png");
renderPage(stageHtml(`${DIR}/board-source.svg`, true, SCALE),
  `${DIR}/preview/board-v2-diagnostic-overlay.png`, W*SCALE + PAD*2, H*SCALE + PAD*2);
console.log("✓ preview/board-v2-diagnostic-overlay.png");

const CS = 2; // comparison scale
renderPage(
  stageHtml(v1Svg, false, CS, "V1 · deniz boşluğu") +
  stageHtml(`${DIR}/board-source.svg`, false, CS, "V2 · komşu coğrafya"),
  `${DIR}/preview/board-v1-v2-comparison.png`,
  W*CS + PAD*2, H*CS*2 + PAD*3);
console.log("✓ preview/board-v1-v2-comparison.png");

// ── 6. tidy + gitignore ──────────────────────────────────────────────────
try { rmSync(rasterHtml); } catch {}
try { rmSync(v1Svg); } catch {}
for (const stale of ["board-clean-overlay.png", "board-diagnostic-overlay.png",
                     "board-4096.png", "overlay-guide-preview.png"]) {
  try { rmSync(`${DIR}/preview/${stale}`); } catch {}
}
writeFileSync(`${DIR}/.gitignore`, "preview/board-4020.png\npreview/_*.html\npreview/_*.svg\n");
console.log("✓ .gitignore");
console.log("\nneighbours snapped to union via exteriorMask (shared edge = union, seam-free by construction).");
