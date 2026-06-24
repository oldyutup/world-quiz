/**
 * conquest-icon-alpha — Kuşatma özel PNG ikonlarının opak beyaz arka planını
 * GERÇEK alfa kanalına (şeffaf) çeviren tek-seferlik ön-işleme aracı.
 *
 * KÖK NEDEN: Bu ikonlar RGB (alfasız) PNG olarak üretilmiş; dış arka plan
 * opak beyaz olarak "pişmiş". Koyu/lacivert arayüzde ikon çevresinde beyaz
 * kare görünüyordu. CSS hilesi (blend/opacity/filter) DEĞİL — assetlerin
 * kendisi alfa kanallı RGBA yapılır.
 *
 * YÖNTEM (yalnız kenardan bağlı arka plan silinir, iç detaylar korunur):
 *   1. Kenar piksellerinden flood-fill (4-yön). Bir piksel arka plan sayılır:
 *      min(R,G,B) >= CONNECT_LUM  VE  (max-min) <= CONNECT_CHROMA  (nötr+çok açık).
 *      Bu sayede SİLİNEN şey yalnız resmin kenarına bağlı beyaz alandır;
 *      konu siluetinin İÇİNDEKİ meşru beyaz/krem (parşömen, kum saati camı,
 *      metal parlaması, açık taş) flood'a hiç ulaşmadığından dokunulmaz.
 *      Sıcak krem (chroma yüksek) ve koyu detaylar (lum düşük) zaten eşik dışı.
 *   2. Arka plan piksellerinin alfası 0.
 *   3. Halo önleme: arka plana FEATHER_BAND px mesafedeki, hâlâ AÇIK rim
 *      pikselleri yumuşatılır (alfa düşürülür) ve renk "decontamine" edilir
 *      (beyazla karışmış kenar gerçek renge geri çözülür) → koyu zeminde
 *      beyaz halo/mat kenar kalmaz.
 *
 * Runtime'da hiçbir görsel işlem yapılmaz; bu script bir kez çalışır,
 * kaynak PNG'leri yerinde RGBA olarak yeniden yazar.
 *
 * Kullanım:
 *   node scripts/conquest-icon-alpha.mjs            # kaynakları yerinde işler
 *   node scripts/conquest-icon-alpha.mjs --preview  # ÜZERINE YAZMAZ; koyu zeminli
 *                                                   #  QA montajı üretir (dist yok)
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

// Eşikler — ölçülen border istatistiklerine göre (borderMinLum>=237, chroma<=3).
const CONNECT_LUM    = 230; // min(R,G,B) bu değerin üstündeyse "çok açık"
const CONNECT_CHROMA = 18;  // (max-min) bu değerin altındaysa "nötr" (renkli değil)
const FEATHER_BAND   = 2;   // arka plana bu kadar px mesafede rim yumuşat
const FEATHER_LO     = 205; // bu lum'un altındaki rim'e dokunma (gerçek kenar)
const FEATHER_HI     = 235; // bu lum'a yaklaştıkça alfa 0'a iner (halo)

const PREVIEW = process.argv.includes("--preview");

/** Tek görüntüyü işler; yeni RGBA raw buffer + istatistik döner. */
function processRGBA(data, W, H, C) {
  const N = W * H;
  const minc   = new Uint8Array(N);
  const chroma = new Uint8Array(N);
  const lum    = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    minc[i]   = mn;
    chroma[i] = mx - mn;
    lum[i]    = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // 1) Kenardan flood-fill → arka plan kümesi.
  const bg = new Uint8Array(N);
  const stack = [];
  const isCand = (i) => minc[i] >= CONNECT_LUM && chroma[i] <= CONNECT_CHROMA;
  const pushIf = (i) => { if (!bg[i] && isCand(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { pushIf(x); pushIf((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { pushIf(y * W); pushIf(y * W + (W - 1)); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i / W) | 0;
    if (x > 0)     pushIf(i - 1);
    if (x < W - 1) pushIf(i + 1);
    if (y > 0)     pushIf(i - W);
    if (y < H - 1) pushIf(i + W);
  }

  // 2) Arka plana mesafe (çok-kaynaklı BFS, FEATHER_BAND'e kadar) — yalnız rim.
  const dist = new Int8Array(N).fill(-1);
  let frontier = [];
  for (let i = 0; i < N; i++) {
    if (bg[i]) continue;
    const x = i % W, y = (i / W) | 0;
    let adj = false;
    if (x > 0 && bg[i - 1]) adj = true;
    else if (x < W - 1 && bg[i + 1]) adj = true;
    else if (y > 0 && bg[i - W]) adj = true;
    else if (y < H - 1 && bg[i + W]) adj = true;
    if (adj) { dist[i] = 1; frontier.push(i); }
  }
  for (let d = 1; d < FEATHER_BAND; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % W, y = (i / W) | 0;
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < W - 1) nb.push(i + 1);
      if (y > 0) nb.push(i - W);
      if (y < H - 1) nb.push(i + W);
      for (const j of nb) if (!bg[j] && dist[j] === -1) { dist[j] = d + 1; next.push(j); }
    }
    frontier = next;
  }

  // 3) Alfa yaz + halo feather + decontam.
  const out = Buffer.from(data); // kopya (RGBA, C kanal)
  let bgCount = 0, featherCount = 0;
  for (let i = 0; i < N; i++) {
    const o = i * C;
    if (bg[i]) { out[o + 3] = 0; bgCount++; continue; }
    const d = dist[i];
    if (d >= 1 && d <= FEATHER_BAND && lum[i] >= FEATHER_LO) {
      let aF = (FEATHER_HI - lum[i]) / (FEATHER_HI - FEATHER_LO);
      if (aF < 0) aF = 0; else if (aF > 1) aF = 1;
      const origA = data[o + 3] / 255;
      const a = Math.min(origA, aF);
      out[o + 3] = Math.round(a * 255);
      // Beyazla karışmış kenarı gerçek renge çöz (koyu zeminde halo kalmasın).
      if (a > 0.12 && a < 0.97) {
        for (let ch = 0; ch < 3; ch++) {
          let F = (data[o + ch] - (1 - a) * 255) / a;
          if (F < 0) F = 0; else if (F > 255) F = 255;
          out[o + ch] = Math.round(F);
        }
      }
      featherCount++;
    }
    // diğer pikseller: orijinal renk + alfa korunur.
  }
  return { out, bgCount, featherCount };
}

/** Border'da alfa-0 var mı? (zaten şeffaf → atla) */
function borderHasAlpha0(data, W, H, C) {
  const a = (x, y) => data[(y * W + x) * C + 3];
  for (let x = 0; x < W; x++) if (a(x, 0) === 0 || a(x, H - 1) === 0) return true;
  for (let y = 0; y < H; y++) if (a(0, y) === 0 || a(W - 1, y) === 0) return true;
  return false;
}

const targets = [];
for (const d of DIRS) {
  if (!existsSync(d)) continue;
  for (const name of readdirSync(d).filter((f) => f.toLowerCase().endsWith(".png"))) {
    targets.push(path.join(d, name));
  }
}

const previewTiles = [];
let processed = 0, skipped = 0;

for (const file of targets) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;

  if (borderHasAlpha0(data, W, H, C)) {
    console.log(`SKIP (zaten şeffaf): ${path.basename(file)}`);
    skipped++;
    if (PREVIEW) previewTiles.push(await tile(data, W, H, C, path.basename(file)));
    continue;
  }

  const { out, bgCount, featherCount } = processRGBA(data, W, H, C);
  const pct = ((bgCount / (W * H)) * 100).toFixed(1);
  console.log(
    `${PREVIEW ? "PREVIEW" : "WROTE"}: ${path.basename(file).padEnd(30)} bg=${pct}% feather=${featherCount}`
  );

  if (PREVIEW) {
    previewTiles.push(await tile(out, W, H, C, path.basename(file)));
  } else {
    await sharp(out, { raw: { width: W, height: H, channels: C } }).png().toFile(file);
    processed++;
  }
}

/** Bir RGBA buffer'ı 200px karoya küçült (montaj için). */
async function tile(buf, W, H, C, _label) {
  const TS = 200;
  return await sharp(buf, { raw: { width: W, height: H, channels: C } })
    .resize(TS, TS, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

if (PREVIEW) {
  const TS = 200, GAP = 12, COLS = 6;
  const rows = Math.ceil(previewTiles.length / COLS);
  const Wc = COLS * TS + (COLS + 1) * GAP;
  const Hc = rows * TS + (rows + 1) * GAP;
  const composites = previewTiles.map((input, idx) => {
    const c = idx % COLS, r = (idx / COLS) | 0;
    return { input, left: GAP + c * (TS + GAP), top: GAP + r * (TS + GAP) };
  });
  // Koyu lacivert zemin (arayüz yüzeyine yakın) — beyaz kutu/halo hemen görünür.
  await sharp({ create: { width: Wc, height: Hc, channels: 4, background: { r: 11, g: 18, b: 32, alpha: 1 } } })
    .composite(composites)
    .png()
    .toFile("scripts/_conquest-icon-preview.png");
  console.log(`\nPreview montage: scripts/_conquest-icon-preview.png`);
}

console.log(`\nDone. processed=${processed} skipped=${skipped} total=${targets.length}`);
