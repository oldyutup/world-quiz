/**
 * Overscan Board — registration QA harness.
 *
 * Reproduces the real active Kuşatma game-screen DOM (desktop + mobile mcq
 * shell), links the REAL compiled app CSS (dist/assets/index-*.css), supplies
 * the overscan WebP + terrain via file://, and runs the SAME registration math
 * as the runtime ConquestOverscanBoard hook (incl. the meet-letterbox fit).
 * Screenshots at production viewport sizes via headless Chrome.
 *
 * This validates registration geometry + CSS (war-map removed, isolation,
 * map-wrap sizing untouched) without a live multiplayer match. It is NOT a
 * live-app capture; in-app QA on a real match stays the manual step.
 *
 * Run:  node design/conquest/board/qa-registration.mjs
 */
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT    = "/Users/enesk/Desktop/world-quiz";
const SRC     = `${ROOT}/src/modes/conquest/maps/turkey-regions.ts`;
const DIR     = `${ROOT}/design/conquest/board`;
const OUT      = `${DIR}/preview/qa`;
const TERRAIN = `${ROOT}/public/assets/backgrounds/turkey-terrain-texture.png`;
const WEBP    = `${ROOT}/public/assets/backgrounds/conquest-overscan-board.webp`;
const CHROME  = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT, { recursive: true });
const cssFile = readdirSync(`${ROOT}/dist/assets`).find(f => /^index-.*\.css$/.test(f));
if (!cssFile) throw new Error("built CSS not found — run `npm run build` first");
const CSS = `${ROOT}/dist/assets/${cssFile}`;

// ── union geometry → terrain SVG markup ─────────────────────────────────────
const raw = readFileSync(SRC, "utf8");
const re = /\{\s*id:\s*"([^"]+)",\s*d:\s*"([^"]+)"\s*\}/g;
const regions = [];
for (let m; (m = re.exec(raw)); ) regions.push({ id: m[1], d: m[2] });
const SAMPLE_OWN = {
  trakya:"b", istanbul_kocaeli:"b", ic_bati_anadolu:"b", ankara_cevre:"b",
  van_hakkari:"r", erzurum_kars:"r", dicle_hatti:"r", mardin_sirnak:"r",
  cukurova:"g", konya_karaman:"g", kapadokya:"g",
};
const OWN = { b:["rgba(59,130,246,.22)","rgba(59,130,246,.74)"], r:["rgba(239,68,68,.22)","rgba(239,68,68,.74)"],
  g:["rgba(34,197,94,.22)","rgba(34,197,94,.74)"], n:["rgba(148,163,184,.13)","rgba(148,196,228,.62)"] };
const mapSvg = `<svg viewBox="0 0 1005 490" preserveAspectRatio="xMidYMid meet" class="cq-turkey-map-svg" role="img">
  <defs><pattern id="terr" patternUnits="userSpaceOnUse" x="0" y="0" width="1005" height="490">
    <image href="file://${TERRAIN}" x="0" y="0" width="1005" height="490" preserveAspectRatio="xMidYMid slice"/>
  </pattern></defs>
  <g opacity="0.82" style="filter:saturate(0.72) brightness(0.88) contrast(0.92)">
    ${regions.map(({d})=>`<path d="${d}" fill="url(#terr)" fill-rule="evenodd"/>`).join("")}
  </g>
  <g>${regions.map(({id,d})=>{const o=OWN[SAMPLE_OWN[id]||"n"];return `<path d="${d}" fill="${o[0]}" stroke="${o[1]}" stroke-width="1" fill-rule="evenodd"/>`;}).join("")}</g>
</svg>`;

// registration JS — mirrors ConquestOverscanBoard.measure() incl. letterbox fit
const regJs = `
  function measure(){
    var screen=document.querySelector('.cq-game-screen');
    var wrap=document.querySelector('.cq-turkey-map-wrap');
    var layer=document.querySelector('.cq-overscan-board');
    if(!screen||!wrap||!layer)return;
    var s=screen.getBoundingClientRect(), m=wrap.getBoundingClientRect();
    if(m.width<1||m.height<1)return;
    var RA=1005/490, gw=m.width, gh=m.height;
    if(gw/gh>RA)gw=gh*RA; else gh=gw/RA;
    var gL=m.left+(m.width-gw)/2, gT=m.top+(m.height-gh)/2, sc=gw/1005;
    screen.style.setProperty('--cq-os-left',(gL-s.left-200*sc)+'px');
    screen.style.setProperty('--cq-os-top',(gT-s.top-70*sc)+'px');
    screen.style.setProperty('--cq-os-w',(1405*sc)+'px');
    screen.style.setProperty('--cq-os-h',(690*sc)+'px');
    layer.setAttribute('data-ready','');
  }
  measure(); requestAnimationFrame(measure); addEventListener('load',measure); setTimeout(measure,300);
`;

const overscanInline = `background-image:url('file://${WEBP}')`;

function desktopHtml(overlays) {
  const ov = overlays ? `
    <div style="position:absolute;left:50%;bottom:18px;transform:translateX(-50%);width:min(560px,46vw);height:96px;background:rgba(22,27,34,.92);border:1px solid #30363d;border-radius:14px;z-index:30;display:flex;align-items:center;justify-content:center;color:#7d8590;font:600 13px 'DM Sans',sans-serif">soru kartı overlay</div>
    <div style="position:absolute;right:14px;top:64px;width:230px;height:62%;background:rgba(22,27,34,.9);border:1px solid #30363d;border-radius:14px;z-index:30;display:flex;align-items:center;justify-content:center;color:#7d8590;font:600 13px 'DM Sans',sans-serif">oyuncu / bonus paneli</div>` : "";
  return `<!doctype html><html><head><meta charset=utf-8><link rel="stylesheet" href="file://${CSS}"><style>html,body{margin:0}</style></head>
<body><div class="app duel-screen cq-screen cq-game-screen" data-theme="turkiye">
  <div class="cq-overscan-board" style="${overscanInline}"></div>
  <div class="duel-header cq-game-header">
    <button class="back-btn"><span>←</span><span class="back-label">Çık</span></button>
    <div class="duel-header-center"><span class="duel-mode-label">🛡️ Kuşatma</span><span class="duel-region-badge">Türkiye</span></div>
    <span class="cq-game-round-badge">Tur 3/8</span>
  </div>
  <div class="cq-game-board-wrap"><div class="cq-game-board-inner">
    <p class="cq-game-map-title">🛡️ Türkiye</p>
    <div class="cq-turkey-map-wrap">${mapSvg}</div>
  </div></div>${ov}
</div><script>${regJs}</script></body></html>`;
}

function mcqHtml(portrait) {
  return `<!doctype html><html><head><meta charset=utf-8><link rel="stylesheet" href="file://${CSS}"><style>html,body{margin:0}</style></head>
<body><div class="app duel-screen cq-screen cq-game-screen" data-theme="turkiye">
  <div class="cq-overscan-board" style="${overscanInline}"></div>
  <div class="mcq-shell ${portrait ? "mcq-shell--portrait" : "mcq-shell--landscape"}">
    <div class="mcq-header-slot"><div class="mcq-header" style="height:48px"></div></div>
    <div class="mcq-strip-slot"><div class="mcq-strip" style="height:50px;background:var(--surface);border-bottom:1px solid var(--border)"></div></div>
    <div class="mcq-map-slot"><div class="cq-turkey-map-wrap">${mapSvg}</div></div>
  </div>
</div><script>${regJs}</script></body></html>`;
}

// "before" = old generic war-map cover behind the map, no overscan layer.
const WARMAP = `${ROOT}/public/assets/backgrounds/conquest-war-map.png`;
function beforeHtml() {
  return `<!doctype html><html><head><meta charset=utf-8><link rel="stylesheet" href="file://${CSS}"><style>html,body{margin:0}
  .cq-game-screen.before-warmap{background-color:#07101c!important;background-image:linear-gradient(rgba(8,12,24,.18),rgba(8,12,24,.36)),url('file://${WARMAP}')!important;background-repeat:no-repeat!important;background-position:center!important;background-size:cover!important}</style></head>
<body><div class="app duel-screen cq-screen cq-game-screen before-warmap" data-theme="turkiye">
  <div class="duel-header cq-game-header">
    <button class="back-btn"><span>←</span><span class="back-label">Çık</span></button>
    <div class="duel-header-center"><span class="duel-mode-label">🛡️ Kuşatma</span><span class="duel-region-badge">Türkiye</span></div>
    <span class="cq-game-round-badge">Tur 3/8</span>
  </div>
  <div class="cq-game-board-wrap"><div class="cq-game-board-inner">
    <p class="cq-game-map-title">🛡️ Türkiye</p>
    <div class="cq-turkey-map-wrap">${mapSvg}</div>
  </div></div>
</div></body></html>`;
}

function shot(html, name, w, h) {
  const f = `${OUT}/_h.html`;
  writeFileSync(f, html);
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--force-device-scale-factor=1", "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw", "--virtual-time-budget=1600",
    `--screenshot=${OUT}/${name}.png`, `--window-size=${w},${h}`, `file://${f}`,
  ], { stdio: "ignore" });
  console.log(`✓ ${name}.png (${w}×${h})`);
}

shot(beforeHtml(), "before-warmap-1440x900", 1440, 900);
shot(beforeHtml(), "before-warmap-2560x1080", 2560, 1080);
shot(desktopHtml(false), "desktop-1366x768", 1366, 768);
shot(desktopHtml(false), "desktop-1440x900", 1440, 900);
shot(desktopHtml(false), "desktop-1920x1080", 1920, 1080);
shot(desktopHtml(false), "desktop-2560x1080-ultrawide", 2560, 1080);
shot(desktopHtml(true),  "desktop-1440x900-overlays", 1440, 900);
shot(mcqHtml(true),  "mobile-portrait-390x844", 390, 844);
shot(mcqHtml(false), "mobile-landscape-844x390", 844, 390);
try { rmSync(`${OUT}/_h.html`); } catch {}
console.log("\n✓ QA renders in", OUT);
