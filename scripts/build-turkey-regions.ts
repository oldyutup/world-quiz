/* eslint-disable */
/**
 * One-shot generator: 24 merged Türkiye conquest-region SVG paths.
 *
 * Reads:  src/modes/conquest/maps/turkey-provinces.ts (81 province paths)
 * Writes: src/modes/conquest/maps/turkey-regions.ts   (24 merged paths)
 *
 * Pipeline per region:
 *   1. Parse each province path → flatten Bezier curves to polyline rings.
 *   2. Snap vertex coordinates to a 0.01-unit grid (closes micro-gaps
 *      between adjacent province borders introduced by Bezier sampling).
 *   3. Boolean-union all province polygons in the region (polygon-clipping).
 *   4. Simplify each resulting ring with Ramer–Douglas–Peucker, then emit
 *      a compact `d` string with `M` + `L`s + `Z`.
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
import polygonClipping from "polygon-clipping";
import simplify from "simplify-js";

import { TURKEY_PROVINCES } from "../src/modes/conquest/maps/turkey-provinces";

// ─── Tuning constants ────────────────────────────────────────────────────────

const BEZIER_STEPS       = 24;    // samples per cubic / quadratic curve
const SNAP_PRECISION     = 100;   // 1 / grid-step (0.01 unit grid)
const SIMPLIFY_TOLERANCE = 0.15;  // RDP tolerance in viewBox units
const COORD_DECIMALS     = 2;     // decimals in emitted `d` strings

// ─── Types ───────────────────────────────────────────────────────────────────

type Pt = [number, number];
type Ring = Pt[];

// polygon-clipping geometry shapes (loosely typed — we don't need the
// library's full generic surface here).
type PCRing        = [number, number][];
type PCPolygon     = PCRing[];
type PCMultiPoly   = PCPolygon[];

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

// ─── Coordinate snap (closes sub-pixel gaps at shared province borders) ─────

function snapRing(ring: Ring): Ring {
  return ring.map(([px, py]): Pt => [
    Math.round(px * SNAP_PRECISION) / SNAP_PRECISION,
    Math.round(py * SNAP_PRECISION) / SNAP_PRECISION,
  ]);
}

// ─── polygon-clipping input adapter ──────────────────────────────────────────
//
// polygon-clipping expects a multipolygon = [[outerRing, ...holes], ...].
// Province paths in the source data don't have holes — every ring is treated
// as its own outer polygon.  The union resolves overlaps correctly regardless.

function ringsToMultiPoly(rings: Ring[]): PCMultiPoly {
  return rings
    .filter((r) => r.length >= 4)
    .map((r) => [r.map(([px, py]): [number, number] => [px, py])]);
}

// ─── d-string serializer with RDP simplification ─────────────────────────────

function multiPolyToD(multi: PCMultiPoly): string {
  const parts: string[] = [];

  for (const polygon of multi) {
    for (const ring of polygon) {
      if (ring.length < 4) continue;

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
  const order:   string[]                  = [];
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

    const provinceMultis: PCMultiPoly[] = provinces.map((p) => {
      const rings        = flattenPath(p.d);
      const snappedRings = rings.map(snapRing);
      return ringsToMultiPoly(snappedRings);
    });

    // Union all provinces in this region.  polygonClipping.union accepts
    // (geom1, ...moreGeoms); pass each province multipoly as one argument.
    const unioned = polygonClipping.union(
      provinceMultis[0],
      ...provinceMultis.slice(1),
    ) as PCMultiPoly;

    const d = multiPolyToD(unioned);

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
 * 24 merged Türkiye conquest-region SVG paths, produced by unioning the
 * 81 province paths in turkey-provinces.ts grouped by conquestRegionId.
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
  console.log(`✓ Wrote ${merged.length} merged region paths → ${outPath}`);
  console.log(`  total d-string bytes: ${totalBytes.toLocaleString()}`);
}

main();
