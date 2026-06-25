/* eslint-disable */
/**
 * Kuşatma · REAL-app map-rect phase-invariance + production-look proof.
 *
 * Drives the DEV route /conquest-phase-test (real ConquestGame, real desktop
 * shell + safe-stage geometry hook + real phase panels) across the 5 gameplay
 * phases at 3 viewports via headless Chrome.  Reads the in-page measurements
 * (.cq-turkey-map-wrap + main SVG getBoundingClientRect + SVG screen-CTM +
 * 8-region hit test) and asserts the map rect is identical across phases within
 * each viewport.  Then captures production screenshots + the 3 contact close-ups.
 *
 * Requires the dev server running (npm run dev) on PORT below.
 * Run:  npx tsx design/conquest/board/qa-phase-rect.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { CONQUEST_GEO_VIEWBOX as VB } from "../../../src/modes/conquest/maps/conquest-neighbors";

const PORT = Number(process.env.PORT ?? 5174);
// Standalone QA harness page (design/), NOT a production route. Served by `vite`
// dev on demand; never part of the shipping bundle.
const BASE = `http://localhost:${PORT}/design/conquest/board/qa-phase-harness.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "/Users/enesk/Desktop/world-quiz/design/conquest/board/preview/qa-phase";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS: Array<[string, number, number]> = [
  ["1440x900", 1440, 900], ["1366x768", 1366, 768], ["1920x1080", 1920, 1080],
];
const PHASES = ["tur-baslangıcı", "soru-kartı", "cevap-kaydedildi", "reveal", "action"];

function dumpOnce(p: number, w: number, h: number): Record<string, string> {
  const dom = execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--disable-software-rasterizer", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--virtual-time-budget=12000", "--dump-dom",
    `--window-size=${w},${h}`, `${BASE}?p=${p}`,
  ], { encoding: "utf8", maxBuffer: 96 * 1024 * 1024 });
  const g = (k: string) => (dom.match(new RegExp(`data-${k}="([^"]*)"`)) || [])[1] || "";
  return { phase: g("phase"), wrap: g("rect-wrap"), svg: g("rect-svg"), ctm: g("ctm"), hits: g("hits"), ready: g("ready") };
}
function dump(p: number, w: number, h: number): Record<string, string> {
  // Retry on a flaked read (headless GPU hiccup → measure didn't reach ready).
  for (let i = 0; i < 3; i++) {
    const r = dumpOnce(p, w, h);
    if (r.ready === "1" && r.wrap) return r;
  }
  return dumpOnce(p, w, h);
}

function shot(p: number, w: number, h: number, name: string, dsf = 1) {
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${dsf}`,
    "--run-all-compositor-stages-before-draw", "--virtual-time-budget=9000",
    `--screenshot=${OUT}/${name}.png`, `--window-size=${w},${h}`, `${BASE}?p=${p}`,
  ], { stdio: "ignore" });
}

async function crop(srcPng: string, name: string, native: [number, number, number, number], svgRect: number[], dsf: number) {
  const [sw, , st, sl] = svgRect; // width,height,top,left
  const scale = sw / VB.w;
  const px = (nx: number) => (sl + (nx - VB.x) * scale) * dsf;
  const py = (ny: number) => (st + (ny - VB.y) * scale) * dsf;
  const left = Math.max(0, Math.round(px(native[0]))), top = Math.max(0, Math.round(py(native[1])));
  const width = Math.round(px(native[2]) - px(native[0])), height = Math.round(py(native[3]) - py(native[1]));
  await sharp(srcPng).extract({ left, top, width, height }).resize(880).toFile(`${OUT}/${name}.png`);
}

(async () => {
  let allOk = true;
  for (const [vp, w, h] of VIEWPORTS) {
    console.log(`\n══════ ${vp} ══════`);
    const rows = PHASES.map((_, p) => ({ p, ...dump(p, w, h) }));
    console.log("  phase             | wrap rect (w,h,top,left)        | svg rect (w,h,top,left)         | ctm a,d  | hits");
    let refWrap = "", refSvg = "", refScale = "";
    for (const r of rows) {
      const hitPass = r.hits.split(";").filter(Boolean).filter((x) => x.endsWith(":1")).length;
      const scale = r.ctm.split(",").slice(0, 2).join(",");
      console.log(`  ${PHASES[r.p].padEnd(17)} | ${r.wrap.padEnd(30)} | ${r.svg.padEnd(30)} | ${scale.padEnd(8)} | ${hitPass}/8`);
      if (!refWrap) { refWrap = r.wrap; refSvg = r.svg; refScale = scale; }
      else if (r.wrap !== refWrap || r.svg !== refSvg || scale !== refScale) { allOk = false; console.log("     ✗ DRIFT vs phase 0"); }
      if (hitPass !== 8) { allOk = false; console.log(`     ✗ hit test ${hitPass}/8`); }
      if (r.ready !== "1") { allOk = false; console.log("     ✗ not ready"); }
    }
    const same = rows.every((r) => r.wrap === rows[0].wrap && r.svg === rows[0].svg);
    console.log(`  → map rect ${same ? "IDENTICAL across all 5 phases ✓" : "DRIFTS ✗"}   (wrap===svg: ${rows[0].wrap === rows[0].svg})`);

    // production full screenshot (every viewport)
    shot(4, w, h, `phase-${vp}-action`);
    // 5-zone geo-topology close-ups — only at 1920 (largest map → best detail), @3×.
    if (vp === "1920x1080") {
      shot(4, w, h, `_cropsrc`, 3);
      const svgRect = rows[4].svg.split(",").map(Number);
      const ZONES: Array<[string, [number, number, number, number]]> = [
        ["1-trakya-bulgaria-greece-aegean", [-130, -55, 295, 255]],
        ["2-canakkale-marmara-aegean", [35, 55, 320, 265]],
        ["3-antep-mardin-syria-iraq", [460, 285, 912, 488]],
        ["4-van-iran", [795, 148, 1192, 372]],
        ["5-cyprus", [300, 405, 545, 545]],
      ];
      for (const [name, rect] of ZONES) await crop(`${OUT}/_cropsrc.png`, `geo-${name}`, rect, svgRect, 3);
    }
    console.log(`  ✓ screenshots${vp === "1920x1080" ? " + 5 geo close-ups" : ""} (${vp})`);
  }
  writeFileSync(`${OUT}/.gitignore`, "*.png\n_*.png\n");
  console.log(`\n${allOk ? "✓ ALL phases invariant + 8/8 hits at every viewport" : "✗ failures above"} — ${OUT}`);
})();
