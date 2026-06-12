// Harita Dedektifi 360 test pipeline — adım 2: işleme.
//
// Ham aday (5632×2816 RealESRGAN çıktısı) → 4096×2048 WebP:
//   1. Lanczos3 ile 4096×2048'e süpersampling indirgeme (AI upscale'in
//      sentezlediği detay korunur, ESRGAN'ın plastik dokusu yumuşar)
//   2. Sol/sağ kenar seam düzeltmesi: equirectangular sarmada (yaw 180°)
//      görünen sert renk sıçraması, kenarlara doğru artan gradyan
//      düzeltmesiyle orta noktada buluşturulur
//   3. Hafif unsharp — viewer'daki mipmap yumuşamasını dengeler
//   4. WebP q=82 (4096×2048 için ~1.5-2.5MB hedefi)
//
// Kullanım:
//   node scripts/history360/postprocess.mjs raw/h360_001_..._cand1.webp
//   → public/assets/history/360-test/h360_001..._4096x2048.webp (candN eki düşer)
//   İkinci argümanla çıkış yolu elle verilebilir.

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const WIDTH = 4096;
const HEIGHT = 2048;
const SEAM_BLEND_PX = 128;
const WEBP_QUALITY = 82;

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultOutDir = path.join(here, "..", "..", "public", "assets", "history", "360-test");

function blendSeam(buf, width, height, channels) {
  // Her satırda sol (x=0) ve sağ (x=W-1) kenar farkını ölç; iki kenarı da
  // kenara doğru güçlenen rampayla orta değere çek. Sarma noktasındaki sert
  // dikey çizgiyi yok eder; içerik uyuşmazlığı kalır ama keskin hat gider.
  //
  // Delta satır satır ham uygulanırsa, kenar içeriği dikeyde değiştiği yerde
  // (ör. sütun biter, tente başlar) rampa bölgesinde yatay çizgilenme /
  // hayalet oluşur. Bu yüzden delta önce dikeyde kayan ortalamayla
  // yumuşatılır — yalnızca düşük frekanslı renk/pozlama farkı düzeltilir.
  const B = SEAM_BLEND_PX;
  const SMOOTH_RADIUS = 64;

  // 1) Ham satır deltaları
  const deltas = new Float32Array(height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let c = 0; c < 3; c++) {
      deltas[y * 3 + c] = buf[row + c] - buf[row + (width - 1) * channels + c];
    }
  }

  // 2) Dikey kayan ortalama (prefix-sum ile O(n))
  const smoothed = new Float32Array(height * 3);
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    const prefix = new Float32Array(height + 1);
    for (let y = 0; y < height; y++) {
      sum += deltas[y * 3 + c];
      prefix[y + 1] = sum;
    }
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - SMOOTH_RADIUS);
      const hi = Math.min(height - 1, y + SMOOTH_RADIUS);
      smoothed[y * 3 + c] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
  }

  // 3) Rampalı uygulama
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let c = 0; c < 3; c++) {
      const delta = smoothed[y * 3 + c];
      if (Math.abs(delta) < 0.5) continue;
      for (let i = 0; i < B; i++) {
        // x=i: sol bölge, kenarda (i=0) -delta/2 → orta nokta
        const lIdx = row + i * channels + c;
        buf[lIdx] = clamp255(buf[lIdx] - (delta * (B - i)) / (2 * B));
        // x=W-B+i: sağ bölge, kenarda (i=B-1) +delta/2 → orta nokta
        const rIdx = row + (width - B + i) * channels + c;
        buf[rIdx] = clamp255(buf[rIdx] + (delta * (i + 1)) / (2 * B));
      }
    }
  }
  return buf;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

async function main() {
  const inFile = process.argv[2];
  if (!inFile) {
    console.error("usage: node postprocess.mjs <rawFile> [outFile]");
    process.exit(1);
  }
  const inPath = path.resolve(here, inFile);
  const base = path
    .basename(inPath)
    .replace(/\.(webp|png|jpe?g)$/i, "")
    .replace(/_cand\d+$/, "");
  const outPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(defaultOutDir, `${base}_${WIDTH}x${HEIGHT}.webp`);

  await mkdir(path.dirname(outPath), { recursive: true });

  const { data, info } = await sharp(inPath)
    .resize(WIDTH, HEIGHT, { kernel: "lanczos3", fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  blendSeam(data, info.width, info.height, info.channels);

  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .sharpen({ sigma: 0.9, m1: 0.4, m2: 0.2 })
    .webp({ quality: WEBP_QUALITY, effort: 5 })
    .toFile(outPath);

  const outInfo = await sharp(outPath).metadata();
  const sizeMb = ((await import("node:fs/promises")).stat
    ? (await (await import("node:fs/promises")).stat(outPath)).size / 1024 / 1024
    : 0
  ).toFixed(2);
  console.log(`ok: ${outPath} (${outInfo.width}×${outInfo.height}, ${sizeMb}MB)`);
}

main();
