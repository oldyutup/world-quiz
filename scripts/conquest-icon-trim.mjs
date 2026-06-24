/**
 * conquest-icon-trim — Kuşatma PNG ikonlarını GÖRÜNÜR piksel sınırına göre
 * kırpan tek-seferlik ön-işleme aracı (alfa korunur).
 *
 * NEDEN: Şeffaflaştırma sonrası ikonların etrafında orijinal kompozisyondan
 * kalan geniş şeffaf canvas boşluğu vardı; bu yüzden aynı CSS boyutunda gerçek
 * görsel küçük kalıyordu (özellikle "Arkadaş Davet Et" ikonu). Bu script alfa
 * bounding-box'a göre kırpıp her kenara DAR, dengeli bir güvenlik payı bırakır
 * → görünür içerik kutuyu doldurur, ikon büyür; kenara yapışmaz.
 *
 * KURALLAR:
 *   - Yalnız tamamen şeffaf (alfa ≤ THRESH) dış canvas kırpılır; ikon içindeki
 *     beyaz/krem/metal/cam detaylar (opak) bbox içinde olduğundan korunur.
 *   - Yeni opak arka plan / beyaz halo OLUŞTURULMAZ (yalnız extract + şeffaf
 *     extend). Renkler değişmez.
 *   - Idempotent: zaten dar kırpılmış görselde tekrar çalışınca aynı kalır.
 *   - Runtime'da işlem yok; kaynak PNG'ler yerinde yeniden yazılır. Resolver
 *     path'leri ve bonus ID eşleşmeleri değişmez (yalnız piksel boyutu değişir;
 *     CSS object-fit: contain her intrinsic boyutla çalışır).
 *
 * Kullanım:
 *   node scripts/conquest-icon-trim.mjs            # yerinde kırp
 *   node scripts/conquest-icon-trim.mjs --preview  # ÜZERINE YAZMAZ; QA montajı
 */

import sharp from "sharp";
import { readdirSync, existsSync } from "fs";
import path from "path";

const DIRS = [
  "public/assets/conquest/bonuses",
  "public/assets/conquest/maps",
  "public/assets/conquest/lobby",
  "public/assets/conquest/options",
  "public/assets/ui/lobby/settings",
];

const ALPHA_THRESH = 8;     // bunun üstü "görünür" piksel
const MARGIN_FRAC  = 0.05;  // güvenlik payı = görünür içeriğin büyük kenarının %5'i

const PREVIEW = process.argv.includes("--preview");

/** Görünür içeriğin bounding-box'ını bul. */
function alphaBBox(data, W, H, C) {
  let minx = W, miny = H, maxx = -1, maxy = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * C + 3] > ALPHA_THRESH) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return null; // tamamen şeffaf
  return { minx, miny, maxx, maxy };
}

/** Bir kaynak PNG'yi kırpılmış RGBA buffer + bilgisine çevirir. */
async function trimFile(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const bb = alphaBBox(data, W, H, C);
  if (!bb) return null;

  const cw = bb.maxx - bb.minx + 1;
  const ch = bb.maxy - bb.miny + 1;
  const margin = Math.round(Math.max(cw, ch) * MARGIN_FRAC);

  // İçeriği kırp, sonra her kenara şeffaf güvenlik payı ekle.
  const cropped = await sharp(file)
    .ensureAlpha()
    .extract({ left: bb.minx, top: bb.miny, width: cw, height: ch })
    .extend({
      top: margin, bottom: margin, left: margin, right: margin,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return { buffer: cropped, srcW: W, srcH: H, cw, ch, outW: cw + 2 * margin, outH: ch + 2 * margin };
}

const targets = [];
for (const d of DIRS) {
  if (!existsSync(d)) continue;
  for (const name of readdirSync(d).filter((f) => f.toLowerCase().endsWith(".png"))) {
    targets.push(path.join(d, name));
  }
}

const previewTiles = [];
let written = 0;

for (const file of targets) {
  const res = await trimFile(file);
  if (!res) { console.log(`SKIP (boş): ${path.basename(file)}`); continue; }
  const fillBefore = `${((res.cw / res.srcW) * 100).toFixed(0)}%x${((res.ch / res.srcH) * 100).toFixed(0)}%`;
  console.log(
    `${PREVIEW ? "PREVIEW" : "WROTE"}: ${path.basename(file).padEnd(30)} ${res.srcW}x${res.srcH} → ${res.outW}x${res.outH}  (içerik kanvas dolumu önce ${fillBefore})`
  );
  if (PREVIEW) {
    // Sabit kutuya yerleştir + ince çerçeve → güvenlik payı/kenar görünür.
    const TS = 200;
    const tile = await sharp(res.buffer)
      .resize(TS, TS, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    previewTiles.push(tile);
  } else {
    await sharp(res.buffer).toFile(file);
    written++;
  }
}

if (PREVIEW) {
  const TS = 200, GAP = 10, COLS = 6;
  const rows = Math.ceil(previewTiles.length / COLS);
  const Wc = COLS * TS + (COLS + 1) * GAP;
  const Hc = rows * TS + (rows + 1) * GAP;
  const comps = previewTiles.map((input, i) => {
    const c = i % COLS, r = (i / COLS) | 0;
    return { input, left: GAP + c * (TS + GAP), top: GAP + r * (TS + GAP) };
  });
  await sharp({ create: { width: Wc, height: Hc, channels: 4, background: { r: 11, g: 18, b: 32, alpha: 1 } } })
    .composite(comps)
    .png()
    .toFile("scripts/_conquest-trim-preview.png");
  console.log(`\nPreview: scripts/_conquest-trim-preview.png`);
}

console.log(`\nDone. written=${written} total=${targets.length}`);
