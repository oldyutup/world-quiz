// Kör Nokta — gerçek dünya 360 sahne pipeline, ADIM 1: keşif + aday indirme.
//
// Panoramax (api.panoramax.xyz, STAC API) TOKENSIZ çalışır. Imgeler CC-BY-SA-4.0
// (item başına `properties.license`). Bölge bbox'larında arar, yalnızca gerçek
// equirectangular 360'ları (field_of_view===360 & 2:1 & ≥4096px) süzer, sekans
// ve mesafe bazlı tekilleştirir, kalite kapılarından (boyut/parlaklık) geçirir,
// HD'yi raw/'a indirir + küçük preview üretir, Nominatim ile reverse-geocode
// yapar ve candidates.json (preview manifest) yazar.
//
// Tekrar çalıştırılabilir: aynı sourceImageId tekrar indirilmez, candidates.json
// merge edilir. Hiç secret gerekmez.
//
//   node scripts/korNokta/fetch-panoramax.mjs [--per-region N] [--regions a,b]
//
// Sonra: preview/ klasörünü gözle incele, build-real-scenes.mjs'e iyi id'leri ver.

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, "raw");
const PREVIEW_DIR = path.join(HERE, "preview");
const CANDIDATES_PATH = path.join(HERE, "candidates.json");

const API = "https://api.panoramax.xyz/api";
const UA = "torble-kornokta-poc/1.0 (open-license 360 research; contact: github)";

// Bölgeler ÖNCELİK SIRASINA göre dizildi (Türkiye → Avrupa+ABD → gelişmiş Asya).
// Panoramax 360 HD kapsamı değişken; çoğu bölge 0 dönebilir (tokensız, açık veri).
// Kapsam yetersizliği rapor için önemli → tier alanı sahneyi gruba bağlar.
// bbox = [minLng, minLat, maxLng, maxLat].
const REGIONS = [
  // ── TIER 1 · Türkiye ────────────────────────────────────────────────────
  { key: "tr-istanbul-eu", tier: 1, bbox: [28.90, 40.98, 29.10, 41.10], hint: "Türkiye / İstanbul (Avrupa)" },
  { key: "tr-istanbul-as", tier: 1, bbox: [29.00, 40.95, 29.20, 41.05], hint: "Türkiye / İstanbul (Anadolu)" },
  { key: "tr-ankara",      tier: 1, bbox: [32.70, 39.85, 33.00, 39.98], hint: "Türkiye / Ankara" },
  { key: "tr-izmir",       tier: 1, bbox: [27.05, 38.38, 27.25, 38.48], hint: "Türkiye / İzmir" },
  { key: "tr-antalya",     tier: 1, bbox: [30.55, 36.83, 30.80, 36.98], hint: "Türkiye / Antalya kıyı" },
  { key: "tr-bursa",       tier: 1, bbox: [28.95, 40.13, 29.20, 40.27], hint: "Türkiye / Bursa" },
  { key: "tr-cappadocia",  tier: 1, bbox: [34.70, 38.58, 34.95, 38.74], hint: "Türkiye / Kapadokya" },
  { key: "tr-trabzon",     tier: 1, bbox: [39.60, 40.93, 39.90, 41.05], hint: "Türkiye / Karadeniz" },
  { key: "tr-gaziantep",   tier: 1, bbox: [37.30, 37.03, 37.45, 37.13], hint: "Türkiye / Gaziantep" },
  { key: "tr-konya",       tier: 1, bbox: [32.45, 37.84, 32.60, 37.92], hint: "Türkiye / Konya" },

  // ── TIER 2 · Avrupa çeşitliliği + ABD ───────────────────────────────────
  // Almanya
  { key: "de-berlin",   tier: 2, bbox: [13.32, 52.46, 13.52, 52.55], hint: "Almanya / Berlin" },
  { key: "de-munich",   tier: 2, bbox: [11.45, 48.10, 11.66, 48.18], hint: "Almanya / Münih" },
  { key: "de-hamburg",  tier: 2, bbox: [9.92, 53.52, 10.08, 53.60],  hint: "Almanya / Hamburg" },
  { key: "de-cologne",  tier: 2, bbox: [6.90, 50.91, 7.02, 50.97],   hint: "Almanya / Köln" },
  // İtalya
  { key: "it-rome",     tier: 2, bbox: [12.44, 41.86, 12.56, 41.93], hint: "İtalya / Roma" },
  { key: "it-milan",    tier: 2, bbox: [9.13, 45.43, 9.24, 45.50],   hint: "İtalya / Milano" },
  { key: "it-florence", tier: 2, bbox: [11.22, 43.75, 11.31, 43.80], hint: "İtalya / Floransa" },
  { key: "it-naples",   tier: 2, bbox: [14.22, 40.81, 14.31, 40.87], hint: "İtalya / Napoli" },
  // İspanya / Portekiz
  { key: "es-bcn",      tier: 2, bbox: [2.10, 41.36, 2.22, 41.43],   hint: "İspanya / Barselona" },
  { key: "es-madrid",   tier: 2, bbox: [-3.74, 40.39, -3.65, 40.46], hint: "İspanya / Madrid" },
  { key: "es-valencia", tier: 2, bbox: [-0.41, 39.45, -0.34, 39.49], hint: "İspanya / Valensiya" },
  { key: "pt-lisbon",   tier: 2, bbox: [-9.17, 38.69, -9.10, 38.74], hint: "Portekiz / Lizbon" },
  // Avusturya / İsviçre
  { key: "at-vienna",   tier: 2, bbox: [16.33, 48.18, 16.43, 48.24], hint: "Avusturya / Viyana" },
  { key: "at-innsbruck",tier: 2, bbox: [11.35, 47.24, 11.44, 47.29], hint: "Avusturya / Innsbruck (Alpler)" },
  { key: "ch-zurich",   tier: 2, bbox: [8.50, 47.35, 8.59, 47.41],   hint: "İsviçre / Zürih" },
  { key: "ch-geneva",   tier: 2, bbox: [6.11, 46.19, 6.18, 46.23],   hint: "İsviçre / Cenevre" },
  { key: "ch-alps",     tier: 2, bbox: [7.80, 46.00, 8.20, 46.40],   hint: "İsviçre / Alpler" },
  // İskandinavya
  { key: "no-oslo",     tier: 2, bbox: [10.68, 59.89, 10.80, 59.94], hint: "Norveç / Oslo" },
  { key: "se-stockholm",tier: 2, bbox: [18.02, 59.30, 18.12, 59.36], hint: "İsveç / Stockholm" },
  { key: "dk-copenhagen",tier:2, bbox: [12.53, 55.65, 12.63, 55.71], hint: "Danimarka / Kopenhag" },
  { key: "fi-helsinki", tier: 2, bbox: [24.90, 60.15, 25.00, 60.20], hint: "Finlandiya / Helsinki" },
  // Balkanlar / Orta-Doğu Avrupa
  { key: "gr-athens",   tier: 2, bbox: [23.69, 37.95, 23.79, 38.02], hint: "Yunanistan / Atina" },
  { key: "hr-zagreb",   tier: 2, bbox: [15.94, 45.78, 16.03, 45.84], hint: "Hırvatistan / Zagreb" },
  { key: "rs-belgrade", tier: 2, bbox: [20.43, 44.78, 20.51, 44.84], hint: "Sırbistan / Belgrad" },
  { key: "si-ljubljana",tier: 2, bbox: [14.47, 46.03, 14.54, 46.08], hint: "Slovenya / Ljubljana" },
  { key: "cz-prague",   tier: 2, bbox: [14.39, 50.06, 14.47, 50.11], hint: "Çekya / Prag" },
  { key: "pl-warsaw",   tier: 2, bbox: [20.97, 52.21, 21.06, 52.27], hint: "Polonya / Varşova" },
  // ABD
  { key: "us-nyc",      tier: 2, bbox: [-74.02, 40.70, -73.93, 40.81], hint: "ABD / New York" },
  { key: "us-sf",       tier: 2, bbox: [-122.47, 37.73, -122.39, 37.81], hint: "ABD / San Francisco" },
  { key: "us-la",       tier: 2, bbox: [-118.31, 34.01, -118.21, 34.09], hint: "ABD / Los Angeles" },
  { key: "us-chicago",  tier: 2, bbox: [-87.69, 41.86, -87.61, 41.93], hint: "ABD / Chicago" },
  { key: "us-seattle",  tier: 2, bbox: [-122.37, 47.58, -122.29, 47.65], hint: "ABD / Seattle" },
  { key: "us-dc",       tier: 2, bbox: [-77.06, 38.87, -76.97, 38.93], hint: "ABD / Washington DC" },

  // ── TIER 3 · Japonya / Çin / gelişmiş Asya ──────────────────────────────
  { key: "jp-tokyo",    tier: 3, bbox: [139.68, 35.64, 139.79, 35.72], hint: "Japonya / Tokyo" },
  { key: "jp-osaka",    tier: 3, bbox: [135.47, 34.65, 135.55, 34.72], hint: "Japonya / Osaka" },
  { key: "jp-kyoto",    tier: 3, bbox: [135.73, 34.98, 135.80, 35.03], hint: "Japonya / Kyoto" },
  { key: "cn-beijing",  tier: 3, bbox: [116.35, 39.87, 116.44, 39.94], hint: "Çin / Pekin" },
  { key: "cn-shanghai", tier: 3, bbox: [121.44, 31.21, 121.52, 31.27], hint: "Çin / Şanghay" },
  { key: "kr-seoul",    tier: 3, bbox: [126.96, 37.54, 127.05, 37.59], hint: "Güney Kore / Seul" },
  { key: "tw-taipei",   tier: 3, bbox: [121.50, 25.02, 121.58, 25.07], hint: "Tayvan / Taipei" },
  { key: "sg",          tier: 3, bbox: [103.81, 1.27, 103.89, 1.33],   hint: "Singapur" },

  // ── TIER 4 · Birleşik Krallık + Güney/Güneydoğu Asya + Orta Doğu ────────
  // Panoramax bu bölgelerde değişken/zayıf kapsamlı olabilir → çoğu 0 dönebilir.
  // Birleşik Krallık (mevcut script'te hiç yoktu)
  { key: "gb-london-c",  tier: 4, bbox: [-0.16, 51.49, -0.05, 51.54],  hint: "Birleşik Krallık / Londra (merkez)" },
  { key: "gb-london-e",  tier: 4, bbox: [-0.08, 51.50, 0.02, 51.55],   hint: "Birleşik Krallık / Londra (doğu)" },
  { key: "gb-manchester",tier: 4, bbox: [-2.27, 53.46, -2.20, 53.50],  hint: "Birleşik Krallık / Manchester" },
  { key: "gb-edinburgh", tier: 4, bbox: [-3.22, 55.93, -3.16, 55.97],  hint: "Birleşik Krallık / Edinburgh" },
  { key: "gb-glasgow",   tier: 4, bbox: [-4.30, 55.85, -4.23, 55.88],  hint: "Birleşik Krallık / Glasgow" },
  // Güney Kore (Seul tier 3'te; Busan ekle)
  { key: "kr-busan",     tier: 4, bbox: [129.02, 35.14, 129.10, 35.20], hint: "Güney Kore / Busan" },
  // Güneydoğu Asya
  { key: "th-bangkok",   tier: 4, bbox: [100.48, 13.72, 100.56, 13.78], hint: "Tayland / Bangkok" },
  { key: "vn-hanoi",     tier: 4, bbox: [105.82, 21.01, 105.87, 21.05], hint: "Vietnam / Hanoi" },
  { key: "vn-hcmc",      tier: 4, bbox: [106.67, 10.76, 106.72, 10.80], hint: "Vietnam / Ho Chi Minh" },
  { key: "id-jakarta",   tier: 4, bbox: [106.78, -6.23, 106.86, -6.15], hint: "Endonezya / Jakarta" },
  { key: "my-kl",        tier: 4, bbox: [101.67, 3.12, 101.73, 3.17],   hint: "Malezya / Kuala Lumpur" },
  { key: "ph-manila",    tier: 4, bbox: [120.96, 14.56, 121.02, 14.62], hint: "Filipinler / Manila" },
  // Güney Asya (Hindistan'ı genişlet)
  { key: "in-delhi",     tier: 4, bbox: [77.19, 28.58, 77.26, 28.65],   hint: "Hindistan / Yeni Delhi" },
  { key: "in-bangalore", tier: 4, bbox: [77.55, 12.94, 77.63, 13.01],   hint: "Hindistan / Bengaluru" },
  { key: "in-mumbai",    tier: 4, bbox: [72.81, 18.91, 72.89, 18.99],   hint: "Hindistan / Mumbai" },
  // Orta Doğu (Türkiye dışı)
  { key: "il-telaviv",   tier: 4, bbox: [34.75, 32.05, 34.82, 32.11],   hint: "İsrail / Tel Aviv" },
  { key: "ae-dubai",     tier: 4, bbox: [55.25, 25.17, 55.33, 25.23],   hint: "BAE / Dubai" },
  { key: "jo-amman",     tier: 4, bbox: [35.89, 31.93, 35.97, 31.99],   hint: "Ürdün / Amman" },
  { key: "qa-doha",      tier: 4, bbox: [51.49, 25.26, 51.56, 25.32],   hint: "Katar / Doha" },

  // ── TIER 5 · Afrika + Okyanusya (seçkin; kapsam çok zayıf, çoğu 0) ──────
  { key: "za-capetown",  tier: 5, bbox: [18.39, -33.95, 18.47, -33.89], hint: "Güney Afrika / Cape Town" },
  { key: "za-joburg",    tier: 5, bbox: [28.01, -26.23, 28.08, -26.17], hint: "Güney Afrika / Johannesburg" },
  { key: "ke-nairobi",   tier: 5, bbox: [36.79, -1.31, 36.86, -1.25],   hint: "Kenya / Nairobi" },
  { key: "sn-dakar",     tier: 5, bbox: [-17.49, 14.65, -17.41, 14.72], hint: "Senegal / Dakar" },
  { key: "ma-casablanca",tier: 5, bbox: [-7.65, 33.56, -7.57, 33.62],   hint: "Fas / Casablanca" },
  { key: "tn-tunis",     tier: 5, bbox: [10.14, 36.78, 10.21, 36.83],   hint: "Tunus / Tunis" },
  { key: "eg-cairo",     tier: 5, bbox: [31.21, 30.02, 31.28, 30.08],   hint: "Mısır / Kahire" },
  { key: "au-sydney",    tier: 5, bbox: [151.18, -33.89, 151.24, -33.84], hint: "Avustralya / Sydney" },
  { key: "au-melbourne", tier: 5, bbox: [144.94, -37.83, 145.00, -37.78], hint: "Avustralya / Melbourne" },
  { key: "nz-auckland",  tier: 5, bbox: [174.74, -36.87, 174.80, -36.83], hint: "Yeni Zelanda / Auckland" },

  // ── Kanıtlanmış kapsam (fallback; çoğu zaten indirildi, dedup atlar) ─────
  { key: "fr-alps",      tier: 9, bbox: [5.4, 44.8, 7.3, 46.4],   hint: "Fransa / Alpler" },
  { key: "fr-med",       tier: 9, bbox: [2.6, 43.0, 6.2, 44.1],   hint: "Fransa / Akdeniz" },
  { key: "fr-brittany",  tier: 9, bbox: [-4.7, 47.6, -1.9, 48.8], hint: "Fransa / Bretanya" },
  { key: "nl",           tier: 9, bbox: [3.5, 51.5, 7.0, 53.4],   hint: "Hollanda" },
  { key: "be",           tier: 9, bbox: [3.0, 50.6, 5.0, 51.3],   hint: "Belçika / Flanders" },
  { key: "in-mh",        tier: 9, bbox: [72.0, 18.0, 78.0, 24.0], hint: "Hindistan / Maharashtra" },
];

const SEARCH_LIMIT = 250;   // bölge başına çekilen item (en-yeni sıralı)
const MIN_WIDTH = 4096;     // kalite: HD genişlik alt sınırı
const RATIO_TOL = 0.06;     // 2:1 toleransı
const LUM_MIN = 42;         // çok karanlık eleme
const LUM_MAX = 225;        // patlamış/aşırı parlak eleme
const MIN_DIST_M = 350;     // aynı bölgede çok yakın kareleri ele
const NOMINATIM_THROTTLE_MS = 1100;

// ---- yardımcılar ----------------------------------------------------------

function is360(f) {
  const io = f?.properties?.["pers:interior_orientation"];
  if (!io || io.field_of_view !== 360) return false;
  const [w, h] = io.sensor_array_dimensions || [];
  if (!w || !h) return false;
  if (Math.abs(w / h - 2) > RATIO_TOL) return false;
  if (w < MIN_WIDTH) return false;
  return true;
}

function haversineM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function plausibleDate(iso) {
  if (!iso) return null;
  const y = Number(String(iso).slice(0, 4));
  const now = new Date().getFullYear();
  if (!Number.isFinite(y) || y < 1990 || y > now + 1) return null; // EXIF bozuk tarihleri ele
  return String(iso).slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

let lastNominatim = 0;
const geoCache = new Map();
async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const wait = NOMINATIM_THROTTLE_MS - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  try {
    const j = await getJson(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&accept-language=en`,
    );
    const a = j.address || {};
    const out = {
      country: a.country || null,
      countryCode: (a.country_code || "").toUpperCase() || null,
      region: a.state || a.region || a.county || null,
      city: a.city || a.town || a.village || a.municipality || a.suburb || null,
    };
    geoCache.set(key, out);
    return out;
  } catch (e) {
    console.warn(`    ! geocode başarısız (${key}): ${e.message}`);
    return { country: null, countryCode: null, region: null, city: null };
  }
}

async function meanLuminance(buf) {
  const { data, info } = await sharp(buf)
    .resize(32, 16, { fit: "fill" }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  const px = data.length / info.channels;
  for (let i = 0; i < data.length; i += info.channels) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / px;
}

// ---- ana akış -------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const perRegion = Number(
    (args.find((a) => a.startsWith("--per-region="))?.split("=")[1]) ??
    (args.includes("--per-region") ? args[args.indexOf("--per-region") + 1] : 3),
  ) || 3;
  const onlyRegions = (args.find((a) => a.startsWith("--regions="))?.split("=")[1] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const regions = onlyRegions.length
    ? REGIONS.filter((r) => onlyRegions.includes(r.key))
    : REGIONS;

  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.mkdir(PREVIEW_DIR, { recursive: true });

  // Mevcut candidates.json'u yükle (merge + dedupe için)
  let candidates = [];
  if (existsSync(CANDIDATES_PATH)) {
    try { candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf8")).candidates || []; }
    catch { candidates = []; }
  }
  const knownIds = new Set(candidates.map((c) => c.sourceImageId));

  console.log(`fetch-panoramax — ${regions.length} bölge, hedef ${perRegion}/bölge`);
  console.log(`mevcut aday: ${candidates.length}\n`);

  let added = 0, skippedDup = 0, skippedQuality = 0;

  for (const region of regions) {
    console.log(`▸ ${region.key} (${region.hint})`);
    let feats = [];
    try {
      const j = await getJson(`${API}/search?bbox=${region.bbox.join(",")}&limit=${SEARCH_LIMIT}`);
      feats = (j.features || []).filter(is360);
    } catch (e) {
      console.warn(`  ! arama başarısız: ${e.message}`);
      continue;
    }
    console.log(`  ${feats.length} adet 360 HD bulundu`);

    const seenCollections = new Set();
    const regionPoints = candidates
      .filter((c) => c.region === region.key)
      .map((c) => ({ lat: c.lat, lng: c.lng }));
    let takenThisRegion = 0;

    for (const f of feats) {
      if (takenThisRegion >= perRegion) break;
      const id = f.id;
      if (knownIds.has(id)) { skippedDup++; continue; }

      const collection = f.properties?.collection || f.collection || null;
      if (collection && seenCollections.has(collection)) { skippedDup++; continue; }

      const [lng, lat] = f.geometry?.coordinates || [];
      if (lat == null || lng == null) continue;
      if (regionPoints.some((p) => haversineM(p, { lat, lng }) < MIN_DIST_M)) { skippedDup++; continue; }

      const hd = f.assets?.hd?.href;
      if (!hd) continue;
      const io = f.properties["pers:interior_orientation"];
      const [w, h] = io.sensor_array_dimensions;

      // HD indir
      let buf;
      try {
        const res = await fetch(hd, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        console.warn(`  ! indirme atlandı ${id.slice(0, 8)}: ${e.message}`);
        continue;
      }

      // Kalite: parlaklık
      let lum;
      try { lum = await meanLuminance(buf); }
      catch { skippedQuality++; continue; }
      if (lum < LUM_MIN || lum > LUM_MAX) {
        console.log(`  - eleme ${id.slice(0, 8)} (parlaklık ${lum.toFixed(0)})`);
        skippedQuality++; continue;
      }

      // raw + preview yaz
      const rawPath = path.join(RAW_DIR, `${id}.jpg`);
      await fs.writeFile(rawPath, buf);
      const previewPath = path.join(PREVIEW_DIR, `${id}.jpg`);
      await sharp(buf).resize(1024, 512, { fit: "fill" }).jpeg({ quality: 80 }).toFile(previewPath);

      const geo = await reverseGeocode(lat, lng);
      seenCollections.add(collection);
      regionPoints.push({ lat, lng });
      takenThisRegion++;
      added++;

      const cand = {
        sourceImageId: id,
        source: "panoramax",
        region: region.key,
        regionHint: region.hint,
        tier: region.tier ?? 9,
        collection,
        lat, lng,
        hdWidth: w, hdHeight: h,
        fileSizeMB: +(buf.length / 1048576).toFixed(2),
        luminance: +lum.toFixed(0),
        license: f.properties.license || "CC-BY-SA-4.0",
        author: f.properties["geovisio:producer"] || "Panoramax katkıcısı",
        captureDate: plausibleDate(f.properties.datetime),
        imageUrl: f.properties["geovisio:image"] || hd,
        viewerUrl: `https://api.panoramax.xyz/#focus=pic&pic=${id}`,
        country: geo.country,
        countryCode: geo.countryCode,
        geoRegion: geo.region,
        city: geo.city,
        rawPath: path.relative(path.join(HERE, "..", ".."), rawPath),
        previewPath: path.relative(path.join(HERE, "..", ".."), previewPath),
      };
      candidates.push(cand);
      knownIds.add(id);
      console.log(`  + ${id.slice(0, 8)}  ${w}×${h}  ${cand.fileSizeMB}MB  lum=${cand.luminance}  | ${[geo.country, geo.region, geo.city].filter(Boolean).join(" / ")}`);
    }
  }

  candidates.sort((a, b) => (a.region + a.sourceImageId).localeCompare(b.region + b.sourceImageId));
  await fs.writeFile(
    CANDIDATES_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: candidates.length, candidates }, null, 2),
  );

  console.log(`\n────────────────────────────────────────`);
  console.log(`eklenen: ${added}   tekrar/atlanan: ${skippedDup}   kalite-eleme: ${skippedQuality}`);
  console.log(`toplam aday: ${candidates.length}`);
  console.log(`preview manifest: ${path.relative(process.cwd(), CANDIDATES_PATH)}`);
  console.log(`önizlemeler: ${path.relative(process.cwd(), PREVIEW_DIR)}/<id>.jpg`);
  console.log(`\nSonraki adım: preview'ları incele, sonra:`);
  console.log(`  node scripts/korNokta/build-real-scenes.mjs <id1> <id2> ...`);
}

main().catch((e) => { console.error(e); process.exit(1); });
