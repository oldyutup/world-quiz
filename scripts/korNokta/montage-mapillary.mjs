// Faz B QC aracı (geçici): preview-mapillary/<id>.jpg önizlemelerini bölgesel
// kontak-sayfalarına dizer. Etiket + tag'leri preview-queue.json'dan okur.
// raw/webp/manifest/candidates ÜRETMEZ; çıktı da gitignored preview-mapillary/
// altına yazılır (sheet-*.png). Panoramax montage.mjs'e DOKUNMAZ.
//
//   node scripts/korNokta/montage-mapillary.mjs
//
// Önce: node scripts/korNokta/fetch-mapillary.mjs --preview  (önizlemeleri indirir)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "preview-mapillary");
const QUEUE_PATH = path.join(HERE, "preview-queue.json");

if (!fs.existsSync(QUEUE_PATH)) {
  console.error("✗ preview-queue.json yok — önce Faz B kuyruğu üretilmeli.");
  process.exit(1);
}
const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
fs.mkdirSync(DIR, { recursive: true });

const COLS = 4;
const CW = 512, CH = 256, LBL = 46, PAD = 6;
const cellW = CW + PAD * 2, cellH = CH + LBL + PAD * 2;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function cell(e) {
  const file = path.join(DIR, `${e.imageId}.jpg`);
  let img;
  if (fs.existsSync(file)) {
    img = await sharp(file).resize(CW, CH, { fit: "cover" }).toBuffer();
  } else {
    img = await sharp({ create: { width: CW, height: CH, channels: 3, background: { r: 34, g: 34, b: 34 } } })
      .composite([{ input: Buffer.from(`<svg width="${CW}" height="${CH}"><text x="${CW / 2}" y="${CH / 2}" fill="#777" font-family="monospace" font-size="20" text-anchor="middle">ONIZLEME YOK</text></svg>`), top: 0, left: 0 }])
      .png().toBuffer();
  }
  const tags = (e.tags || []).join(" ");
  const l1 = `${e.country} / ${e.city || "?"}`;
  const l2 = `${e.imageId}  ${e.captureDate || ""}  ${e.width || ""}px`;
  const svg = `<svg width="${CW}" height="${LBL}">
    <rect width="100%" height="100%" fill="#0d0d0d"/>
    <text x="6" y="17" font-family="monospace" font-size="14" fill="#ffffff">${esc(l1)}</text>
    <text x="6" y="34" font-family="monospace" font-size="11" fill="#99aabb">${esc(l2)}</text>
    <text x="${CW - 6}" y="17" font-family="monospace" font-size="12" fill="#ffd24a" text-anchor="end">${esc(tags)}</text>
  </svg>`;
  return sharp({ create: { width: cellW, height: cellH, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: img, top: PAD, left: PAD },
      { input: Buffer.from(svg), top: PAD + CH, left: PAD },
    ]).png().toBuffer();
}

async function sheet(title, entries, outName) {
  if (!entries.length) return;
  const rows = Math.ceil(entries.length / COLS);
  const HEAD = 40;
  const W = COLS * cellW, H = HEAD + rows * cellH;
  const cells = await Promise.all(entries.map(cell));
  const comp = cells.map((buf, i) => ({ input: buf, top: HEAD + Math.floor(i / COLS) * cellH, left: (i % COLS) * cellW }));
  const head = `<svg width="${W}" height="${HEAD}"><rect width="100%" height="100%" fill="#000000"/><text x="8" y="27" font-family="monospace" font-size="20" fill="#ffffff">${esc(title)} — ${entries.length} aday</text></svg>`;
  comp.unshift({ input: Buffer.from(head), top: 0, left: 0 });
  const out = path.join(DIR, outName);
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(comp).png().toFile(out);
  console.log("wrote", path.relative(process.cwd(), out), `${W}x${H}`);
}

const slug = (s) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

let n = 0;
// Bölgesel kontak-sayfaları (preview-queue.json sırası)
for (const [region, entries] of Object.entries(queue.regions)) {
  await sheet(region, entries, `sheet-${String(++n).padStart(2, "0")}-${slug(region)}.png`);
}
// Özel sayfa: SUBURB bloğu yan yana (Helsinki/Oslo/Solna/Viyana/Prag/Berlin) —
// banliyö dokuları doğrudan karşılaştırılsın; preview görmeden kabul YOK.
const subs = Object.values(queue.regions).flat().filter((e) => (e.tags || []).includes("SUB"));
await sheet("SUBURB-KARSILASTIRMA · preview gormeden kabul YOK", subs, "sheet-00-suburb-compare.png");

console.log("\nKontak-sayfaları hazır: scripts/korNokta/preview-mapillary/sheet-*.png (gitignored)");
