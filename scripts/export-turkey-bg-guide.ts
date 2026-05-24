/**
 * Türkiye Kuşatması — background alignment guide exporter.
 *
 * Produces a PNG template that visualizes where the in-game Türkiye SVG map
 * sits inside the conquest board, so generated background art (DALL·E,
 * Gemini, …) can be aligned pixel-for-pixel with the foreground map.
 *
 * Outputs:
 *   public/debug/turkey-bg-guide-915x726.png    (1× board template)
 *   public/debug/turkey-bg-guide-3660x2904.png  (4× master)
 *
 * Run:
 *   npx tsx scripts/export-turkey-bg-guide.ts
 *
 * This script is a one-off generator. It does NOT touch game logic or the
 * TurkeyConquestMap component — only the merged region paths are imported.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

import { TURKEY_CONQUEST_REGION_PATHS } from "../src/modes/conquest/maps/turkey-regions";

// ─── Board / overlay geometry ────────────────────────────────────────────────

const BOARD_W = 915;
const BOARD_H = 726;

const OVERLAY_X = 0;
const OVERLAY_Y = 50;
const OVERLAY_W = 915;
const OVERLAY_H = 446;

// Source SVG viewBox for the merged region paths.
const SRC_VB_W = 1005;
const SRC_VB_H = 490;

// Region labels (mirrors TurkeyConquestMap.tsx so the guide reads cleanly).
const REGION_LABELS: Record<string, string> = {
  trakya: "Trakya",
  istanbul_kocaeli: "İstanbul",
  guney_marmara: "G. Marmara",
  bati_karadeniz: "Batı Kara.",
  orta_karadeniz: "Orta Kara.",
  dogu_karadeniz: "Doğu Kara.",
  kuzeydogu_anadolu: "KD Anadolu",
  kuzey_ege: "Kuzey Ege",
  guney_ege: "Güney Ege",
  bati_akdeniz: "Batı Akd.",
  cukurova: "Çukurova",
  ic_bati_anadolu: "İç Batı",
  ankara_cevre: "Ankara",
  konya_karaman: "Konya",
  kapadokya: "Kapadokya",
  orta_anadolu: "Orta Anad.",
  erzurum_kars: "Erzurum",
  van_hakkari: "Van",
  malatya_elazig: "Malatya",
  firat_hatti: "Fırat",
  dicle_hatti: "Dicle",
  antep_kilis: "Antep",
  hatay_osmaniye: "Hatay",
  mardin_sirnak: "Mardin",
  kars: "Kars",
};

const REGION_LABEL_POS: Record<string, { x: number; y: number }> = {
  trakya: { x: 90, y: 56 },
  istanbul_kocaeli: { x: 190, y: 85 },
  guney_marmara: { x: 130, y: 155 },
  bati_karadeniz: { x: 378, y: 68 },
  orta_karadeniz: { x: 508, y: 110 },
  dogu_karadeniz: { x: 720, y: 132 },
  kuzeydogu_anadolu: { x: 710, y: 186 },
  kars: { x: 915, y: 176 },
  kuzey_ege: { x: 112, y: 243 },
  guney_ege: { x: 132, y: 320 },
  bati_akdeniz: { x: 235, y: 345 },
  cukurova: { x: 462, y: 362 },
  ic_bati_anadolu: { x: 255, y: 205 },
  ankara_cevre: { x: 380, y: 165 },
  konya_karaman: { x: 352, y: 298 },
  kapadokya: { x: 490, y: 270 },
  orta_anadolu: { x: 555, y: 195 },
  erzurum_kars: { x: 820, y: 172 },
  van_hakkari: { x: 906, y: 258 },
  malatya_elazig: { x: 678, y: 268 },
  firat_hatti: { x: 648, y: 320 },
  dicle_hatti: { x: 785, y: 285 },
  antep_kilis: { x: 610, y: 362 },
  hatay_osmaniye: { x: 552, y: 386 },
  mardin_sirnak: { x: 840, y: 330 },
};

// ─── SVG builder ─────────────────────────────────────────────────────────────

function buildGuideSvg(): string {
  // Map source viewBox (1005×490) → overlay rect (915×446 at (0,50)).
  // preserveAspectRatio="xMidYMid meet" in the live component yields a near-
  // identical fit (1005/490 ≈ 2.0510, 915/446 ≈ 2.0516); we therefore use
  // independent x/y scales so the guide matches the rendered map exactly.
  const sx = OVERLAY_W / SRC_VB_W;
  const sy = OVERLAY_H / SRC_VB_H;

  const regionPaths = TURKEY_CONQUEST_REGION_PATHS
    .map(
      ({ id, d }) =>
        `<path data-id="${id}" d="${d}" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.85)" stroke-width="0.8" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>`,
    )
    .join("\n      ");

  // Composite outline: same paths rendered again with no fill and a stronger
  // stroke so the outer silhouette reads clearly even under the per-region
  // borders.
  const outlineLayer = TURKEY_CONQUEST_REGION_PATHS
    .map(
      ({ d }) =>
        `<path d="${d}" fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="1.4" stroke-linejoin="round" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>`,
    )
    .join("\n      ");

  const labels = TURKEY_CONQUEST_REGION_PATHS
    .map(({ id }) => {
      const pos = REGION_LABEL_POS[id];
      const label = REGION_LABELS[id] ?? id;
      if (!pos) return "";
      return `<text x="${pos.x}" y="${pos.y}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(255,255,255,0.92)" stroke="rgba(0,0,0,0.85)" stroke-width="2.4" paint-order="stroke fill">${label}</text>`;
    })
    .filter(Boolean)
    .join("\n      ");

  // Light grid every 50 px across the full board for visual reference.
  const gridLines: string[] = [];
  for (let x = 0; x <= BOARD_W; x += 50) {
    gridLines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${BOARD_H}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`,
    );
  }
  for (let y = 0; y <= BOARD_H; y += 50) {
    gridLines.push(
      `<line x1="0" y1="${y}" x2="${BOARD_W}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_W} ${BOARD_H}" width="${BOARD_W}" height="${BOARD_H}">
  <!-- board background -->
  <rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" fill="#0b1220"/>

  <!-- reference grid (every 50 board px) -->
  <g>
    ${gridLines.join("\n    ")}
  </g>

  <!-- overlay rectangle: where the live Türkiye SVG map is placed -->
  <rect
    x="${OVERLAY_X}" y="${OVERLAY_Y}"
    width="${OVERLAY_W}" height="${OVERLAY_H}"
    fill="none"
    stroke="rgba(96,165,250,0.85)"
    stroke-width="1.5"
    stroke-dasharray="6 4"
  />
  <text
    x="${OVERLAY_X + 8}" y="${OVERLAY_Y + 16}"
    font-family="sans-serif" font-size="12" font-weight="700"
    fill="rgba(147,197,253,0.95)">
    Türkiye map overlay — ${OVERLAY_W}×${OVERLAY_H} @ (${OVERLAY_X},${OVERLAY_Y})
  </text>

  <!-- Türkiye regions, transformed into board space -->
  <g transform="translate(${OVERLAY_X} ${OVERLAY_Y}) scale(${sx} ${sy})">
    <!-- region fills + per-region borders -->
    <g>
      ${regionPaths}
    </g>
    <!-- composite outline pass -->
    <g>
      ${outlineLayer}
    </g>
  </g>

  <!-- region labels (drawn in board space, matching map label positions) -->
  <g transform="translate(${OVERLAY_X} ${OVERLAY_Y}) scale(${sx} ${sy})">
    ${labels}
  </g>

  <!-- corner ticks for the overlay rect -->
  <g stroke="rgba(96,165,250,0.95)" stroke-width="2" fill="none">
    <path d="M${OVERLAY_X} ${OVERLAY_Y + 10} L${OVERLAY_X} ${OVERLAY_Y} L${OVERLAY_X + 10} ${OVERLAY_Y}"/>
    <path d="M${OVERLAY_X + OVERLAY_W - 10} ${OVERLAY_Y} L${OVERLAY_X + OVERLAY_W} ${OVERLAY_Y} L${OVERLAY_X + OVERLAY_W} ${OVERLAY_Y + 10}"/>
    <path d="M${OVERLAY_X} ${OVERLAY_Y + OVERLAY_H - 10} L${OVERLAY_X} ${OVERLAY_Y + OVERLAY_H} L${OVERLAY_X + 10} ${OVERLAY_Y + OVERLAY_H}"/>
    <path d="M${OVERLAY_X + OVERLAY_W - 10} ${OVERLAY_Y + OVERLAY_H} L${OVERLAY_X + OVERLAY_W} ${OVERLAY_Y + OVERLAY_H} L${OVERLAY_X + OVERLAY_W} ${OVERLAY_Y + OVERLAY_H - 10}"/>
  </g>

  <!-- caption -->
  <text x="${BOARD_W / 2}" y="${BOARD_H - 14}"
        text-anchor="middle"
        font-family="sans-serif" font-size="13" font-weight="600"
        fill="rgba(226,232,240,0.85)">
    Türkiye Kuşatması — background alignment guide (board ${BOARD_W}×${BOARD_H})
  </text>
</svg>`;
}

// ─── Rasterize to two PNGs (1× and 4×) ───────────────────────────────────────

function rasterize(svg: string, outWidth: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: outWidth },
    background: "rgba(0,0,0,0)", // honor SVG’s own background rect
    font: { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, "..", "public", "debug");
  mkdirSync(outDir, { recursive: true });

  const svg = buildGuideSvg();

  const targets: Array<{ width: number; height: number; file: string }> = [
    { width: 915, height: 726, file: "turkey-bg-guide-915x726.png" },
    { width: 3660, height: 2904, file: "turkey-bg-guide-3660x2904.png" },
  ];

  for (const t of targets) {
    const png = rasterize(svg, t.width);
    const outPath = resolve(outDir, t.file);
    writeFileSync(outPath, png);
    console.log(`✓ wrote ${outPath}  (${t.width}×${t.height})`);
  }
}

main();
