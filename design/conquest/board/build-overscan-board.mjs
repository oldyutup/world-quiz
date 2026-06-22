/**
 * Kuşatma · Registered Overscan Board — build tool.
 *
 * Approved architecture (B mechanism). Türkiye union is the single source of
 * truth and is NEVER reshaped. It is placed as a registration rect at offset
 * (200, 70) inside a larger 1405 × 690 outer board; real border neighbours
 * fill the new margins (Aegean/Greece W, Balkans NW, Caucasus NE, Iran E,
 * Levant–Mesopotamia S/SE), low-contrast and readable.
 *
 * Seam-free by construction: every neighbour mass is drawn OVERSIZED, intruding
 * past the union border, then clipped by the exterior mask, so the shared edge
 * IS the union edge — no gap, no double coast, no false sea band. Land-border
 * aprons guarantee land (never sea) just outside shared LAND borders; the
 * Aegean (W), Mediterranean (S-centre) and Black Sea (N) deliberately keep open
 * water.
 *
 * Coordinate system: outer board 0 0 1405 690. The union is rendered inside a
 * translate(200 70) group; neighbour/sea art is authored in absolute outer
 * coords. 1 SVG unit = exactly 2 px in the runtime WebP (2810 × 1380 = 2×).
 *
 * Writes NO runtime source files except the optimized WebP asset; touches
 * nothing under src/; never commits.
 *
 * Run:  node design/conquest/board/build-overscan-board.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT    = "/Users/enesk/Desktop/world-quiz";
const SRC     = `${ROOT}/src/modes/conquest/maps/turkey-regions.ts`;
const DIR     = `${ROOT}/design/conquest/board`;
const TERRAIN = `${ROOT}/public/assets/backgrounds/turkey-terrain-texture.png`;
const RUNTIME = `${ROOT}/public/assets/backgrounds/conquest-overscan-board.webp`;
const CHROME  = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Outer board + inner registration rect (approved, non-negotiable).
const W = 1405, H = 690;      // outer board
const OX = 200, OY = 70;      // inner rect offset
const IW = 1005, IH = 490;    // inner registration rect = runtime SVG viewBox

// Exact integer multiples of the outer board (no arbitrary rounding) so the
// raster/export register 1:1 with the runtime layer transform.
const SRC_MULT = 4, EXP_MULT = 2;
const OUT_W = W * SRC_MULT, OUT_H = H * SRC_MULT;   // 5620 × 2760 supersample
const WEBP_W = W * EXP_MULT, WEBP_H = H * EXP_MULT; // 2810 × 1380 runtime target

mkdirSync(`${DIR}/preview`, { recursive: true });

// ── 1. geometry (single source of truth) ──────────────────────────────────
const raw = readFileSync(SRC, "utf8");
const re = /\{\s*id:\s*"([^"]+)",\s*d:\s*"([^"]+)"\s*\}/g;
const regions = [];
for (let m; (m = re.exec(raw)); ) regions.push({ id: m[1], d: m[2] });
if (regions.length !== 25) throw new Error(`expected 25 regions, got ${regions.length}`);
const unionPaths = (idp) =>
  regions.map(({ id, d }) => `        <path id="${idp}-${id}" d="${d}"/>`).join("\n");

// ── art palette ────────────────────────────────────────────────────────────
// Sea: cool, deep, matte. Neighbours: low-chroma, dark, LOWER contrast than the
// Türkiye landmass; each region tinted to its character.
const C = {
  seaDeep: "#091d24", seaMid: "#0d2b34", seaLift: "#103943",
  shallow: "#1f535b", foam: "#3f757b", fog: "#638f95",
  turkeyHi: "#1a2a31", turkeyLo: "#111e25",
};
const NB = {
  sepStroke: "#688a90",
  apron: "#294349",                                  // neutral land-border backfill
  west: { fill: "#2a4c54", hi: "#3a626c", lo: "#1f3e46" },  // Greece + Balkans
  cauc: { fill: "#2e5862", hi: "#42707b", lo: "#214650" },  // Caucasus (cool, alpine)
  iran: { fill: "#2b4d54", hi: "#3a606a", lo: "#203f47" },  // Iran (arid highland)
  meso: { fill: "#3c4636", hi: "#4f5b44", lo: "#2c3526" },  // Iraq + Syria (warm earthy)
  island: "#2c4e56", cyprus: "#2b4d54",
};

// ── neighbour geometry (authored in absolute 1405×690 outer coords) ─────────
// Union (translated) occupies x≈216.8→1207.5, y≈69.8→512.8. Masses anchor to
// the canvas edges and intrude PAST the union border; the exterior mask snaps
// the shared edge to the union.

// Land-border aprons: GUARANTEE neighbour land just outside every shared LAND
// border (East + SE + S-east-of-Hatay, and NW Thrace). Drawn UNDER the masses,
// clipped to the exterior mask. The inner diagonals cut through Türkiye and are
// clipped away. They deliberately EXCLUDE the Black Sea (N), Aegean (W) and
// Mediterranean (S-centre) so those sea coasts keep open water.
const APRONS = [
  "M 1455 -60 L 1455 760 L 660 760 L 720 500 L 1140 80 L 1455 -60 Z", // East + SE + S-land
  "M -60 -60 L 380 -60 L 312 132 L 132 214 L -60 214 Z",              // NW Thrace
];

// Neighbour masses: soft, low-contrast, oversized + exterior-clipped.
const NEIGHBORS = [
  { id: "balkans", c: NB.west,        // Greece/Bulgaria meeting Thrace (NW land)
    d: "M -60 -60 L 392 -60 C 372 36, 322 104, 256 158 C 212 196, 146 214, 70 218 C 6 218, -60 202, -60 -60 Z",
    relief: [{ cx: 150, cy: 70, rx: 60, ry: 30, t: "hi", o: 0.4 },
             { cx: 60, cy: 150, rx: 44, ry: 26, t: "lo", o: 0.34 }] },
  { id: "greece", c: NB.west,         // Greek mainland down the Aegean W (sea gap kept)
    d: "M -60 188 L 128 192 C 108 258, 138 320, 104 384 C 126 452, 64 492, -60 492 Z",
    relief: [{ cx: 20, cy: 300, rx: 40, ry: 52, t: "lo", o: 0.3 },
             { cx: 70, cy: 230, rx: 30, ry: 24, t: "hi", o: 0.3 }] },
  { id: "caucasus", c: NB.cauc,       // Georgia/Armenia NE
    d: "M 1465 -60 L 1465 256 C 1356 246, 1276 220, 1226 188 C 1252 130, 1206 94, 1244 48 C 1320 8, 1402 -28, 1465 -60 Z",
    relief: [{ cx: 1330, cy: 88, rx: 56, ry: 14, t: "hi", o: 0.5 },
             { cx: 1372, cy: 150, rx: 46, ry: 12, t: "hi", o: 0.42 },
             { cx: 1290, cy: 130, rx: 38, ry: 11, t: "lo", o: 0.4 }] },
  { id: "iran", c: NB.iran,           // Iran E
    d: "M 1465 232 L 1465 484 C 1356 476, 1300 432, 1296 366 C 1290 304, 1316 258, 1465 240 Z",
    relief: [{ cx: 1392, cy: 360, rx: 42, ry: 16, t: "hi", o: 0.4 },
             { cx: 1360, cy: 430, rx: 34, ry: 12, t: "lo", o: 0.34 }] },
  { id: "iraq", c: NB.meso,           // Iraq SE
    d: "M 1465 452 L 1465 760 L 1058 760 C 1090 690, 1054 624, 1018 566 C 1078 540, 1230 542, 1465 470 Z",
    relief: [{ cx: 1230, cy: 640, rx: 52, ry: 18, t: "hi", o: 0.32 },
             { cx: 1150, cy: 690, rx: 40, ry: 13, t: "lo", o: 0.32 }] },
  { id: "syria", c: NB.meso,          // Syria S (stops W of Hatay; sea kept further W)
    d: "M 1110 760 L 660 760 C 676 654, 706 606, 752 580 C 868 556, 1010 560, 1112 556 C 1158 554, 1180 600, 1170 700 Z",
    relief: [{ cx: 900, cy: 668, rx: 64, ry: 17, t: "hi", o: 0.26 },
             { cx: 770, cy: 706, rx: 48, ry: 13, t: "lo", o: 0.28 }] },
  { id: "cyprus", c: { fill: NB.cyprus, hi: NB.cyprus, lo: NB.cyprus }, // faint Med island
    d: "M 612 590 C 640 575, 724 575, 776 589 C 748 608, 668 612, 612 590 Z", relief: [] },
];

// Aegean islands (in the western sea gap; over sea, correct).
const ISLANDS = [
  { x: 150, y: 250, r: 9 }, { x: 134, y: 300, r: 6 }, { x: 172, y: 338, r: 8 },
  { x: 144, y: 384, r: 6 }, { x: 188, y: 426, r: 8.5 }, { x: 130, y: 430, r: 5.5 },
  { x: 200, y: 372, r: 6 }, { x: 162, y: 470, r: 7 },
];

// Faint inter-neighbour separators (thinner + far fainter than region borders).
const SEPARATORS = [
  "M 1300 220 C 1330 256, 1306 300, 1290 330",  // Caucasus | Iran
  "M 1456 452 C 1380 446, 1330 432, 1300 420",  // Iran | Iraq
  "M 1112 700 C 1108 650, 1100 612, 1066 580",  // Iraq | Syria
  "M 132 92 C 156 110, 178 128, 196 150",       // Balkans | Greece
];

const FOG = [
  { cx: 90,   cy: 150, rx: 190, ry: 130, o: 0.06 },
  { cx: 1330, cy: 130, rx: 200, ry: 135, o: 0.05 },
  { cx: 1240, cy: 660, rx: 240, ry: 130, o: 0.05 },
  { cx: 640,  cy: 660, rx: 320, ry: 100, o: 0.04 },
  { cx: 700,  cy: 36,  rx: 360, ry: 70,  o: 0.04 },
];

// ── 2. SVG composition ──────────────────────────────────────────────────────
const tg = (body) => `<g transform="translate(${OX} ${OY})">\n${body}\n      </g>`;
const fogEls = FOG.map(f =>
  `      <ellipse cx="${f.cx}" cy="${f.cy}" rx="${f.rx}" ry="${f.ry}" fill="${C.fog}" opacity="${f.o}"/>`
).join("\n");
const neighborGroup = NEIGHBORS.map(n => {
  const relief = (n.relief || []).map(r =>
    `        <ellipse cx="${r.cx}" cy="${r.cy}" rx="${r.rx}" ry="${r.ry}" fill="${r.t === "hi" ? n.c.hi : n.c.lo}" opacity="${r.o}"/>`
  ).join("\n");
  return `      <g>\n        <path d="${n.d}" fill="${n.c.fill}"/>\n${relief}\n      </g>`;
}).join("\n");
const islandEls = ISLANDS.map(i =>
  `      <ellipse cx="${i.x}" cy="${i.y}" rx="${i.r}" ry="${i.r * 0.62}" fill="${NB.island}"/>`).join("\n");
const apronEls = APRONS.map(d => `      <path d="${d}" fill="${NB.apron}"/>`).join("\n");
const sepEls = SEPARATORS.map(s =>
  `      <path d="${s}" fill="none" stroke="${NB.sepStroke}" stroke-width="0.5" opacity="0.16"/>`).join("\n");

function boardSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Kuşatma Registered Overscan Board (board background ART ONLY).
  Outer board 0 0 ${W} ${H}; inner registration rect (${OX},${OY},${IW},${IH})
  = runtime Türkiye SVG viewBox. Geometry source:
  src/modes/conquest/maps/turkey-regions.ts (25-path union, translated +${OX},+${OY}).
  Neighbours are authored directional masses snapped to the union via the
  exterior mask; no country dataset, no labels/cities/roads/icons.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
     width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet">
  <defs>
    <radialGradient id="seaGrad" cx="50%" cy="44%" r="78%">
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
    <filter id="neighborBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter>
    <filter id="softFog" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="26"/></filter>
    <filter id="shelfBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>

    <mask id="exteriorMask">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
      ${tg(`        <g fill="#000" stroke="#000" stroke-width="1.2" stroke-linejoin="round" fill-rule="evenodd">\n${unionPaths("ex")}\n        </g>`)}
    </mask>
    <mask id="interiorMask">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#000"/>
      ${tg(`        <g fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round" fill-rule="evenodd">\n${unionPaths("in")}\n        </g>`)}
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
      <ellipse cx="480" cy="210" rx="300" ry="150" fill="${C.seaLift}" opacity="0.32"/>
      <ellipse cx="1040" cy="420" rx="320" ry="180" fill="${C.seaDeep}" opacity="0.40"/>
      <ellipse cx="220" cy="520" rx="240" ry="150" fill="${C.seaDeep}" opacity="0.34"/>
    </g>

    <!-- shallow-water shelf hugging the coast (under neighbours so sea coasts keep it) -->
    <g filter="url(#shelfBlur)" opacity="0.55">${tg(`<use href="#union" fill="${C.shallow}"/>`)}</g>
    <!-- faint coastline foam (covered by neighbours along land borders) -->
    ${tg(`<g fill="none" stroke="${C.foam}" stroke-width="1.2" stroke-linejoin="round" opacity="0.22" fill-rule="evenodd">\n${unionPaths("fo")}\n      </g>`)}

    <!-- NEIGHBOURS: apron first (neutral land-border backfill), masses on top -->
    <g filter="url(#neighborBlur)">
${apronEls}
${neighborGroup}
${islandEls}
    </g>
    <!-- faint inter-neighbour separators -->
    <g>
${sepEls}
    </g>
    <!-- atmospheric fog veils -->
    <g filter="url(#softFog)">
${fogEls}
    </g>
    <rect x="0" y="0" width="${W}" height="${H}" filter="url(#grain)"/>
  </g>

  <!-- Türkiye interior knock-out (opaque, calm, neutral; real terrain rides on top at runtime) -->
  <g mask="url(#interiorMask)">
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#turkeyFill)"/>
    <rect x="0" y="0" width="${W}" height="${H}" filter="url(#grain)" opacity="0.5"/>
  </g>
</svg>
`;
}

writeFileSync(`${DIR}/overscan-source.svg`, boardSvg());
console.log("✓ overscan-source.svg");

// ── 3. rasterize (headless Chrome) ──────────────────────────────────────────
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
  `<img src="file://${DIR}/overscan-source.svg">`);
chromeShot(`file://${rasterHtml}`, `${DIR}/preview/overscan-5620.png`, OUT_W, OUT_H);
console.log(`✓ preview/overscan-5620.png (${OUT_W}×${OUT_H}, exact ${SRC_MULT}×)`);

// ── 4. sharp resize → runtime WebP ──────────────────────────────────────────
const sharp = require(`${ROOT}/node_modules/sharp`);
await sharp(`${DIR}/preview/overscan-5620.png`)
  .resize(WEBP_W, WEBP_H, { fit: "fill" })
  .webp({ quality: 84, effort: 5 })
  .toFile(RUNTIME);
console.log(`✓ ${RUNTIME} (${WEBP_W}×${WEBP_H}, exact ${EXP_MULT}×)`);

// ── 5. runtime-simulation overlays (registration proof) ─────────────────────
// Composites the outer board + a sim of the runtime Türkiye SVG placed at the
// EXACT registration rect (OX,OY,IW,IH), proving the layer transform.
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
const simFills = regions.map(({id,d})=>{
  const o = OWN[SAMPLE_OWN[id] || "neutral"];
  return `      <path d="${d}" fill="${o.f}" stroke="${o.b}" stroke-width="1" fill-rule="evenodd"/>`;
}).join("\n");
const simLabels = regions.map(({id})=>{
  const p = REGION_LABEL_POS[id]; if(!p) return "";
  const o = OWN[SAMPLE_OWN[id] || "neutral"];
  return `      <text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="middle" `+
         `font-family="'DM Sans',sans-serif" font-size="9.5" font-weight="700" fill="${o.t}" `+
         `style="paint-order:stroke" stroke="rgba(8,15,22,0.8)" stroke-width="2.2">${REGION_LABELS[id]}</text>`;
}).join("\n");

function simSvg(scale, diagnostic) {
  const diag = diagnostic ? `
      <g fill="none" fill-rule="evenodd" stroke="#ff5cc8" stroke-width="0.6" stroke-dasharray="3 2.4" opacity="0.85">
${unionPaths("dg")}
      </g>` : "";
  return `<svg style="position:absolute;left:${OX*scale}px;top:${OY*scale}px;width:${IW*scale}px;height:${IH*scale}px" viewBox="0 0 ${IW} ${IH}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="terr" patternUnits="userSpaceOnUse" x="0" y="0" width="${IW}" height="${IH}">
        <image href="file://${TERRAIN}" x="0" y="0" width="${IW}" height="${IH}" preserveAspectRatio="xMidYMid slice"/>
      </pattern>
    </defs>
    <g opacity="0.82" style="filter:saturate(0.72) brightness(0.88) contrast(0.92)">
${regions.map(({id,d})=>`      <path d="${d}" fill="url(#terr)" fill-rule="evenodd"/>`).join("\n")}
    </g>
    <g>
${simFills}
    </g>
    <g>
${simLabels}
    </g>${diag}
  </svg>`;
}
function diagBox(scale) {
  return `
    <div style="position:absolute;left:${OX*scale}px;top:${OY*scale}px;width:${IW*scale}px;height:${IH*scale}px;border:1px dashed #58a6ff;opacity:.6;box-sizing:border-box"></div>
    <div style="position:absolute;left:8px;top:8px;color:#cfe0ee;font:12px 'DM Sans',sans-serif;background:rgba(5,18,27,.6);padding:3px 9px;border-radius:6px">outer board ${W}×${H} · inner rect (${OX},${OY},${IW},${IH})</div>`;
}
function renderOverlay(diagnostic, scale, outPng) {
  const html = `${DIR}/preview/_ov.html`;
  writeFileSync(html, `<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;background:#07101c}.stage{position:relative;width:${W*scale}px;height:${H*scale}px}
.stage>img{position:absolute;inset:0;width:${W*scale}px;height:${H*scale}px}</style>
<div class="stage">
  <img src="file://${RUNTIME}">
  ${simSvg(scale, diagnostic)}
  ${diagnostic ? diagBox(scale) : ""}
</div>`);
  chromeShot(`file://${html}`, outPng, W*scale, H*scale);
  rmSync(html);
}
const SCALE = 2;
renderOverlay(false, SCALE, `${DIR}/preview/overscan-clean-overlay.png`);
console.log("✓ preview/overscan-clean-overlay.png");
renderOverlay(true, SCALE, `${DIR}/preview/overscan-diagnostic-overlay.png`);
console.log("✓ preview/overscan-diagnostic-overlay.png");

// ── 6. tidy ─────────────────────────────────────────────────────────────────
try { rmSync(rasterHtml); } catch {}
writeFileSync(`${DIR}/.gitignore`, "preview/board-4020.png\npreview/overscan-5620.png\npreview/_*.html\npreview/_*.svg\n");
console.log("\n✓ done — neighbours snapped to translated union via exteriorMask (seam-free by construction).");
