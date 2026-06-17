// Geçici QC aracı: aday preview'larını etiketli kontak-sayfası montajına diz.
// node scripts/korNokta/montage.mjs <out.png> <id1> <id2> ...
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW = path.join(HERE, "preview");
const cands = JSON.parse(await import("node:fs").then(m => m.readFileSync(path.join(HERE, "candidates.json"), "utf8"))).candidates;
const byId = new Map(cands.map(c => [c.sourceImageId, c]));

const [, , out, ...ids] = process.argv;
const TW = 512, TH = 256, LBL = 26, COLS = 2;
const cells = [];
for (const idArg of ids) {
  const c = [...byId.keys()].find(k => k.startsWith(idArg)) || idArg;
  const cand = byId.get(c);
  const label = `${idArg.slice(0,8)}  ${cand ? [cand.country, cand.city].filter(Boolean).join("/") : "?"}  ${cand?cand.hdWidth+"x"+cand.hdHeight:""} lum${cand?.luminance??"?"}`;
  const img = await sharp(path.join(PREVIEW, `${c}.jpg`)).resize(TW, TH, { fit: "fill" }).toBuffer();
  const svg = Buffer.from(`<svg width="${TW}" height="${LBL}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="18" font-family="monospace" font-size="15" fill="#fff">${label.replace(/&/g,"&amp;")}</text></svg>`);
  const cell = await sharp({ create: { width: TW, height: TH + LBL, channels: 3, background: "#000" } })
    .composite([{ input: img, top: LBL, left: 0 }, { input: svg, top: 0, left: 0 }])
    .png().toBuffer();
  cells.push(cell);
}
const rows = Math.ceil(cells.length / COLS);
const W = TW * COLS, H = (TH + LBL) * rows;
const composite = cells.map((c, i) => ({ input: c, top: Math.floor(i / COLS) * (TH + LBL), left: (i % COLS) * TW }));
await sharp({ create: { width: W, height: H, channels: 3, background: "#000" } }).composite(composite).png().toFile(out);
console.log("wrote", out, W + "x" + H);
