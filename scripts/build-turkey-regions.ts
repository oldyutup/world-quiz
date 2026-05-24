/* eslint-disable */
/**
 * One-shot generator: 24 merged Türkiye conquest-region SVG paths.
 *
 * Reads:  src/modes/conquest/maps/turkey-provinces.ts (81 province paths)
 * Writes: src/modes/conquest/maps/turkey-regions.ts   (24 merged paths)
 *
 * Why this pipeline is non-trivial
 * --------------------------------
 * The source SVG traces every province's border independently — adjacent
 * provinces' "shared" edges are actually represented by separate Bezier
 * curves whose sample points end up ~1 unit apart in viewBox space.  A
 * plain polygon union therefore sees the 81 provinces as 81 disjoint
 * polygons and just compounds them, leaving every internal province seam
 * visible when stroked.
 *
 * Fix: use Clipper (integer-coordinate, Vatti-based polygon ops) to:
 *   1. Inflate every province polygon outward by INFLATE_EPSILON via
 *      Minkowski-disk offset (jtRound).  Same-region neighbours now
 *      overlap by 2 × INFLATE_EPSILON along their shared boundary.
 *   2. Boolean-union the inflated polygons.  Internal seams collapse
 *      because the inputs genuinely overlap.
 *   3. Deflate the result by INFLATE_EPSILON to restore approximately
 *      the original outline.
 *
 * Final per-ring steps: flatten Bezier curves (24 samples/curve), pipe
 * through Clipper, RDP-simplify the rings, emit a compact `d` string.
 *
 * Not part of the build pipeline. Run manually after province path edits:
 *   npx tsx scripts/build-turkey-regions.ts
 *
 * The generated file is committed to the repo and consumed at runtime
 * by the Türkiye Kuşatması map renderer.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import svgpath from "svgpath";
import ClipperLib from "clipper-lib";
import simplify from "simplify-js";

import { TURKEY_PROVINCES } from "../src/modes/conquest/maps/turkey-provinces";

// ─── Tuning constants ────────────────────────────────────────────────────────

const BEZIER_STEPS       = 24;    // samples per cubic / quadratic curve
const INFLATE_EPSILON    = 1.25;  // Minkowski-disk offset in viewBox units
                                  //   (max measured shared-edge gap ≈ 1.0u,
                                  //    so 1.25u guarantees full overlap and
                                  //    eliminates sliver holes inside merges)
const CLIPPER_SCALE      = 1000;  // viewBox units → Clipper integer units
const SIMPLIFY_TOLERANCE = 0.15;  // RDP tolerance, viewBox units
const COORD_DECIMALS     = 2;     // decimals in emitted `d` strings

// ─── Types ───────────────────────────────────────────────────────────────────

type Pt   = [number, number];
type Ring = Pt[];

// Clipper integer-coordinate path: array of { X, Y } in 64-bit-safe ints.
type ClipperPath  = Array<{ X: number; Y: number }>;
type ClipperPaths = ClipperPath[];

// ─── Bezier-flattening parser ────────────────────────────────────────────────
//
// Iterates absolute, arc/short-free segments and emits closed rings.
// Each `M` opens a new ring; `Z` closes the current ring.

function flattenPath(d: string): Ring[] {
  const rings: Ring[] = [];
  let current: Ring   = [];
  let x = 0, y = 0;
  let startX = 0, startY = 0;

  const closeRing = () => {
    if (current.length >= 3) {
      const first = current[0];
      const last  = current[current.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        current.push([first[0], first[1]]);
      }
      rings.push(current);
    }
    current = [];
  };

  svgpath(d).abs().unarc().unshort().iterate((seg) => {
    const cmd = seg[0] as string;

    if (cmd === "M") {
      closeRing();
      x = seg[1] as number;
      y = seg[2] as number;
      startX = x;
      startY = y;
      current.push([x, y]);
    } else if (cmd === "L") {
      x = seg[1] as number;
      y = seg[2] as number;
      current.push([x, y]);
    } else if (cmd === "H") {
      x = seg[1] as number;
      current.push([x, y]);
    } else if (cmd === "V") {
      y = seg[1] as number;
      current.push([x, y]);
    } else if (cmd === "C") {
      const x1 = seg[1] as number, y1 = seg[2] as number;
      const x2 = seg[3] as number, y2 = seg[4] as number;
      const x3 = seg[5] as number, y3 = seg[6] as number;
      const sx = x, sy = y;
      for (let i = 1; i <= BEZIER_STEPS; i++) {
        const t = i / BEZIER_STEPS;
        const u = 1 - t;
        const px = u*u*u*sx + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3;
        const py = u*u*u*sy + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3;
        current.push([px, py]);
      }
      x = x3; y = y3;
    } else if (cmd === "Q") {
      const x1 = seg[1] as number, y1 = seg[2] as number;
      const x2 = seg[3] as number, y2 = seg[4] as number;
      const sx = x, sy = y;
      for (let i = 1; i <= BEZIER_STEPS; i++) {
        const t = i / BEZIER_STEPS;
        const u = 1 - t;
        const px = u*u*sx + 2*u*t*x1 + t*t*x2;
        const py = u*u*sy + 2*u*t*y1 + t*t*y2;
        current.push([px, py]);
      }
      x = x2; y = y2;
    } else if (cmd === "Z" || cmd === "z") {
      x = startX;
      y = startY;
      closeRing();
    }
  });
  closeRing();
  return rings;
}

// ─── Clipper conversion helpers ──────────────────────────────────────────────
//
// Clipper requires integer coordinates.  Drop the trailing closing duplicate
// before handing rings to Clipper (Clipper treats every path as closed by
// definition and will introduce a spurious zero-length edge otherwise).

function ringToClipperPath(ring: Ring): ClipperPath {
  let end = ring.length;
  if (end >= 2) {
    const a = ring[0];
    const b = ring[end - 1];
    if (a[0] === b[0] && a[1] === b[1]) end -= 1;
  }
  const out: ClipperPath = new Array(end);
  for (let i = 0; i < end; i++) {
    out[i] = {
      X: Math.round(ring[i][0] * CLIPPER_SCALE),
      Y: Math.round(ring[i][1] * CLIPPER_SCALE),
    };
  }
  // Normalize winding to a single convention before any Clipper boolean op.
  // The source SVG winds most province paths one way but a handful (e.g.
  // Çanakkale, Balıkesir, Isparta) the opposite way.  ClipperOffset uses
  // orientation to decide which side of an edge is "outward": pass mixed
  // orientations into one Execute call and the odd-orientation rings get
  // offset inward and fragment into slivers that vanish after deflate.
  if (ClipperLib.Clipper.Orientation(out)) {
    out.reverse();
  }
  return out;
}

function clipperPathToRing(path: ClipperPath): Ring {
  const ring: Ring = path.map((p) => [p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE]);
  if (ring.length >= 3) ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function offsetPaths(paths: ClipperPaths, delta: number): ClipperPaths {
  const co = new ClipperLib.ClipperOffset(2.0, 0.25);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution: ClipperPaths = [];
  co.Execute(solution, delta * CLIPPER_SCALE);
  return solution;
}

function unionPaths(paths: ClipperPaths): ClipperPaths {
  if (paths.length === 0) return [];
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const solution: ClipperPaths = [];
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  return solution;
}

// Signed area (shoelace).  In our y-down SVG space, Clipper emits outer
// rings with positive signed area and holes with negative signed area.
function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

// ─── d-string serializer with RDP simplification ─────────────────────────────
//
// Drops holes (negative signed area) — they're sliver artifacts of the
// offset/union/deflate cycle, not real geography (lakes are part of the
// province's land area in the source SVG).  Keeping them would cause the
// renderer to draw spurious internal strokes around each hole.

function ringsToD(rings: Ring[]): string {
  const parts: string[] = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    if (signedArea(ring) <= 0) continue;

    const simplified = simplify(
      ring.map(([px, py]) => ({ x: px, y: py })),
      SIMPLIFY_TOLERANCE,
      true,
    );
    if (simplified.length < 3) continue;

    let s = `M${fmt(simplified[0].x)},${fmt(simplified[0].y)}`;
    for (let i = 1; i < simplified.length; i++) {
      s += `L${fmt(simplified[i].x)},${fmt(simplified[i].y)}`;
    }
    s += "Z";
    parts.push(s);
  }
  return parts.join("");
}

function fmt(n: number): string {
  const factor  = Math.pow(10, COORD_DECIMALS);
  const rounded = Math.round(n * factor) / factor;
  return Number.isInteger(rounded)
    ? rounded.toFixed(0)
    : rounded.toFixed(COORD_DECIMALS).replace(/0+$/, "").replace(/\.$/, "");
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface MergedRegion {
  id: string;
  d:  string;
}

function buildRegions(): MergedRegion[] {
  // Group provinces by conquestRegionId, preserving first-seen order.
  const order:    string[]                            = [];
  const byRegion: Map<string, typeof TURKEY_PROVINCES> = new Map();

  for (const p of TURKEY_PROVINCES) {
    if (!byRegion.has(p.conquestRegionId)) {
      byRegion.set(p.conquestRegionId, []);
      order.push(p.conquestRegionId);
    }
    byRegion.get(p.conquestRegionId)!.push(p);
  }

  const merged: MergedRegion[] = [];

  for (const regionId of order) {
    const provinces = byRegion.get(regionId)!;

    // 1. Flatten every province path → array of integer rings (no closing dup).
    const allClipperPaths: ClipperPaths = [];
    for (const p of provinces) {
      const rings = flattenPath(p.d);
      for (const r of rings) {
        if (r.length < 4) continue;
        allClipperPaths.push(ringToClipperPath(r));
      }
    }

    // 2. Inflate by +epsilon, union, deflate by -epsilon.
    const inflated = offsetPaths(allClipperPaths, +INFLATE_EPSILON);
    const merged1  = unionPaths(inflated);
    const deflated = offsetPaths(merged1,        -INFLATE_EPSILON);

    // 3. Back to floats, then simplify + serialize.
    const rings = deflated.map(clipperPathToRing);
    const d = ringsToD(rings);

    merged.push({ id: regionId, d });
  }

  return merged;
}

function validate(merged: MergedRegion[]): void {
  if (merged.length !== 24) {
    throw new Error(`Expected 24 merged regions, got ${merged.length}`);
  }
  const expected = new Set(TURKEY_PROVINCES.map((p) => p.conquestRegionId));
  if (expected.size !== 24) {
    throw new Error(`Province source defines ${expected.size} distinct region ids, expected 24`);
  }
  const got = new Set(merged.map((m) => m.id));
  for (const id of expected) {
    if (!got.has(id)) throw new Error(`Missing region in output: ${id}`);
  }
  for (const m of merged) {
    if (!m.d || m.d.trim().length === 0) {
      throw new Error(`Region ${m.id} produced empty d`);
    }
  }
}

function emit(merged: MergedRegion[]): string {
  const rows = merged
    .map((m) => `  { id: ${JSON.stringify(m.id)}, d: ${JSON.stringify(m.d)} },`)
    .join("\n");

  return `/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * 24 merged Türkiye conquest-region SVG paths, produced by inflating each
 * province polygon, boolean-unioning the inflated shapes, and deflating
 * the result (see scripts/build-turkey-regions.ts for details).
 *
 * Generator:  scripts/build-turkey-regions.ts
 * viewBox:    0 0 1005 490 (matches province source)
 *
 * Re-run after any province path edit:
 *   npx tsx scripts/build-turkey-regions.ts
 */

import type { ConquestRegionId } from "../types";

export interface TurkeyConquestRegionPath {
  id: ConquestRegionId;
  d:  string;
}

export const TURKEY_CONQUEST_REGION_PATHS: TurkeyConquestRegionPath[] = [
${rows}
];
`;
}

function main(): void {
  const merged = buildRegions();
  validate(merged);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, "..", "src", "modes", "conquest", "maps", "turkey-regions.ts");

  writeFileSync(outPath, emit(merged), "utf8");

  const totalBytes = merged.reduce((acc, m) => acc + m.d.length, 0);
  const subpaths   = merged.map((m) => (m.d.match(/M/g) || []).length);
  console.log(`✓ Wrote ${merged.length} merged region paths → ${outPath}`);
  console.log(`  total d-string bytes: ${totalBytes.toLocaleString()}`);
  console.log(`  subpaths min/max: ${Math.min(...subpaths)} / ${Math.max(...subpaths)}`);
}

main();
