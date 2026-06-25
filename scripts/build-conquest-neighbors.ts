/* eslint-disable */
/**
 * Kuşatma · Phase-1 geo-context generator (geometry / registration proof).
 *
 * Türkiye's playable region paths (ali-han/Turkey-SVG-Map, viewBox 1005×490)
 * are the SINGLE source of truth and are NEVER reshaped.  This tool fits ONE
 * build-time registration transform that maps real-world lon/lat into that same
 * native viewBox frame, then projects Türkiye's REAL neighbours (Natural-Earth
 * 110m, vendored at public/data/countries-110m.json) into the frame so they
 * slot in around Türkiye at their true geographic positions.
 *
 * Pipeline
 * --------
 *   1. Control points: a curated lon/lat table for ~30 Turkish provinces is
 *      paired with each province's NATIVE centroid (computed from the ali-han
 *      province path).  A least-squares affine A is fitted so that
 *          native ≈ A · mercator(lon,lat)
 *      Residuals are reported (RMS in native px).  This affine IS the Türkiye
 *      registration transform — Türkiye itself stays at identity (it defines
 *      the frame); the affine only places real geography around it.
 *   2. Each neighbour country polygon is run through mercator → A → native,
 *      dilated a few native units toward Türkiye (clipper offset) so its shared
 *      LAND border overlaps Türkiye's border, then simplified.  At render time
 *      an exterior mask (Türkiye's silhouette) trims the overlap, so the shared
 *      edge IS Türkiye's edge — seam-free, no sea sliver, no double coast.  Sea
 *      coasts (Aegean W, Mediterranean S, Black Sea N) have no neighbour land,
 *      so they stay open water.
 *   3. The expanded canvas (viewBox) is the union bbox of Türkiye + neighbours,
 *      padded to EXACTLY the runtime 1005/490 aspect so the desktop
 *      `.cq-turkey-map-wrap` (aspect-ratio 1005/490) shows it with NO letterbox
 *      and the safe-stage CSS stays untouched.
 *
 * Emits src/modes/conquest/maps/conquest-neighbors.ts (committed, runtime).
 * Phase 1 is FLAT / MUTED on purpose — internal proof, not final art.
 *
 * Run:  npx tsx scripts/build-conquest-neighbors.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import svgpath from "svgpath";
import ClipperLib from "clipper-lib";
import simplify from "simplify-js";
import { geoMercator } from "d3-geo";
import { feature } from "topojson-client";

import { TURKEY_PROVINCES } from "../src/modes/conquest/maps/turkey-provinces";
import { TURKEY_CONQUEST_REGION_PATHS } from "../src/modes/conquest/maps/turkey-regions";

// ─── Constants ───────────────────────────────────────────────────────────────

const NATIVE_VB_W = 1005;
const NATIVE_VB_H = 490;
const TARGET_ASPECT = NATIVE_VB_W / NATIVE_VB_H; // 2.05102… — desktop wrap aspect

const BEZIER_STEPS = 16;          // province path flattening (centroids only)
const DILATE_LAND = 26;           // native units; land neighbours overshoot the
                                  //   shared border so the exterior mask trims a
                                  //   seam-free edge (no undershoot sea sliver).
const DILATE_ISLAND = 0;          // Cyprus stays an island — never dilated.
const CLIPPER_SCALE = 1000;       // native units → clipper ints
const SIMPLIFY_TOL = 0.6;         // native units; 110m is already coarse

// Context window = Türkiye's native bbox grown by these fractions per side, so
// neighbours read as bordering context and Türkiye stays the DOMINANT play area
// (≈75% of canvas width).  Composition is fixed here (canvas margins), never via
// CSS/viewport — Türkiye's playable weight is owned by the geo-canvas itself.
const WIN_L = 0.15, WIN_R = 0.17, WIN_T = 0.15, WIN_B = 0.30;
const ISLAND_KEYS = new Set(["cyprus"]);

// Türkiye's real neighbours (Natural-Earth ISO-numeric ids in countries-110m).
// Azerbaijan (031) is a MultiPolygon → its Nahçıvan exclave (bordering Iğdır)
// comes for free.  Cyprus is the de-facto whole island (196 + unnamed N. Cyprus).
const NEIGHBOR_IDS: Array<{ id: string; key: string; name: string }> = [
  { id: "300", key: "greece", name: "Yunanistan" },
  { id: "100", key: "bulgaria", name: "Bulgaristan" },
  { id: "268", key: "georgia", name: "Gürcistan" },
  { id: "051", key: "armenia", name: "Ermenistan" },
  { id: "031", key: "azerbaijan", name: "Azerbaycan" },
  { id: "364", key: "iran", name: "İran" },
  { id: "368", key: "iraq", name: "Irak" },
  { id: "760", key: "syria", name: "Suriye" },
  { id: "196", key: "cyprus", name: "Kıbrıs" },
];
const CYPRUS_NAMES = new Set(["Cyprus", "N. Cyprus", "Northern Cyprus"]);

// Control points: provinceId → [lon, lat] (provincial-capital coords; the
// least-squares fit over ~30 well-spread points absorbs capital↔centroid noise).
const CONTROL_LONLAT: Record<string, [number, number]> = {
  edirne: [26.56, 41.68], kirklareli: [27.22, 41.74], tekirdag: [27.51, 40.98],
  istanbul: [28.97, 41.01], canakkale: [26.41, 40.16], balikesir: [27.89, 39.65],
  bursa: [29.06, 40.18], izmir: [27.14, 38.42], aydin: [27.85, 37.85],
  mugla: [28.36, 37.22], denizli: [29.09, 37.78], antalya: [30.71, 36.90],
  isparta: [30.55, 37.76], afyonkarahisar: [30.54, 38.76], ankara: [32.85, 39.93],
  eskisehir: [30.52, 39.78], konya: [32.48, 37.87], mersin: [34.64, 36.81],
  adana: [35.32, 37.00], nigde: [34.68, 37.97], kayseri: [35.49, 38.73],
  sivas: [37.02, 39.75], samsun: [36.33, 41.29], sinop: [35.15, 42.03],
  ordu: [37.88, 40.98], trabzon: [39.72, 41.00], rize: [40.52, 41.02],
  erzurum: [41.27, 39.90], kars: [43.10, 40.60], igdir: [44.04, 39.92],
  van: [43.38, 38.49], hakkari: [43.74, 37.57], sirnak: [42.46, 37.52],
  mardin: [40.74, 37.31], sanliurfa: [38.79, 37.17], diyarbakir: [40.21, 37.91],
  gaziantep: [37.38, 37.07], hatay: [36.16, 36.20], malatya: [38.31, 38.35],
  elazig: [39.22, 38.68], erzincan: [39.49, 39.75], tokat: [36.55, 40.31],
};

// ─── Path flattening (province centroids + neighbour reuse) ───────────────────

type Pt = [number, number];
type Ring = Pt[];

function flattenToRings(d: string): Ring[] {
  const rings: Ring[] = [];
  let cur: Ring = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  const close = () => { if (cur.length >= 3) rings.push(cur); cur = []; };
  svgpath(d).abs().unarc().unshort().iterate((seg) => {
    const c = seg[0] as string;
    if (c === "M") { close(); x = seg[1] as number; y = seg[2] as number; sx = x; sy = y; cur.push([x, y]); }
    else if (c === "L") { x = seg[1] as number; y = seg[2] as number; cur.push([x, y]); }
    else if (c === "H") { x = seg[1] as number; cur.push([x, y]); }
    else if (c === "V") { y = seg[1] as number; cur.push([x, y]); }
    else if (c === "C") {
      const [x1, y1, x2, y2, x3, y3] = seg.slice(1) as number[];
      const px = x, py = y;
      for (let i = 1; i <= BEZIER_STEPS; i++) {
        const t = i / BEZIER_STEPS, u = 1 - t;
        cur.push([
          u*u*u*px + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3,
          u*u*u*py + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3,
        ]);
      }
      x = x3; y = y3;
    } else if (c === "Q") {
      const [x1, y1, x2, y2] = seg.slice(1) as number[];
      const px = x, py = y;
      for (let i = 1; i <= BEZIER_STEPS; i++) {
        const t = i / BEZIER_STEPS, u = 1 - t;
        cur.push([u*u*px + 2*u*t*x1 + t*t*x2, u*u*py + 2*u*t*y1 + t*t*y2]);
      }
      x = x2; y = y2;
    } else if (c === "Z" || c === "z") { x = sx; y = sy; close(); }
  });
  close();
  return rings;
}

function ringAreaCentroid(ring: Ring): { area: number; cx: number; cy: number } {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) return { area: 0, cx: ring[0][0], cy: ring[0][1] };
  return { area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) };
}

function pathCentroid(d: string): Pt {
  const rings = flattenToRings(d);
  let A = 0, X = 0, Y = 0;
  for (const r of rings) {
    const { area, cx, cy } = ringAreaCentroid(r);
    A += area; X += cx * area; Y += cy * area;
  }
  return A > 0 ? [X / A, Y / A] : [0, 0];
}

function ringsBBox(rings: Ring[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// ─── Least-squares affine solve (3 unknowns per axis) ─────────────────────────

function solve3(M: number[][], b: number[]): number[] {
  // Gaussian elimination on a 3×3 system (normal equations).
  const A = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 4; c++) A[r][c] -= f * A[col][c];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

function fitAffine(src: Pt[], dst: Pt[]): number[] {
  // Solve dstX = a·sx + b·sy + c  and  dstY = d·sx + e·sy + f  (least squares).
  const N = src.length;
  const Sxx = sum((i) => src[i][0] ** 2), Sxy = sum((i) => src[i][0] * src[i][1]);
  const Sx = sum((i) => src[i][0]), Syy = sum((i) => src[i][1] ** 2);
  const Sy = sum((i) => src[i][1]);
  const normal = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, N],
  ];
  function sum(f: (i: number) => number): number { let s = 0; for (let i = 0; i < N; i++) s += f(i); return s; }
  const bx = [sum((i) => src[i][0] * dst[i][0]), sum((i) => src[i][1] * dst[i][0]), sum((i) => dst[i][0])];
  const by = [sum((i) => src[i][0] * dst[i][1]), sum((i) => src[i][1] * dst[i][1]), sum((i) => dst[i][1])];
  const [a, b, c] = solve3(normal.map((r) => [...r]), bx);
  const [d, e, f] = solve3(normal.map((r) => [...r]), by);
  return [a, b, c, d, e, f];
}

// ─── Clipper dilation ─────────────────────────────────────────────────────────

function dilateRings(rings: Ring[], delta: number): Ring[] {
  if (delta <= 0) return rings;
  const co = new ClipperLib.ClipperOffset(2.0, 0.25);
  const paths = rings.map((r) => r.map(([x, y]) => ({ X: Math.round(x * CLIPPER_SCALE), Y: Math.round(y * CLIPPER_SCALE) })));
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol: Array<Array<{ X: number; Y: number }>> = [];
  co.Execute(sol, delta * CLIPPER_SCALE);
  return sol.map((p) => p.map((pt) => [pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE] as Pt));
}

function unionRings(rings: Ring[]): Ring[] {
  const S = CLIPPER_SCALE;
  const subj = rings.map((r) => r.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) })));
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  const sol: Array<Array<{ X: number; Y: number }>> = [];
  c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol.map((p) => p.map((pt) => [pt.X / S, pt.Y / S] as Pt));
}

function clipRingsToRect(rings: Ring[], rect: [number, number, number, number]): Ring[] {
  const S = CLIPPER_SCALE;
  const [x0, y0, x1, y1] = rect;
  const subj = rings.map((r) => r.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) })));
  const clip = [[
    { X: Math.round(x0 * S), Y: Math.round(y0 * S) },
    { X: Math.round(x1 * S), Y: Math.round(y0 * S) },
    { X: Math.round(x1 * S), Y: Math.round(y1 * S) },
    { X: Math.round(x0 * S), Y: Math.round(y1 * S) },
  ]];
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const sol: Array<Array<{ X: number; Y: number }>> = [];
  c.Execute(ClipperLib.ClipType.ctIntersection, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol.map((p) => p.map((pt) => [pt.X / S, pt.Y / S] as Pt));
}

function simplifyRing(ring: Ring): Ring {
  const s = simplify(ring.map(([x, y]) => ({ x, y })), SIMPLIFY_TOL, true);
  return s.map((p) => [p.x, p.y] as Pt);
}

function ringsToD(rings: Ring[]): string {
  const parts: string[] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let s = `M${fmt(ring[0][0])},${fmt(ring[0][1])}`;
    for (let i = 1; i < ring.length; i++) s += `L${fmt(ring[i][0])},${fmt(ring[i][1])}`;
    parts.push(s + "Z");
  }
  return parts.join("");
}

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? r.toFixed(0) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");

  // 1. Mercator projection (raw: scale 1, translate 0 — affine handles the rest).
  const proj = geoMercator().scale(1).translate([0, 0]).center([0, 0]);
  const merc = (lon: number, lat: number): Pt => proj([lon, lat]) as Pt;

  // 2. Control points: curated lon/lat ↔ native province centroid.
  const provById = new Map(TURKEY_PROVINCES.map((p) => [p.id, p]));
  const src: Pt[] = [], dst: Pt[] = [], usedIds: string[] = [];
  for (const [pid, lonlat] of Object.entries(CONTROL_LONLAT)) {
    const prov = provById.get(pid);
    if (!prov) { console.warn(`  · control point skipped (province id not found): ${pid}`); continue; }
    src.push(merc(lonlat[0], lonlat[1]));
    dst.push(pathCentroid(prov.d));
    usedIds.push(pid);
  }
  if (src.length < 6) throw new Error(`too few control points matched (${src.length})`);

  // 3. Fit + robust refit (one round of outlier rejection: capital≠centroid
  //    noise and any stray coord get down-weighted so the affine tracks the
  //    bulk of the well-behaved control points).
  const residualsFor = (M: number[]): number[] => {
    const ap = ([px, py]: Pt): Pt => [M[0]*px + M[1]*py + M[2], M[3]*px + M[4]*py + M[5]];
    return src.map((s, i) => Math.hypot(...sub(ap(s), dst[i])));
  };
  function sub(a: Pt, b: Pt): [number, number] { return [a[0] - b[0], a[1] - b[1]]; }

  let A = fitAffine(src, dst);
  let res = residualsFor(A);
  let rms0 = Math.sqrt(res.reduce((s, e) => s + e * e, 0) / res.length);
  const keep = res.map((e) => e <= 2 * rms0);
  const droppedIds = usedIds.filter((_, i) => !keep[i]);
  if (droppedIds.length && src.length - droppedIds.length >= 8) {
    const fsrc = src.filter((_, i) => keep[i]);
    const fdst = dst.filter((_, i) => keep[i]);
    A = fitAffine(fsrc, fdst);
    res = residualsFor(A);
  }
  const apply = ([px, py]: Pt): Pt => [A[0]*px + A[1]*py + A[2], A[3]*px + A[4]*py + A[5]];
  const geoToNative = (lon: number, lat: number): Pt => apply(merc(lon, lat));
  const rms = Math.sqrt(res.reduce((s, e) => s + e * e, 0) / res.length);
  const maxErr = Math.max(...res);

  // 4. Neighbour geometry → native, dilate toward Türkiye, simplify.
  const topo = JSON.parse(readFileSync(join(root, "public/data/countries-110m.json"), "utf8"));
  const fc: any = feature(topo, topo.objects.countries);
  const byId = new Map<string, any>();
  const cyprusRings: Ring[] = [];
  for (const f of fc.features) {
    const idNorm = String(f.id ?? "").replace(/^0+/, "") || "0";
    byId.set(idNorm, f);
    const nm = f.properties?.name;
    if (CYPRUS_NAMES.has(nm)) {
      for (const ring of geomToNativeRings(f.geometry, geoToNative)) cyprusRings.push(ring);
    }
  }

  // 4. Context window (native) from Türkiye bbox → canvas padded to exact aspect.
  const tkRings = TURKEY_CONQUEST_REGION_PATHS.flatMap((p) => flattenToRings(p.d));
  const tkBox = ringsBBox(tkRings);
  // Merged national outline (coastal shelf / rim / soft mask source).
  const unionD = ringsToD(unionRings(tkRings).map(simplifyRing).filter((r) => r.length >= 3));
  const Wt = tkBox[2] - tkBox[0], Ht = tkBox[3] - tkBox[1];
  let minX = tkBox[0] - WIN_L * Wt, minY = tkBox[1] - WIN_T * Ht;
  let maxX = tkBox[2] + WIN_R * Wt, maxY = tkBox[3] + WIN_B * Ht;
  let w = maxX - minX, h = maxY - minY;
  if (w / h > TARGET_ASPECT) { const nh = w / TARGET_ASPECT; const dd = (nh - h) / 2; minY -= dd; maxY += dd; }
  else { const nw = h * TARGET_ASPECT; const dd = (nw - w) / 2; minX -= dd; maxX += dd; }
  w = maxX - minX; h = maxY - minY;
  const canvasRect: [number, number, number, number] = [minX, minY, maxX, maxY];
  const vb = { x: round2(minX), y: round2(minY), w: round2(w), h: round2(h) };

  // 5. Neighbours → native, dilate toward Türkiye (islands excepted), clip to
  //    the canvas, simplify.
  const lands: Array<{ id: string; name: string; d: string }> = [];
  for (const nb of NEIGHBOR_IDS) {
    let rings: Ring[];
    if (nb.key === "cyprus") {
      rings = cyprusRings; // de-facto whole island (Cyprus + N. Cyprus)
    } else {
      const f = byId.get(String(Number(nb.id)));
      if (!f) { console.warn(`  · neighbour not found in topo: ${nb.name} (${nb.id})`); continue; }
      rings = geomToNativeRings(f.geometry, geoToNative);
    }
    const delta = ISLAND_KEYS.has(nb.key) ? DILATE_ISLAND : DILATE_LAND;
    const processed = clipRingsToRect(dilateRings(rings, delta), canvasRect)
      .map(simplifyRing).filter((r) => r.length >= 3);
    if (!processed.length) continue;
    lands.push({ id: nb.key, name: nb.name, d: ringsToD(processed) });
  }

  // 6. Emit.
  const out = emit(lands, vb, A, unionD, { rms, maxErr, n: src.length, ids: usedIds });
  const outPath = join(root, "src/modes/conquest/maps/conquest-neighbors.ts");
  writeFileSync(outPath, out, "utf8");

  // Report.
  const turkeyFrac = (tkBox[2] - tkBox[0]) / w;
  console.log("✓ wrote", outPath);
  console.log(`  registration affine fit: ${src.length} control points`);
  console.log(`    RMS residual: ${rms.toFixed(2)} native px   max: ${maxErr.toFixed(2)} native px`);
  console.log(`  expanded viewBox: ${vb.x} ${vb.y} ${vb.w} ${vb.h}  (aspect ${(w/h).toFixed(4)} vs target ${TARGET_ASPECT.toFixed(4)})`);
  console.log(`  Türkiye native bbox: [${tkBox.map((v)=>v.toFixed(0)).join(", ")}]  → ${(turkeyFrac*100).toFixed(1)}% of canvas width`);
  console.log(`  neighbours emitted: ${lands.map((l)=>l.id).join(", ")}`);
}

function geomToNativeRings(geom: any, geoToNative: (lon: number, lat: number) => Pt): Ring[] {
  const rings: Ring[] = [];
  const polys: number[][][][] = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      const nr: Ring = ring.map(([lon, lat]: number[]) => geoToNative(lon, lat));
      if (nr.length >= 3) rings.push(nr);
    }
  }
  return rings;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

function emit(
  lands: Array<{ id: string; name: string; d: string }>,
  vb: { x: number; y: number; w: number; h: number },
  A: number[],
  unionD: string,
  fit: { rms: number; maxErr: number; n: number; ids: string[] },
): string {
  const rows = lands
    .map((l) => `  { id: ${JSON.stringify(l.id)}, name: ${JSON.stringify(l.name)}, d: ${JSON.stringify(l.d)} },`)
    .join("\n");
  return `/**
 * AUTO-GENERATED — do not edit by hand.  Run: npx tsx scripts/build-conquest-neighbors.ts
 *
 * Phase-1 geo-context for Türkiye Kuşatması (geometry / registration proof).
 * Türkiye's region paths (viewBox ${NATIVE_VB_W}×${NATIVE_VB_H}) are the source of truth and stay
 * at IDENTITY; the registration affine below maps real lon/lat (Mercator) into
 * that native frame, and the neighbour land paths are Natural-Earth 110m
 * geometry already transformed into native coords (land dilated ${DILATE_LAND}u so the shared
 * land border overlaps Türkiye and is trimmed seam-free by the exterior mask at
 * render time).  FLAT / MUTED on purpose — Phase 1 proof, not final art.
 *
 * Source data: public/data/countries-110m.json (world-atlas@2 / Natural Earth).
 */

export interface ConquestNeighborLand {
  /** stable key (greece, syria, …) */
  id: string;
  /** Turkish display name (not rendered in Phase 1; kept for Phase 2). */
  name: string;
  /** SVG path in Türkiye's NATIVE viewBox coordinate frame. */
  d: string;
}

/** Expanded canvas: Türkiye + neighbours, padded to the runtime ${NATIVE_VB_W}/${NATIVE_VB_H} aspect. */
export const CONQUEST_GEO_VIEWBOX = { x: ${vb.x}, y: ${vb.y}, w: ${vb.w}, h: ${vb.h} } as const;
export const CONQUEST_GEO_VIEWBOX_STR = "${vb.x} ${vb.y} ${vb.w} ${vb.h}";

/** Türkiye's merged national outline (native coords) — coastal shelf / rim /
 *  soft-contact mask source.  NOT a region path; never interactive. */
export const CONQUEST_TURKEY_UNION_D = ${JSON.stringify(unionD)};

/**
 * Türkiye registration transform (build-time, for documentation/repro).
 * native = A · mercator(lon,lat),  A = [a b c; d e f] (row-major, 2×3 affine).
 * Fitted by least squares over ${fit.n} provincial control points;
 * RMS residual ${fit.rms.toFixed(2)} native px, max ${fit.maxErr.toFixed(2)} native px.
 */
export const CONQUEST_REGISTRATION = {
  projection: "geoMercator(scale=1, translate=[0,0])",
  affine: [${A.map((v) => v.toExponential(8)).join(", ")}] as const,
  rmsResidualPx: ${fit.rms.toFixed(3)},
  maxResidualPx: ${fit.maxErr.toFixed(3)},
  controlPoints: ${fit.n},
};

/** Real neighbour land masses, in Türkiye's native viewBox frame. */
export const CONQUEST_NEIGHBOR_LANDS: ConquestNeighborLand[] = [
${rows}
];
`;
}

main();
