// Kör Nokta — gerçek dünya 360 sahne pipeline, ADIM 2: finalize.
//
// CURATION map'teki (gözle seçilmiş) adayları candidates.json + raw/'dan alır,
// 4096×2048 WebP'ye normalize eder (gerçek equirectangular → seam düzeltmesi
// GEREKMEZ), public/assets/kor-nokta-real/ altına yazar, manifest.json (atıf
// defteri) üretir ve korNoktaRealScenes.ts'i CODEGEN eder.
//
// Tekrar çalıştırılabilir (deterministik): CURATION ne ise onu üretir.
//   node scripts/korNokta/build-real-scenes.mjs
//
// Yeni sahne eklemek: fetch ile aday indir, preview'ı incele, sourceImageId'yi
// CURATION'a ekle, scripti tekrar çalıştır.

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const RAW_DIR = path.join(HERE, "raw");
const CANDIDATES_PATH = path.join(HERE, "candidates.json");
const OUT_DIR = path.join(ROOT, "public", "assets", "kor-nokta-real");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const SCENES_TS_PATH = path.join(ROOT, "src", "modes", "korNokta", "korNoktaRealScenes.ts");

const WIDTH = 4096, HEIGHT = 2048, WEBP_QUALITY = 82;

// Panoramax item başına lisans DEĞİŞİR (çoğu CC-BY-SA-4.0; bir kısmı Etalab/
// Licence Ouverte). Lisansı HARDCODE ETME — atıf yanlış olur. Yalnız açık /
// yeniden-kullanılabilir lisanslara izin ver (whitelist); başka kod görülürse
// sahne atlanır (yanlış atıf riskine karşı). resolveLicense(cand.license).
const LICENSES = {
  "CC-BY-SA-4.0": { label: "CC-BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
  "CC-BY-4.0":    { label: "CC-BY 4.0",    url: "https://creativecommons.org/licenses/by/4.0/" },
  "etalab-2.0":   { label: "Etalab 2.0",   url: "https://www.etalab.gouv.fr/licence-ouverte-open-licence" },
};
function resolveLicense(code) {
  return LICENSES[code] || null;
}

// ── KÜRASYON ───────────────────────────────────────────────────────────────
// Gözle seçilen 10 sahne. Sıra = oyun id sırası. title/shortTitle KONUM
// SIZDIRMAZ (nötr, betimleyici). regionLabel reveal sonrası gösterilir.
const CURATION = [
  // ── TIER 1 · TÜRKİYE (5) — Panoramax kapsamı beklenenden iyi: İstanbul/Bursa/İzmir
  { srcId: "cd6f47ea-...", cc: "tr", slug: "gokdelenli-bulvar",
    title: "Gökdelenli Geniş Bulvar", shortTitle: "Geniş Bulvar", difficulty: "normal",
    categories: ["architecture", "geography"],
    extraBans: ["istanbul", "stambul", "marmara", "bogazici", "bogaz", "bosphorus", "bosfor",
      "atasehir", "anadolu", "anatolia", "turk", "turkish"] },
  { srcId: "fa09acae-...", cc: "tr", slug: "kent-otoyolu",
    title: "Modern Kent Otoyolu", shortTitle: "Kent Otoyolu", difficulty: "normal",
    categories: ["architecture", "geography"],
    extraBans: ["istanbul", "stambul", "marmara", "bogaz", "bosphorus", "atasehir",
      "anadolu", "anatolia", "turk", "turkish"] },
  { srcId: "2012cc6a-...", cc: "tr", slug: "alisveris-caddesi",
    title: "Tabelalı Alışveriş Caddesi", shortTitle: "Çarşı Caddesi", difficulty: "normal",
    categories: ["architecture", "people", "geography"],
    extraBans: ["bursa", "osmangazi", "uludag", "marmara", "turk", "turkish", "anadolu"] },
  { srcId: "b28fbdb1-...", cc: "tr", slug: "dukkanli-sokak",
    title: "Dükkanlı Mahalle Sokağı", shortTitle: "Dükkan Sokağı", difficulty: "normal",
    categories: ["architecture", "people"],
    extraBans: ["bursa", "osmangazi", "uludag", "marmara", "turk", "turkish", "anadolu"] },
  { srcId: "6b8792e1-...", cc: "tr", slug: "ege-sehir-caddesi",
    title: "Sıcak İklimde Şehir Caddesi", shortTitle: "Şehir Caddesi", difficulty: "normal",
    categories: ["geography", "architecture", "people"],
    extraBans: ["izmir", "smyrna", "konak", "ege", "aegean", "kordon", "turk", "turkish", "anadolu"] },

  // ── TIER 2 · AVRUPA + ABD ───────────────────────────────────────────────
  // Fransa (5)
  { srcId: "6726f4ce-24ff-4820-a0f2-48e375707bc4", cc: "fr", slug: "kasaba-istasyonu",
    title: "Kasaba Akaryakıt İstasyonu", shortTitle: "Kasaba", difficulty: "normal",
    categories: ["architecture", "people", "geography"],
    extraBans: ["pontaumur", "puy de dome", "puydedome", "puy-de-dome", "auvergne", "clermont"] },
  { srcId: "a8bededc-03df-4d65-b845-d92fe6b2305b", cc: "fr", slug: "dag-koyu-yolu",
    title: "Dağ Eteğinde Köy Yolu", shortTitle: "Dağ Köyü", difficulty: "easy",
    categories: ["geography", "architecture", "people"],
    extraBans: ["villard", "bonnot", "grenoble", "isere", "belledonne", "alpes", "alps", "alpler"] },
  { srcId: "c548d5ed-735f-4583-8014-6676c5cf254e", cc: "fr", slug: "dag-manzarali-gecit",
    title: "Dağ Manzaralı Yaya Geçidi", shortTitle: "Dağ Yolu", difficulty: "normal",
    categories: ["geography", "architecture"],
    extraBans: ["villard", "bonnot", "grenoble", "isere", "belledonne", "alpes", "alps", "alpler"] },
  { srcId: "ea6987cf-9506-4fb0-aa17-a432e3a95eb5", cc: "fr", slug: "orman-kanal-yolu",
    title: "Orman İçindeki Kanal Yolu", shortTitle: "Kanal Yolu", difficulty: "hard",
    categories: ["geography", "architecture"],
    extraBans: ["rostrenen", "bretagne", "breton", "brittany", "bretanya", "armor", "canaux"] },
  { srcId: "f635be7e-2cbf-49e9-af76-1f91a014d72a", cc: "fr", slug: "gunesli-koy-sokagi",
    title: "Güneşli Köy Sokağı", shortTitle: "Köy Sokağı", difficulty: "normal",
    categories: ["architecture", "people", "geography"],
    extraBans: ["pontaumur", "puy de dome", "puydedome", "puy-de-dome", "auvergne", "clermont"] },
  // Hollanda (2)
  { srcId: "2284852f-0fac-4fb8-b95f-38392a12a7ac", cc: "nl", slug: "orman-kavsagi",
    title: "Çam Ormanında Kavşak", shortTitle: "Orman Kavşağı", difficulty: "hard",
    categories: ["geography", "architecture"],
    extraBans: ["loenen", "gelderland", "veluwe", "apeldoorn", "arnhem", "eerbeek", "brummen"] },
  { srcId: "2d3803d8-23eb-4dbe-9663-4e78cede090c", cc: "nl", slug: "kentsel-otoyol",
    title: "Kentsel Otoyol ve Grafiti", shortTitle: "Kent Otoyolu", difficulty: "hard",
    categories: ["architecture", "geography"],
    extraBans: ["utrecht"] },
  // Belçika (1)
  { srcId: "9f8cf6cd-5764-470f-8df6-fe6b2ba25467", cc: "be", slug: "yazin-otoyol",
    title: "Yazın Otoyol Kenarı", shortTitle: "Otoyol", difficulty: "hard",
    categories: ["geography", "architecture"],
    extraBans: ["aalst", "alost", "flanders", "vlaanderen", "gent", "ghent", "gand"] },
  // İtalya (1)
  { srcId: "f5702a76-...", cc: "it", slug: "tarihi-tas-mimari",
    title: "Tarihi Taş Mimarili Sokak", shortTitle: "Taş Mimari", difficulty: "normal",
    categories: ["architecture", "geography"],
    extraBans: ["floransa", "florence", "firenze", "toscana", "tuscany", "arno", "italyan", "italian"] },
  // İspanya (2)
  { srcId: "ba92d7da-...", cc: "es", slug: "klasik-cephe-caddesi",
    title: "Klasik Cepheli Şehir Caddesi", shortTitle: "Klasik Cadde", difficulty: "normal",
    categories: ["architecture", "geography"],
    extraBans: ["madrid", "castilla", "iberia", "ispanyol", "espanol", "espanyol"] },
  { srcId: "610b30df-...", cc: "es", slug: "merkez-caddesi",
    title: "Şehir Merkezinde Cadde", shortTitle: "Merkez Caddesi", difficulty: "normal",
    categories: ["architecture"],
    extraBans: ["madrid", "castilla", "iberia", "ispanyol"] },
  // Portekiz (1) — Etalab 2.0 lisanslı (CC-BY-SA değil; resolveLicense doğru etiketler)
  { srcId: "93c0aa4a-...", cc: "pt", slug: "agacli-sehir-parki",
    title: "Ağaçlık Şehir Parkı", shortTitle: "Şehir Parkı", difficulty: "hard",
    categories: ["geography"],
    extraBans: ["lizbon", "lisbon", "lisboa", "tejo", "tagus", "iberia", "portekiz", "portuguese"] },
  // ABD (2)
  { srcId: "a9a76bd1-...", cc: "us", slug: "bulutlu-kent-sokagi",
    title: "Bulutlu Kent Sokağı", shortTitle: "Kent Sokağı", difficulty: "normal",
    categories: ["architecture", "geography"],
    extraBans: ["seattle", "washington", "pacific", "kaliforniya", "california"] },
  { srcId: "7accecb8-...", cc: "us", slug: "modern-binalar-cadde",
    title: "Cadde ve Modern Binalar", shortTitle: "Modern Cadde", difficulty: "normal",
    categories: ["architecture"],
    extraBans: ["seattle", "washington", "pacific"] },

  // ── TIER 3 · ASYA (Hindistan + Japonya + Tayvan) ────────────────────────
  // Hindistan (2) — Devanagari alfabe güçlü ipucu
  { srcId: "39b9b320-302d-45d0-9d27-cdbd47c5c82a", cc: "in", slug: "carsi-caddesi",
    title: "Kalabalık Çarşı Caddesi", shortTitle: "Çarşı Caddesi", difficulty: "normal",
    categories: ["people", "architecture", "geography"],
    extraBans: ["pune", "poona", "maharashtra", "maharastra", "deccan", "dekkan"] },
  { srcId: "32f6bde8-d386-4dd3-b67e-b720e9c9deca", cc: "in", slug: "mahalle-sokagi",
    title: "Sıcak İklimde Mahalle Sokağı", shortTitle: "Mahalle Sokağı", difficulty: "normal",
    categories: ["people", "architecture", "geography"],
    extraBans: ["pune", "poona", "maharashtra", "maharastra", "deccan", "dekkan"] },
  // Japonya (3) — Japonca alfabe + yoğun modern doku
  { srcId: "1f296636-...", cc: "jp", slug: "yogun-is-merkezi",
    title: "Yoğun İş Merkezi", shortTitle: "İş Merkezi", difficulty: "normal",
    categories: ["architecture", "geography"],
    extraBans: ["kyoto", "kioto", "kansai", "honshu", "nippon", "nihon", "japon", "japonca"] },
  { srcId: "1cc322e7-...", cc: "jp", slug: "cam-cepheli-sokak",
    title: "Cam Cepheli Şehir Sokağı", shortTitle: "Cam Cepheli Sokak", difficulty: "normal",
    categories: ["architecture", "geography"],
    extraBans: ["tokyo", "tokio", "minato", "kanto", "honshu", "edo", "nippon", "nihon", "japonca"] },
  { srcId: "93fedafc-...", cc: "jp", slug: "gokdelen-caddesi",
    title: "Gökdelen Dibinde Cadde", shortTitle: "Gökdelen Caddesi", difficulty: "normal",
    categories: ["architecture"],
    extraBans: ["tokyo", "tokio", "chiyoda", "kanto", "edo", "nippon", "nihon", "japonca"] },
  // Tayvan (1) — Çince karakter + alacakaranlık doku
  { srcId: "a6637a5d-...", cc: "tw", slug: "alacakaranlik-cadde",
    title: "Alacakaranlıkta Asya Caddesi", shortTitle: "Asya Caddesi", difficulty: "hard",
    categories: ["architecture", "geography", "people"],
    extraBans: ["taipei", "taibei", "tayvan", "formosa", "cin", "china", "chinese", "beijing", "sanghay"] },
];

// Ülke adı + yaygın varyantları (yasaklı kelime tabanı).
const COUNTRY_BANS = {
  France:          ["fransa", "france", "french", "fransız", "fransiz", "francais", "français"],
  Netherlands:     ["hollanda", "holland", "netherlands", "nederland", "dutch", "felemenk", "flemenk"],
  Belgium:         ["belçika", "belcika", "belgium", "belgie", "belgië", "belgique", "belgian"],
  India:           ["hindistan", "india", "indian", "hint", "hintli", "bharat", "hindustan"],
  Turkey:          ["türkiye", "turkiye", "turkey", "türk", "turk", "turkish", "türkçe", "turkce", "anadolu", "anatolia"],
  Italy:           ["italya", "italy", "italian", "italia", "italyan", "italiano"],
  Spain:           ["ispanya", "spain", "spanish", "espana", "españa", "ispanyol", "espanol", "español"],
  Portugal:        ["portekiz", "portugal", "portuguese", "portekizce", "português"],
  Japan:           ["japonya", "japan", "japanese", "japon", "nippon", "nihon"],
  Taiwan:          ["tayvan", "taiwan", "taiwanese", "formosa", "çin", "cin", "china", "chinese"],
  "United States": ["abd", "usa", "amerika", "america", "american", "amerikan", "united states", "birleşik devletler", "birlesik devletler"],
};

// ── yardımcılar ──────────────────────────────────────────────────────────
// Türkçe + aksanlı harfleri ASCII'ye katlar (korNoktaScenes.ts normalize notuyla uyumlu).
function foldAscii(s) {
  return String(s).toLowerCase()
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ç/g, "c").replace(/ö/g, "o").replace(/ü/g, "u")
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function addWord(set, w) {
  if (!w) return;
  const low = String(w).toLowerCase().trim();
  if (low.length < 2) return;
  set.add(low);
  const folded = foldAscii(low);
  if (folded !== low) set.add(folded);
}
function buildBannedWords(geo, country, extra) {
  const set = new Set();
  (COUNTRY_BANS[country] || []).forEach((w) => addWord(set, w));
  addWord(set, geo.country);
  addWord(set, geo.geoRegion);
  addWord(set, geo.city);
  (extra || []).forEach((w) => addWord(set, w));
  return [...set].sort();
}
function regionLabel(geo) {
  return [geo.city, geo.geoRegion, geo.country].filter(Boolean).join(", ");
}

// ── ana akış ───────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(CANDIDATES_PATH)) {
    console.error("✗ candidates.json yok — önce fetch-panoramax.mjs çalıştır.");
    process.exit(1);
  }
  const { candidates } = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf8"));
  const byId = new Map(candidates.map((c) => [c.sourceImageId, c]));
  // CURATION srcId tam UUID veya kısa önek ("cd6f47ea-...") olabilir; öneki çöz.
  function resolveCand(srcId) {
    if (byId.has(srcId)) return byId.get(srcId);
    const prefix = srcId.replace(/[.\s]+$/, "").replace(/-+$/, "");
    const hits = candidates.filter((c) => c.sourceImageId.startsWith(prefix));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) { console.warn(`! belirsiz önek (${hits.length} eşleşme): ${prefix}`); }
    return null;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  const manifest = [];
  let totalBytes = 0, order = 0, skipped = 0;

  for (const cur of CURATION) {
    const cand = resolveCand(cur.srcId);
    if (!cand) { console.warn(`! aday yok, atlandı: ${cur.srcId.slice(0, 8)}`); skipped++; continue; }
    const lic = resolveLicense(cand.license);
    if (!lic) { console.warn(`! lisans whitelist dışı (${cand.license}), atlandı: ${cur.srcId.slice(0, 8)}`); skipped++; continue; }
    const rawPath = path.join(RAW_DIR, `${cand.sourceImageId}.jpg`);
    if (!existsSync(rawPath)) { console.warn(`! raw yok, atlandı: ${cur.srcId.slice(0, 8)}`); skipped++; continue; }

    order++;
    const id = `kn_real_${String(order).padStart(3, "0")}_${cur.cc}_${cur.slug}`;
    const fileName = `${id}.webp`;
    const outPath = path.join(OUT_DIR, fileName);

    // Gerçek equirectangular → süpersampling resize + hafif unsharp + webp. Seam yok.
    await sharp(rawPath)
      .resize(WIDTH, HEIGHT, { kernel: "lanczos3", fit: "fill" })
      .removeAlpha()
      .sharpen({ sigma: 0.7, m1: 0.3, m2: 0.15 })
      .webp({ quality: WEBP_QUALITY, effort: 5 })
      .toFile(outPath);

    const bytes = (await fs.stat(outPath)).size;
    totalBytes += bytes;

    const geo = { country: cand.country, geoRegion: cand.geoRegion, city: cand.city };
    const bannedWords = buildBannedWords(geo, cand.country, cur.extraBans);

    manifest.push({
      id,
      title: cur.title,
      shortTitle: cur.shortTitle,
      imagePath: `/assets/kor-nokta-real/${fileName}`,
      lat: cand.lat,
      lng: cand.lng,
      yearLabel: "Günümüz",
      regionLabel: regionLabel(geo),
      difficulty: cur.difficulty,
      categories: cur.categories,
      sourceType: "real_world",
      bannedWords,
      // — atıf / lisans —
      source: cand.source,
      sourceImageId: cand.sourceImageId,
      author: cand.author,
      attributionUrl: cand.viewerUrl,
      license: lic.label,
      licenseUrl: lic.url,
      captureDate: cand.captureDate,
      modified: true, // 4096x2048'e resize edildi (görsel içeriği değişmedi)
      country: cand.country,
      region: cand.geoRegion,
      city: cand.city,
      fileSizeMB: +(bytes / 1048576).toFixed(2),
    });

    console.log(`✓ ${id}  ${(bytes / 1048576).toFixed(2)}MB  | ${regionLabel(geo)}`);
  }

  // manifest.json
  await fs.writeFile(
    MANIFEST_PATH,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "panoramax",
      licenseNote: "Lisans sahne başına değişir (çoğu CC-BY-SA 4.0; bazıları Etalab 2.0). Her sahnenin gerçek lisansı scenes[].license / licenseUrl alanındadır.",
      licenseBreakdown: manifest.reduce((acc, s) => { acc[s.license] = (acc[s.license] || 0) + 1; return acc; }, {}),
      note: "Görseller 4096x2048 equirectangular WebP'ye resize edildi (modified=true). Görsel içeriği AYNALANMADI/çevrilmedi; viewer real_world sahneleri mirrorX ile düzeltir. Atıf viewer badge'inde gösterilir.",
      count: manifest.length,
      scenes: manifest,
    }, null, 2) + "\n",
  );

  // codegen korNoktaRealScenes.ts
  await fs.writeFile(SCENES_TS_PATH, renderScenesTs(manifest));

  const totalMB = (totalBytes / 1048576).toFixed(2);
  console.log(`\n────────────────────────────────────────`);
  console.log(`üretilen sahne: ${manifest.length}   atlanan: ${skipped}`);
  console.log(`toplam webp boyutu: ${totalMB}MB   (ort ${(totalBytes / 1048576 / Math.max(1, manifest.length)).toFixed(2)}MB)`);
  console.log(`görseller: public/assets/kor-nokta-real/*.webp`);
  console.log(`manifest:  ${path.relative(ROOT, MANIFEST_PATH)}`);
  console.log(`sahneler:  ${path.relative(ROOT, SCENES_TS_PATH)} (codegen)`);
}

function tsArr(arr) {
  return "[" + arr.map((s) => JSON.stringify(s)).join(", ") + "]";
}
function renderScenesTs(scenes) {
  const head =
`// ⚠️  OTOMATİK ÜRETİLDİ — elle düzenleme. scripts/korNokta/build-real-scenes.mjs üretir.
//
// Gerçek dünya 360 test sahneleri (Panoramax; açık lisans, sahne başına değişir —
// çoğu CC-BY-SA 4.0, bazıları Etalab 2.0). Kör Nokta web-only; bu sahneler native
// bundle'a girmez (prune-app-assets + KN_INCLUDE_REAL_SCENES). AI/tarihi sahneler
// korNoktaScenes.ts'tedir; bu dosya onları ETKİLEMEZ. Görseller 4096x2048 WebP'ye
// resize edilmiştir (attribution.modified=true); görsel İÇERİĞİ aynalanmadı —
// viewer real_world sahnelerde yazıları mirrorX ile düz okutur.

import type { KorNoktaScene } from "./korNoktaScenes";

export const korNoktaRealScenes: KorNoktaScene[] = [
`;
  const body = scenes.map((s) => {
    return `  {
    id: ${JSON.stringify(s.id)},
    title: ${JSON.stringify(s.title)},
    shortTitle: ${JSON.stringify(s.shortTitle)},
    imagePath: ${JSON.stringify(s.imagePath)},
    location: { lat: ${s.lat}, lng: ${s.lng} },
    yearLabel: ${JSON.stringify(s.yearLabel)},
    regionLabel: ${JSON.stringify(s.regionLabel)},
    difficulty: ${JSON.stringify(s.difficulty)},
    categories: ${tsArr(s.categories)},
    bannedWords: ${tsArr(s.bannedWords)},
    sourceType: "real_world",
    attribution: {
      source: ${JSON.stringify(s.source)},
      sourceImageId: ${JSON.stringify(s.sourceImageId)},
      author: ${JSON.stringify(s.author)},
      attributionUrl: ${JSON.stringify(s.attributionUrl)},
      license: ${JSON.stringify(s.license)},
      licenseUrl: ${JSON.stringify(s.licenseUrl)},${s.captureDate ? `\n      captureDate: ${JSON.stringify(s.captureDate)},` : ""}
      modified: true,
    },
  },`;
  }).join("\n");
  return head + body + "\n];\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
