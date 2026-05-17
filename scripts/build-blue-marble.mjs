/* eslint-disable */
/**
 * One-shot prep script: download NASA Blue Marble Next Generation (July 2004,
 * plate-carrée projection) and reproject it to d3-geo's geoNaturalEarth1 so it
 * aligns with the in-app map. Writes a 2048×1024 JPEG to public/assets/map/.
 *
 * Run once with:   node scripts/build-blue-marble.mjs
 *
 * The output JPEG is committed to the repo. This script is NOT part of the
 * build pipeline — the app at runtime simply loads the static asset via
 * <image href="/assets/map/blue-marble-ne.jpg" />.
 *
 * Imagery source: NASA Earth Observatory, Blue Marble Next Generation, July
 * 2004 monthly composite, royalty-free.
 *   https://earthobservatory.nasa.gov/features/BlueMarble
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { geoNaturalEarth1 } from "d3-geo";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SOURCE_URL = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x5400x2700.jpg";
const CACHE_PATH = join(ROOT, "scripts/.cache-blue-marble-source.jpg");
const OUT_PATH   = join(ROOT, "public/assets/map/blue-marble-ne.jpg");

const OUT_W = 2048;
const OUT_H = 1024;
// Fallback colour for pixels that fall outside the NaturalEarth envelope
// (the projection has curved edges so the rectangular output has corners
// that don't map back to a real lat/lon). Matches the Classic theme ocean
// so corner blend is invisible.
const OCEAN = [13, 33, 55];

async function getSource() {
  if (existsSync(CACHE_PATH)) {
    console.log(`Using cached source: ${CACHE_PATH}`);
    return readFileSync(CACHE_PATH);
  }
  console.log(`Downloading source from NASA...\n  ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, buf);
  console.log(`Cached ${(buf.length / 1024 / 1024).toFixed(1)} MB to ${CACHE_PATH}`);
  return buf;
}

/** Bilinear sample of (sx, sy) from an RGBA buffer. */
function sample(data, w, h, sx, sy) {
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = sx - x0, fy = sy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = (data[i00 + c] * (1 - fx) + data[i10 + c] * fx) * (1 - fy)
           + (data[i01 + c] * (1 - fx) + data[i11 + c] * fx) * fy;
  }
  return out;
}

async function main() {
  const sourceBuf = await getSource();
  console.log("Decoding source JPEG...");
  const src = jpeg.decode(sourceBuf, { useTArray: true, formatAsRGBA: true });
  const { width: SW, height: SH, data: SD } = src;
  console.log(`Source: ${SW}×${SH}`);

  // Match the in-app projection exactly:
  //   geoNaturalEarth1().scale(W / 6.2).translate([W / 2, H / 2])
  const proj = geoNaturalEarth1().scale(OUT_W / 6.2).translate([OUT_W / 2, OUT_H / 2]);

  console.log(`Reprojecting to ${OUT_W}×${OUT_H} NaturalEarth1...`);
  const out = Buffer.alloc(OUT_W * OUT_H * 4);
  const t0 = Date.now();
  for (let y = 0; y < OUT_H; y++) {
    for (let x = 0; x < OUT_W; x++) {
      const oOff = (y * OUT_W + x) * 4;
      const ll = proj.invert([x, y]);
      let r, g, b;
      if (
        !ll ||
        !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) ||
        ll[0] < -180 || ll[0] > 180 ||
        ll[1] < -90  || ll[1] > 90
      ) {
        [r, g, b] = OCEAN;
      } else {
        const sx = ((ll[0] + 180) / 360) * SW;
        const sy = ((90 - ll[1]) / 180) * SH;
        [r, g, b] = sample(SD, SW, SH, sx, sy);
      }
      out[oOff]     = r;
      out[oOff + 1] = g;
      out[oOff + 2] = b;
      out[oOff + 3] = 255;
    }
    if (y % 64 === 0) process.stdout.write(`\r  row ${y}/${OUT_H}`);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\r  reprojection done in ${dt}s\n`);

  console.log("Encoding output JPEG...");
  const encoded = jpeg.encode({ data: out, width: OUT_W, height: OUT_H }, 82);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, encoded.data);
  console.log(`Wrote ${(encoded.data.length / 1024).toFixed(0)} KB → ${OUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
