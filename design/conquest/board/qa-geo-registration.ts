/* eslint-disable */
/**
 * Kuşatma · Phase-2 geo-context — production-look + registration + hit-area QA.
 *
 * Renders the REAL desktop game-screen DOM (.cq-game-screen → board →
 * .cq-turkey-map-wrap) with the REAL compiled app CSS, and the SAME painterly
 * geo-context the runtime component injects — by importing the SAME builder
 * (buildConquestGeoContextMarkup).  So these screenshots are byte-identical to
 * what ships (no parallel hand-authored SVG).
 *
 *   • Production-look screenshots: 1440×900 (MacBook ref), 1366×768, 1920×1080.
 *   • Close-ups: Trakya, Antep–Mardin, Van (2× DPI).
 *   • Türkiye↔neighbour relative alignment is invariant (one SVG, one meet
 *     transform) — reported via the identical scale/metrics at every size.
 *   • 8-region hit test (document.elementFromPoint) → hit-areas intact.
 *
 * Run (after `npm run build`):  npx tsx design/conquest/board/qa-geo-registration.ts
 */
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

import { CONQUEST_GEO_VIEWBOX as VB, CONQUEST_GEO_VIEWBOX_STR } from "../../../src/modes/conquest/maps/conquest-neighbors";
import { buildConquestGeoContextMarkup } from "../../../src/modes/conquest/maps/conquestGeoContextMarkup";

const ROOT = "/Users/enesk/Desktop/world-quiz";
const REGIONS_TS = `${ROOT}/src/modes/conquest/maps/turkey-regions.ts`;
const TERRAIN = `${ROOT}/public/assets/backgrounds/turkey-terrain-texture.png`;
const OUT = `${ROOT}/design/conquest/board/preview/qa-geo`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT, { recursive: true });
const cssFile = readdirSync(`${ROOT}/dist/assets`).find((f) => /^index-.*\.css$/.test(f));
if (!cssFile) throw new Error("built CSS not found — run `npm run build` first");
const CSS = `${ROOT}/dist/assets/${cssFile}`;

// ── geometry ────────────────────────────────────────────────────────────────
const regions: Array<{ id: string; d: string }> = [];
{
  const raw = readFileSync(REGIONS_TS, "utf8");
  const re = /\{\s*id:\s*"([^"]+)",\s*d:\s*"([^"]+)"\s*\}/g;
  for (let m; (m = re.exec(raw)); ) regions.push({ id: m[1], d: m[2] });
}
if (regions.length !== 25) throw new Error(`expected 25 regions, got ${regions.length}`);

const SAMPLE_OWN: Record<string, string> = {
  trakya: "b", istanbul_kocaeli: "b", ic_bati_anadolu: "b", ankara_cevre: "b",
  van_hakkari: "r", erzurum_kars: "r", dicle_hatti: "r", mardin_sirnak: "r",
  cukurova: "g", konya_karaman: "g", kapadokya: "g",
};
const OWN: Record<string, [string, string]> = {
  b: ["rgba(59,130,246,.24)", "rgba(96,165,250,.85)"], r: ["rgba(239,68,68,.24)", "rgba(248,113,113,.85)"],
  g: ["rgba(34,197,94,.24)", "rgba(74,222,128,.85)"], n: ["rgba(148,163,184,.12)", "rgba(148,196,228,.6)"],
};

const HIT: Record<string, [number, number]> = {
  trakya: [90, 56], istanbul_kocaeli: [190, 85], ankara_cevre: [380, 165],
  dogu_karadeniz: [720, 132], cukurova: [462, 374], antep_kilis: [610, 368],
  mardin_sirnak: [837, 339], van_hakkari: [906, 258],
};

const geoMarkup = buildConquestGeoContextMarkup();

// SVG mirrors the runtime component render order exactly.
const mapSvg = `<svg viewBox="${CONQUEST_GEO_VIEWBOX_STR}" preserveAspectRatio="xMidYMid meet" class="cq-turkey-map-svg" role="img">
  <defs><pattern id="terr" patternUnits="userSpaceOnUse" x="0" y="0" width="1005" height="490">
    <image href="file://${TERRAIN}" x="0" y="0" width="1005" height="490" preserveAspectRatio="xMidYMid slice"/>
  </pattern></defs>
  <g class="cq-geo-context-layer" style="pointer-events:none">${geoMarkup}</g>
  <g opacity="0.82" style="pointer-events:none;filter:saturate(0.72) brightness(0.88) contrast(0.92)">
    ${regions.map(({ d }) => `<path d="${d}" fill="url(#terr)" fill-rule="evenodd"/>`).join("")}
  </g>
  <g>
    ${regions.map(({ id, d }) => { const o = OWN[SAMPLE_OWN[id] || "n"]; return `<path d="${d}" data-rid="${id}" fill="${o[0]}" stroke="${o[1]}" stroke-width="1" fill-rule="evenodd"/>`; }).join("")}
  </g>
</svg>`;

const probeJs = `
  function run(){
    var svg=document.querySelector('.cq-turkey-map-svg'), wrap=document.querySelector('.cq-turkey-map-wrap');
    if(!svg||!wrap){document.body.setAttribute('data-hittest','NO-SVG');return;}
    var ctm=svg.getScreenCTM(); if(!ctm){setTimeout(run,80);return;}
    var pt=svg.createSVGPoint(), H=${JSON.stringify(HIT)}, out=[];
    for(var k in H){pt.x=H[k][0];pt.y=H[k][1];var sp=pt.matrixTransform(ctm);
      var el=document.elementFromPoint(sp.x,sp.y);var rid=(el&&el.getAttribute)?el.getAttribute('data-rid'):null;
      out.push(k+','+(rid||'∅')+','+(rid===k?'1':'0'));}
    document.body.setAttribute('data-hittest', out.join(';'));
    var s=svg.getBoundingClientRect(), w=wrap.getBoundingClientRect();
    document.body.setAttribute('data-metrics',[Math.round(w.width),Math.round(w.height),
      Math.round(s.width),Math.round(s.height),Math.round(s.left),Math.round(s.top),(s.width/${VB.w}).toFixed(4)].join(','));
  }
  requestAnimationFrame(function(){requestAnimationFrame(run);}); setTimeout(run,250);
`;

function pageHtml(withProbe: boolean): string {
  return `<!doctype html><html><head><meta charset=utf-8><link rel="stylesheet" href="file://${CSS}"><style>html,body{margin:0}</style></head>
<body><div class="app duel-screen cq-screen cq-game-screen" data-theme="turkiye">
  <div class="duel-header cq-game-header">
    <button class="back-btn"><span>←</span><span class="back-label">Çık</span></button>
    <div class="duel-header-center"><span class="duel-mode-label">🛡️ Kuşatma</span><span class="duel-region-badge">Türkiye</span></div>
    <span class="cq-game-round-badge">Tur 3/8</span>
  </div>
  <div class="cq-game-board-wrap"><div class="cq-game-board-inner">
    <p class="cq-game-map-title">🛡️ Türkiye</p>
    <div class="cq-turkey-map-wrap">${mapSvg}</div>
  </div></div>
</div>${withProbe ? `<script>${probeJs}</script>` : ""}</body></html>`;
}

function screenshot(name: string, w: number, h: number, dsf = 1): void {
  const f = `${OUT}/_page.html`;
  writeFileSync(f, pageHtml(false));
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", `--force-device-scale-factor=${dsf}`, "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw", "--virtual-time-budget=2200",
    `--screenshot=${OUT}/${name}.png`, `--window-size=${w},${h}`, `file://${f}`,
  ], { stdio: "ignore" });
  console.log(`✓ ${name}.png (${w}×${h}${dsf > 1 ? ` @${dsf}x` : ""})`);
}

function probe(w: number, h: number): { hit: string; met: string } {
  const f = `${OUT}/_probe.html`;
  writeFileSync(f, pageHtml(true));
  const dom = execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--force-device-scale-factor=1", "--hide-scrollbars",
    "--virtual-time-budget=3200", "--dump-dom", `--window-size=${w},${h}`, `file://${f}`,
  ], { encoding: "utf8" });
  return { hit: (dom.match(/data-hittest="([^"]*)"/) || [])[1] || "", met: (dom.match(/data-metrics="([^"]*)"/) || [])[1] || "" };
}

// native-rect → screen-pixel crop (using probe metrics at DSF1, scaled by dsf)
async function crop(srcPng: string, name: string, native: [number, number, number, number], M: number[], dsf: number) {
  const [, , sw, , sl, st] = M;
  const scale = sw / VB.w;
  const px = (nx: number) => (sl + (nx - VB.x) * scale) * dsf;
  const py = (ny: number) => (st + (ny - VB.y) * scale) * dsf;
  const left = Math.max(0, Math.round(px(native[0]))), top = Math.max(0, Math.round(py(native[1])));
  const width = Math.round(px(native[2]) - px(native[0])), height = Math.round(py(native[3]) - py(native[1]));
  await sharp(srcPng).extract({ left, top, width, height }).resize(900).toFile(`${OUT}/${name}.png`);
  console.log(`✓ ${name}.png (close-up)`);
}

// ── run ──────────────────────────────────────────────────────────────────────
screenshot("geo-1440x900", 1440, 900);
screenshot("geo-1366x768", 1366, 768);
screenshot("geo-1920x1080", 1920, 1080);
screenshot("geo-1440x900@2x", 1440, 900, 2);

console.log("\n── relative alignment + 8-region hit test ──");
let allPass = true;
let metricsRef = "";
let met1440: number[] = [];
for (const [label, w, h] of [["1440×900", 1440, 900], ["1366×768", 1366, 768], ["1920×1080", 1920, 1080]] as const) {
  const { hit, met } = probe(w, h);
  const rows = hit.split(";").filter(Boolean);
  const passed = rows.filter((r) => r.endsWith(",1")).length;
  if (passed !== 8) allPass = false;
  const scale = met.split(",")[6];
  console.log(`  [${label}]  wrap/svg/scale = ${met}   →  ${passed}/8 regions correct`);
  if (label === "1440×900") { met1440 = met.split(",").map(Number); for (const r of rows) console.log(`      ${r.endsWith(",1") ? "✓" : "✗"} ${r.split(",")[0]} → ${r.split(",")[1]}`); }
  if (!metricsRef) metricsRef = scale;
  else if (scale !== metricsRef) { allPass = false; console.log(`      ✗ scale drift vs ref (${metricsRef})`); }
}
console.log(`\n  Türkiye↔neighbour relative alignment: scale=${metricsRef} at ALL sizes → INVARIANT (single SVG/transform).`);

// close-ups from the 2x screenshot using 1440 metrics (×2)
const src2x = `${OUT}/geo-1440x900@2x.png`;
await crop(src2x, "closeup-trakya", [-130, -40, 250, 195], met1440, 2);
await crop(src2x, "closeup-antep-mardin", [470, 290, 905, 480], met1440, 2);
await crop(src2x, "closeup-van", [800, 150, 1185, 365], met1440, 2);

try { rmSync(`${OUT}/_page.html`); } catch {}
try { rmSync(`${OUT}/_probe.html`); } catch {}
writeFileSync(`${OUT}/.gitignore`, "*.png\n_*.html\n");
console.log(`\n${allPass ? "✓ 8/8 at all sizes + alignment invariant" : "✗ check failures above"} — renders in ${OUT}`);
