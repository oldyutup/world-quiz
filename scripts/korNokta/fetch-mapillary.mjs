// Kör Nokta — gerçek dünya 360 sahne pipeline, ALTERNATİF KAYNAK: Mapillary.
//
// Panoramax açık-lisanslı true-360 kapsamı FR/NL/BE/TR dışında çok zayıf çıktı
// (Almanya/İtalya/İskandinavya/Balkanlar/Asya/Afrika ≈ 0 kullanılabilir 360).
// Mapillary (graph.mapillary.com) görüntüleri CC-BY-SA 4.0'dır ve KÜRESEL
// kapsamı çok daha geniştir → coğrafi çeşitlilik için bu kaynak gerekli.
//
// KEŞİF MODELİ: /images?bbox= spatial endpoint'i yoğun alanlarda kararsız
// ("Please reduce the amount of data" HTTP 500) → AKTİF YOL Mapillary'nin önerdiği
// VECTOR-TILE coverage: z14 coverage tile'larını indir + decode et (pbf +
// @mapbox/vector-tile), image ID'leri keşfet, her ID'yi tekil Graph ENTITY çağrısıyla
// (graph.mapillary.com/{id}?fields=…, bbox YOK) doğrula. Eski bbox-grid kodu
// "DEPRECATED FALLBACK" olarak duruyor ama aktif yolda KULLANILMIYOR.
//
// Bu script fetch-panoramax.mjs ile AYNI candidate şeklini üretir (source:
// "mapillary") ve AYNI candidates.json + raw/ + preview/'a MERGE eder. Böylece
// build-real-scenes.mjs HİÇBİR değişiklik olmadan Mapillary adaylarını da çözer
// (cand.source/author/viewerUrl zaten generic taşınıyor). Frontend de hazır:
// KorNoktaSceneSource "mapillary"'yi, badge sourceLabel'i "Mapillary"'yi biliyor.
//
// TOKEN GEREKLİ (gizli — commit ETME). mapillary.com → Developers → uygulama
// oluştur → "Client Token". Sonra:
//   MAPILLARY_TOKEN=MLY|xxxx node scripts/korNokta/fetch-mapillary.mjs [--per-region N] [--regions a,b]
// ÖNCE smoke test (vector-tile keşfi, İNDİRME/PREVIEW YOK) — tam fetch'ten önce
// çalıştır; geçmeden tam fetch'i KOŞMA:
//   MAPILLARY_TOKEN=MLY|xxxx node scripts/korNokta/fetch-mapillary.mjs --smoke --regions de-berlin
//   (varsayılan smoke: 1 bölge · 2 coverage tile · ≤1 image ID hydrate; --max-tiles N ayarlar)
// Token YALNIZ MAPILLARY_TOKEN environment variable'ından okunur — CLI arg,
// hardcode değer veya .env yazımı YOK (gizli sızması engellenir).
//
// Tekrar çalıştırılabilir: aynı image id tekrar indirilmez, candidates.json merge.
// Sonra: preview/'ı gözle incele, iyi id'leri build-real-scenes.mjs CURATION'a ekle.

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import sharp from "sharp";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, "raw");
const PREVIEW_DIR = path.join(HERE, "preview");
const CANDIDATES_PATH = path.join(HERE, "candidates.json");

// ── --preview · Faz B görsel küratörlük (TOKEN GEREKMEZ) ───────────────────
// preview-queue.json'daki 76 id için discovery'deki imzalı sourceUrl'den (oe=
// süreli) düşük-boy önizleme indirir. raw/webp/manifest/candidates ÜRETMEZ;
// build/runtime BUNLARI okumaz. Klasör .gitignore'da (preview-mapillary/).
const PREVIEW_QUEUE_PATH = path.join(HERE, "preview-queue.json");
const PREVIEW_MAPILLARY_DIR = path.join(HERE, "preview-mapillary");

// ── --fetch-accepted · Faz C TOKEN'SİZ tam-çözünürlük indirme ──────────────
// accept-list-mapillary.json'daki KABUL edilen 53 sahnenin imzalı sourceUrl'inden
// (oe= süreli) ORİJİNAL tam-çözünürlük equirectangular'ı raw/<id>.jpg'ye indirir
// (resize YOK — build-real-scenes.mjs 4096×2048'e indirger). Idempotent. Graph/
// token GEREKMEZ. Yedekler (backups) indirilmez (bu turda build edilmez).
const ACCEPT_LIST_PATH = path.join(HERE, "accept-list-mapillary.json");

// ── --discover · METADATA-ONLY aday keşfi çıktısı ──────────────────────────
// candidates.json'dan KASITLI olarak AYRI dosya: build-real-scenes.mjs bunu HİÇ
// okumaz, asset üretilmez, runtime bunu kullanmaz. Yalnız tek seferlik görsel
// küratörlük için ülke/şehir/çeşitlilik kısa listesi. .gitignore: discovery-*.json.
const DISCOVER_OUT = path.join(HERE, "discovery-mapillary.json");
const DISCOVER_MAX_TILES = 2;    // bölge başına en fazla coverage tile FETCH'i
const DISCOVER_MAX_HYDRATE = 12; // bölge başına en fazla Graph entity hydrate'i
const DISCOVER_MAX_CANDS = 6;    // bölge başına en fazla doğrulanmış aday

const GRAPH = "https://graph.mapillary.com";
const UA = "torble-kornokta-poc/1.0 (open-license 360 research; contact: github)";

// Mapillary görüntü lisansı CC-BY-SA 4.0 (build-real-scenes.mjs whitelist anahtarı).
const MLY_LICENSE = "CC-BY-SA-4.0";

// Mapillary'nin DEĞERİ küresel çeşitliliktir → Panoramax'ın boş bıraktığı
// bölgelere ağırlık ver. Güçlü olanlar (FR/NL/BE/TR) de variety için kalsın;
// MIN_DIST + id dedup zaten örtüşmeyi eler. bbox = [minLng, minLat, maxLng, maxLat].
const REGIONS = [
  // ── Türkiye (İstanbul/İzmir/Bursa dışı şehir karakteri ara) ─────────────
  { key: "tr-ankara",    bbox: [32.70, 39.85, 33.00, 39.98], hint: "Türkiye / Ankara" },
  { key: "tr-antalya",   bbox: [30.55, 36.83, 30.80, 36.98], hint: "Türkiye / Antalya" },
  { key: "tr-izmir",     bbox: [27.05, 38.38, 27.25, 38.48], hint: "Türkiye / İzmir" },
  { key: "tr-trabzon",   bbox: [39.60, 40.93, 39.90, 41.05], hint: "Türkiye / Karadeniz" },
  { key: "tr-gaziantep", bbox: [37.30, 37.03, 37.45, 37.13], hint: "Türkiye / Gaziantep" },
  // ── Almanya (Panoramax'ta 0) ────────────────────────────────────────────
  { key: "de-berlin",   bbox: [13.32, 52.46, 13.52, 52.55], hint: "Almanya / Berlin" },
  { key: "de-munich",   bbox: [11.45, 48.10, 11.66, 48.18], hint: "Almanya / Münih" },
  { key: "de-hamburg",  bbox: [9.92, 53.52, 10.08, 53.60],  hint: "Almanya / Hamburg" },
  { key: "de-cologne",  bbox: [6.90, 50.91, 7.02, 50.97],   hint: "Almanya / Köln" },
  // ── İtalya / İspanya / Portekiz ─────────────────────────────────────────
  { key: "it-rome",     bbox: [12.44, 41.86, 12.56, 41.93], hint: "İtalya / Roma" },
  { key: "it-milan",    bbox: [9.13, 45.43, 9.24, 45.50],   hint: "İtalya / Milano" },
  { key: "it-naples",   bbox: [14.22, 40.81, 14.31, 40.87], hint: "İtalya / Napoli" },
  { key: "es-bcn",      bbox: [2.10, 41.36, 2.22, 41.43],   hint: "İspanya / Barselona" },
  { key: "es-madrid",   bbox: [-3.74, 40.39, -3.65, 40.46], hint: "İspanya / Madrid" },
  { key: "es-valencia", bbox: [-0.41, 39.45, -0.34, 39.49], hint: "İspanya / Valensiya" },
  { key: "pt-lisbon",   bbox: [-9.17, 38.69, -9.10, 38.74], hint: "Portekiz / Lizbon" },
  { key: "pt-porto",    bbox: [-8.64, 41.14, -8.58, 41.17], hint: "Portekiz / Porto" },
  // ── Orta Avrupa / İsviçre / Avusturya ───────────────────────────────────
  { key: "at-vienna",   bbox: [16.33, 48.18, 16.43, 48.24], hint: "Avusturya / Viyana" },
  { key: "ch-zurich",   bbox: [8.50, 47.35, 8.59, 47.41],   hint: "İsviçre / Zürih" },
  { key: "cz-prague",   bbox: [14.39, 50.06, 14.47, 50.11], hint: "Çekya / Prag" },
  { key: "pl-warsaw",   bbox: [20.97, 52.21, 21.06, 52.27], hint: "Polonya / Varşova" },
  // ── İskandinavya ────────────────────────────────────────────────────────
  { key: "no-oslo",     bbox: [10.68, 59.89, 10.80, 59.94], hint: "Norveç / Oslo" },
  { key: "se-stockholm",bbox: [18.02, 59.30, 18.12, 59.36], hint: "İsveç / Stockholm" },
  { key: "dk-copenhagen",bbox: [12.53, 55.65, 12.63, 55.71], hint: "Danimarka / Kopenhag" },
  { key: "fi-helsinki", bbox: [24.90, 60.15, 25.00, 60.20], hint: "Finlandiya / Helsinki" },
  // ── Balkanlar ───────────────────────────────────────────────────────────
  { key: "gr-athens",   bbox: [23.69, 37.95, 23.79, 38.02], hint: "Yunanistan / Atina" },
  { key: "hr-zagreb",   bbox: [15.94, 45.78, 16.03, 45.84], hint: "Hırvatistan / Zagreb" },
  { key: "rs-belgrade", bbox: [20.43, 44.78, 20.51, 44.84], hint: "Sırbistan / Belgrad" },
  // ── Birleşik Krallık ────────────────────────────────────────────────────
  { key: "gb-london",   bbox: [-0.16, 51.49, -0.05, 51.54], hint: "Birleşik Krallık / Londra" },
  { key: "gb-manchester",bbox: [-2.27, 53.46, -2.20, 53.50], hint: "Birleşik Krallık / Manchester" },
  { key: "gb-edinburgh",bbox: [-3.22, 55.93, -3.16, 55.97], hint: "Birleşik Krallık / Edinburgh" },
  // ── ABD (Seattle dışı iklim/doku) ───────────────────────────────────────
  { key: "us-nyc",      bbox: [-74.02, 40.70, -73.93, 40.81], hint: "ABD / New York" },
  { key: "us-sf",       bbox: [-122.47, 37.73, -122.39, 37.81], hint: "ABD / San Francisco" },
  { key: "us-la",       bbox: [-118.31, 34.01, -118.21, 34.09], hint: "ABD / Los Angeles" },
  { key: "us-chicago",  bbox: [-87.69, 41.86, -87.61, 41.93], hint: "ABD / Chicago" },
  { key: "us-miami",    bbox: [-80.22, 25.75, -80.16, 25.80], hint: "ABD / Miami" },
  // ── Doğu Asya ───────────────────────────────────────────────────────────
  { key: "jp-tokyo",    bbox: [139.68, 35.64, 139.79, 35.72], hint: "Japonya / Tokyo" },
  { key: "jp-osaka",    bbox: [135.47, 34.65, 135.55, 34.72], hint: "Japonya / Osaka" },
  { key: "kr-seoul",    bbox: [126.96, 37.54, 127.05, 37.59], hint: "Güney Kore / Seul" },
  { key: "tw-taipei",   bbox: [121.50, 25.02, 121.58, 25.07], hint: "Tayvan / Taipei" },
  // ── Güneydoğu / Güney Asya ──────────────────────────────────────────────
  { key: "th-bangkok",  bbox: [100.48, 13.72, 100.56, 13.78], hint: "Tayland / Bangkok" },
  { key: "vn-hanoi",    bbox: [105.82, 21.01, 105.87, 21.05], hint: "Vietnam / Hanoi" },
  { key: "id-jakarta",  bbox: [106.78, -6.23, 106.86, -6.15], hint: "Endonezya / Jakarta" },
  { key: "my-kl",       bbox: [101.67, 3.12, 101.73, 3.17],   hint: "Malezya / Kuala Lumpur" },
  { key: "in-delhi",    bbox: [77.19, 28.58, 77.26, 28.65],   hint: "Hindistan / Yeni Delhi" },
  { key: "in-bangalore",bbox: [77.55, 12.94, 77.63, 13.01],   hint: "Hindistan / Bengaluru" },
  // ── Orta Doğu ───────────────────────────────────────────────────────────
  { key: "il-telaviv",  bbox: [34.75, 32.05, 34.82, 32.11],   hint: "İsrail / Tel Aviv" },
  { key: "ae-dubai",    bbox: [55.25, 25.17, 55.33, 25.23],   hint: "BAE / Dubai" },
  // ── Afrika ──────────────────────────────────────────────────────────────
  { key: "za-capetown", bbox: [18.39, -33.95, 18.47, -33.89], hint: "Güney Afrika / Cape Town" },
  { key: "ke-nairobi",  bbox: [36.79, -1.31, 36.86, -1.25],   hint: "Kenya / Nairobi" },
  { key: "ma-casablanca",bbox: [-7.65, 33.56, -7.57, 33.62],  hint: "Fas / Casablanca" },
  // ── Okyanusya / Latin Amerika ───────────────────────────────────────────
  { key: "au-sydney",   bbox: [151.18, -33.89, 151.24, -33.84], hint: "Avustralya / Sydney" },
  { key: "au-melbourne",bbox: [144.94, -37.83, 145.00, -37.78], hint: "Avustralya / Melbourne" },
  { key: "br-saopaulo", bbox: [-46.66, -23.57, -46.62, -23.53], hint: "Brezilya / São Paulo" },
  { key: "mx-cdmx",     bbox: [-99.18, 19.41, -99.13, 19.45],   hint: "Meksika / Mexico City" },
  { key: "ar-buenosaires",bbox: [-58.42, -34.62, -58.37, -34.58], hint: "Arjantin / Buenos Aires" },
];

// ── AKTİF YOL · Mapillary VECTOR-TILE coverage keşfi ───────────────────────
// /images?bbox= spatial endpoint'i YOĞUN alanlarda kararsız ("Please reduce the
// amount of data" HTTP 500) → 0.0009°² hücre + limit=20 ile bile patlıyor.
// Çözüm (Mapillary'nin önerdiği): coverage VECTOR TILE'larını indir, image ID'leri
// tile'dan keşfet, her ID'yi tekil Graph ENTITY çağrısıyla doğrula (bbox YOK).
const TILE_HOST = "https://tiles.mapillary.com";
const TILESET = "mly1_public"; // image/sequence/overview katmanları (smoke ŞEMAYI DOĞRULAR)
const TILE_Z = 14;             // bireysel 'image' nokta katmanı zoom'u
const IMAGE_LAYER = "image";   // image-nokta katman adı (smoke'da doğrulanır; varsayılmaz)

// ── DEPRECATED FALLBACK · eski bbox-grid keşfi (KULLANILMIYOR) ──────────────
// Aşağıdaki bbox/grid sabitleri ve searchImagesInCell/gridCells/bboxArea/shuffle/
// isPano360 yalnız tarihsel referans içindir; smoke ve tam-fetch artık tile yolunu
// kullanır. /images?bbox= dense alanlarda 500 verdiği için aktif yolda ÇAĞRILMAZ.
const MAX_CELL_DEG2 = 0.001;  // (deprecated) bbox sorgu alanı üst sınırı
const CELL_DEG = 0.03;        // (deprecated) hücre kenarı
const PAGE_LIMIT = 100;       // (deprecated) bbox sayfa limiti
const MAX_PAGES_PER_CELL = 3; // (deprecated) bbox pagination üst sınırı
const MIN_WIDTH = 4096;     // kalite: HD genişlik alt sınırı (equirectangular)
const MIN_HEIGHT = 2048;    // kalite: HD yükseklik alt sınırı (4096×2048 eşiği)
const RATIO_TOL = 0.06;     // 2:1 toleransı
const LUM_MIN = 42;         // çok karanlık eleme
const LUM_MAX = 225;        // patlamış/aşırı parlak eleme
const MIN_DIST_M = 350;     // aynı bölgede çok yakın kareleri ele
const NOMINATIM_THROTTLE_MS = 1100;
const MAX_RETRIES = 4;      // rate-limit/geçici hata: toplam deneme (1 + 3 retry)
const RETRY_BASE_MS = 800;  // üstel backoff taban gecikmesi

// Rule 5: yalnız thumb_original_url (orijinal tam çözünürlük equirectangular)
// istenir — gerçek kaynak; thumbnail (thumb_256/1024/2048) WebP üretimine uygun
// değildir, hiç talep edilmez. Rule 1: is_pano alanı açıkça istenir; Mapillary
// bbox uç-noktası sunucu-taraflı is_pano filtresi sunmaz → alan istenir + sert
// client filtre (isPano360).
const FIELDS = "id,captured_at,geometry,compass_angle,creator,width,height,is_pano,thumb_original_url";

// ---- yardımcılar ----------------------------------------------------------

function haversineM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Mapillary captured_at = unix ms; mantıklı tarih döndür (yoksa null).
function plausibleDateMs(ms) {
  if (!ms && ms !== 0) return null;
  const d = new Date(Number(ms));
  const y = d.getUTCFullYear();
  const now = new Date().getUTCFullYear();
  if (!Number.isFinite(y) || y < 1990 || y > now + 1) return null;
  return d.toISOString().slice(0, 10);
}

// MVT 'properties.id' uint64 → JS Number'a decode edilirken MAX_SAFE_INTEGER
// (2^53-1) üstündeki değerler YUVARLANIR; bu yuvarlanmış sayı yanlış bir Graph
// image ID'sidir ve graph.mapillary.com onu 400 ile reddeder. Bu yüzden hydrate
// ÖNCESİ ID'nin KESİN doğru olduğunu garanti ederiz:
//  · string + yalnız rakam        → hassasiyet kaybı yok, string olarak korunur,
//  · number + Number.isSafeInteger → güvenli (string'e çevrilir),
//  · aksi halde null               → bu ID ile Graph çağrısı YAPILMAZ
//    (custom uint64 parser / yeni paket EKLENMEZ; yalnız güvenli adaylar geçer).
function safeGraphId(value) {
  if (typeof value === "string") return /^[0-9]+$/.test(value) ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token log/hata mesajlarında ASLA görünmez: hem access_token query param'ı hem
// de gerçek token değeri (hata gövdesinde yansırsa) maskelenir.
let TOKEN_FOR_MASK = null; // main() içinde set edilir
function maskSecret(s) {
  let out = String(s).replace(/access_token=[^&\s"']+/g, "access_token=***");
  if (TOKEN_FOR_MASK) out = out.split(TOKEN_FOR_MASK).join("***");
  return out;
}

// Rule 6: rate-limit (429) ve geçici sunucu/ağ hatalarında üstel backoff'lu retry.
// 4xx (429 hariç) kalıcı hata → hemen durur. HTTP hata GÖVDESİ (özellikle 500)
// TOKEN MASKELİ loglanır (maskSecret).
async function fetchWithRetry(url, { headers = {}, attempts = MAX_RETRIES } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let res = null;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    } catch (e) {
      lastErr = new Error(`ağ hatası: ${maskSecret(e.message)}`); // retriable
    }
    if (res) {
      if (res.ok) return res;
      let body = "";
      try { body = (await res.text()).slice(0, 400); } catch { /* gövde okunamadı */ }
      const masked = maskSecret(`HTTP ${res.status}${body ? ` gövde: ${body}` : ""} — ${url}`);
      // 4xx (429 hariç) kalıcı → retry'siz dur. catch dışında throw: retriable'a düşmez.
      if (!(res.status === 429 || res.status >= 500)) throw new Error(`${masked} (kalıcı hata)`);
      lastErr = new Error(masked); // 429 / 5xx → retriable
    }
    if (i < attempts - 1) {
      const backoff = RETRY_BASE_MS * 2 ** i + Math.floor(Math.random() * 250);
      console.warn(`  … yeniden deneme ${i + 1}/${attempts - 1} (${backoff}ms): ${lastErr.message}`);
      await sleep(backoff);
    }
  }
  throw new Error(`${attempts} denemede başarısız: ${maskSecret(String(lastErr?.message ?? "bilinmeyen hata"))}`);
}

async function getJson(url, headers = {}) {
  const res = await fetchWithRetry(url, { headers: { Accept: "application/json", ...headers } });
  return res.json();
}

async function fetchBufferWithRetry(url, headers = {}) {
  const res = await fetchWithRetry(url, { headers });
  return Buffer.from(await res.arrayBuffer());
}

// ── AKTİF YOL · vector-tile keşfi yardımcıları ─────────────────────────────

// Slippy-map tile koordinatları (bağımlılıksız).
function lng2tileX(lng, z) { return Math.floor(((lng + 180) / 360) * 2 ** z); }
function lat2tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}
function tilesForBbox(bbox, z) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const xs = [lng2tileX(minLng, z), lng2tileX(maxLng, z)].sort((a, b) => a - b);
  const ys = [lat2tileY(maxLat, z), lat2tileY(minLat, z)].sort((a, b) => a - b); // lat ekseni ters
  const tiles = [];
  for (let x = xs[0]; x <= xs[1]; x++) for (let y = ys[0]; y <= ys[1]; y++) tiles.push({ z, x, y });
  return tiles;
}

// Coverage tile'ını (PBF) indir; gzip'liyse aç. Token query param (maskeli loglanır).
async function fetchTile(z, x, y, token) {
  const url = `${TILE_HOST}/maps/vtp/${TILESET}/2/${z}/${x}/${y}?access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithRetry(url, {});
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // gzip magic
  return buf;
}

// ── Vector-tile decode · YALNIZ pbf + @mapbox/vector-tile ───────────────────
// Custom MVT/protobuf/varint çözücü KALDIRILDI. `new Pbf(buf)` reader, VectorTile
// tüm layer/feature/property çözümünü yapar. tile.layers = { adı: VectorTileLayer }
// (her birinde .length + .feature(i) → { id, properties, ... }).
function decodeTile(buf) {
  return new VectorTile(new Pbf(buf));
}

// Tek tile'dan GRAPH image id'leri çıkar (full-fetch yolu kullanır). KRİTİK: MVT
// üst-düzey feature.id, Mapillary GRAPH image id DEĞİLDİR (tile-yerel kodlu sayı;
// graph.mapillary.com/{id} onu tanımaz) → id YALNIZ property'den okunur. Ayrıca
// MVT uint64'ler JS Number'a çevrilirken MAX_SAFE_INTEGER üstünde YUVARLANIR →
// safeGraphId() ile güvensiz/yuvarlanmış değerler ELENİR (yanlış Graph 400 önlenir).
// Dönüş: { ids:[{id,isPanoHint}], unsafeSkipped } — güvensiz uint64 sayacı raporlanır.
function imageIdsFromTile(buf) {
  const tile = decodeTile(buf);
  const layer = tile.layers[IMAGE_LAYER];
  if (!layer) return { ids: [], unsafeSkipped: 0 };
  const out = [], seen = new Set();
  let unsafeSkipped = 0;
  for (let i = 0; i < layer.length; i++) {
    const props = layer.feature(i).properties || {};
    const id = safeGraphId(props.id); // feature.id DEĞİL; güvensiz/yuvarlanmış uint64 → null
    if (!id) { if (props.id != null) unsafeSkipped++; continue; } // değer var ama güvensiz → say + atla
    if (seen.has(id)) continue;
    seen.add(id);
    const isPanoHint = "is_pano" in props ? Boolean(props.is_pano) : undefined;
    out.push({ id, isPanoHint });
  }
  return { ids: out, unsafeSkipped };
}

// Tekil Graph ENTITY çağrısı (bbox YOK → 500 sorunu yok). Authoritative metadata.
const ENTITY_FIELDS = "id,is_pano,width,height,captured_at,compass_angle,geometry,creator,sequence,thumb_original_url";
async function hydrateImage(id, token) {
  const url = `${GRAPH}/${id}?access_token=${encodeURIComponent(token)}&fields=${ENTITY_FIELDS}`;
  return getJson(url); // entity döner (data sarmalı YOK)
}

// Entity metadata doğrulaması: is_pano + ≥4096×2048 + ~2:1 + orijinal kaynak.
function validateEntity(m) {
  if (!m || m.is_pano !== true) return false;
  const w = m.width, h = m.height;
  if (!w || !h || w < MIN_WIDTH || h < MIN_HEIGHT) return false;
  if (Math.abs(w / h - 2) > RATIO_TOL) return false;
  if (!m.thumb_original_url) return false;
  return true;
}

// Doğrulanmış entity'den aday üretir: orijinali indir → İNDİRİLEN görseli yeniden
// doğrula (Rule 2) → raw+preview yaz → reverse-geocode → candidate push. Durum döner.
// ctx = { candidates, knownIds, regionPoints }. Disk yazar (yalnız tam-fetch çağırır).
async function processImageId(id, meta, region, ctx) {
  const { candidates, knownIds, regionPoints } = ctx;
  const [lng, lat] = meta.geometry?.coordinates || [];
  if (lat == null || lng == null) return "no-geo";
  if (regionPoints.some((p) => haversineM(p, { lat, lng }) < MIN_DIST_M)) return "too-close";

  const hd = meta.thumb_original_url; // validateEntity garanti etti (Rule 5: orijinal kaynak)
  let buf;
  try { buf = await fetchBufferWithRetry(hd, { "User-Agent": UA }); }
  catch (e) { console.warn(`  ! indirme atlandı ${id}: ${e.message}`); return "dl-fail"; }

  // Rule 2: İNDİRİLEN görseli ayrıca doğrula (entity boyutuna güvenme).
  let dims;
  try { dims = await sharp(buf).metadata(); }
  catch { console.log(`  - eleme ${id} (görsel çözülemedi)`); return "decode-fail"; }
  const dw = dims.width || 0, dh = dims.height || 0;
  if (dw < MIN_WIDTH || dh < MIN_HEIGHT || Math.abs(dw / dh - 2) > RATIO_TOL) {
    console.log(`  - eleme ${id} (indirilen ${dw}×${dh} — equirectangular 2:1 değil)`);
    return "bad-dims";
  }
  let lum;
  try { lum = await meanLuminance(buf); } catch { return "lum-fail"; }
  if (lum < LUM_MIN || lum > LUM_MAX) { console.log(`  - eleme ${id} (parlaklık ${lum.toFixed(0)})`); return "bad-lum"; }

  const rawPath = path.join(RAW_DIR, `${id}.jpg`);
  await fs.writeFile(rawPath, buf);
  const previewPath = path.join(PREVIEW_DIR, `${id}.jpg`);
  await sharp(buf).resize(1024, 512, { fit: "fill" }).jpeg({ quality: 80 }).toFile(previewPath);

  const geo = await reverseGeocode(lat, lng);
  regionPoints.push({ lat, lng });
  const cand = {
    sourceImageId: id,
    source: "mapillary",
    region: region.key,
    regionHint: region.hint,
    tier: 6,
    collection: meta.sequence || null,
    lat, lng,
    hdWidth: dw, hdHeight: dh,
    fileSizeMB: +(buf.length / 1048576).toFixed(2),
    luminance: +lum.toFixed(0),
    license: MLY_LICENSE,
    author: meta.creator?.username || "Mapillary katkıcısı",
    captureDate: plausibleDateMs(meta.captured_at),
    imageUrl: hd,
    viewerUrl: `https://www.mapillary.com/app/?pKey=${id}`,
    country: geo.country,
    countryCode: geo.countryCode,
    countryKey: (geo.countryCode || "").toLowerCase() || null,
    geoRegion: geo.region,
    city: geo.city,
    rawPath: path.relative(path.join(HERE, "..", ".."), rawPath),
    previewPath: path.relative(path.join(HERE, "..", ".."), previewPath),
  };
  candidates.push(cand);
  knownIds.add(id);
  console.log(`  + ${id}  ${dw}×${dh}  ${cand.fileSizeMB}MB  lum=${cand.luminance}  | ${[geo.country, geo.region, geo.city].filter(Boolean).join(" / ")}`);
  return "added";
}

// ── DEPRECATED FALLBACK (kullanılmıyor) · eski bbox-grid yardımcıları ───────
// bbox = [minLng, minLat, maxLng, maxLat]; alan = derece² (Δlng × Δlat).
function bboxArea(b) {
  return Math.abs((b[2] - b[0]) * (b[3] - b[1]));
}

// Bir bölge bbox'ını ≤ MAX_CELL_DEG2 alanlı küçük hücrelere böler. Kenar
// hücreleri max'a kırpılır (yalnız küçülür → alan eşiği ASLA aşılmaz).
function gridCells(bbox, cellDeg) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const cells = [];
  for (let lat = minLat; lat < maxLat - 1e-9; lat += cellDeg) {
    const lat2 = Math.min(lat + cellDeg, maxLat);
    for (let lng = minLng; lng < maxLng - 1e-9; lng += cellDeg) {
      const lng2 = Math.min(lng + cellDeg, maxLng);
      cells.push([+lng.toFixed(6), +lat.toFixed(6), +lng2.toFixed(6), +lat2.toFixed(6)]);
    }
  }
  return cells;
}

// Fisher–Yates: hücreleri köşeden değil dağıtarak tara (mekânsal çeşitlilik).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Tek mikro-hücreyi (≤0.001°²) sayfalayarak tarar; paging.next ile en fazla
// MAX_PAGES_PER_CELL sayfa izler. Hata (500 dahil) çağırana fırlatılır →
// orada bbox alanıyla + token maskeli loglanır.
async function searchImagesInCell(token, cell, { pageLimit = PAGE_LIMIT, maxPages = MAX_PAGES_PER_CELL } = {}) {
  const out = [];
  let url = `${GRAPH}/images?access_token=${encodeURIComponent(token)}` +
    `&fields=${FIELDS}&bbox=${cell.join(",")}&limit=${pageLimit}`;
  for (let page = 0; page < maxPages && url; page++) {
    const j = await getJson(url);
    for (const img of (j.data || [])) out.push(img);
    url = j.paging?.next || null; // sayfa kalmadıysa zincir durur
  }
  return out;
}

async function meanLuminance(buf) {
  const { data, info } = await sharp(buf)
    .resize(64, 32, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  const px = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / px;
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
  } catch {
    const out = { country: null, countryCode: null, region: null, city: null };
    geoCache.set(key, out);
    return out;
  }
}

// (DEPRECATED · bbox /images sonuçları için; aktif tile yolu validateEntity kullanır)
function isPano360(img) {
  if (img.is_pano !== true) return false;
  const w = img.width, h = img.height;
  if (!w || !h) return false;
  if (w < MIN_WIDTH) return false;
  if (Math.abs(w / h - 2) > RATIO_TOL) return false;
  return true;
}

// ---- smoke test (TEK TILE · pbf + @mapbox/vector-tile) --------------------
// YALNIZ tek tile'ı indirir + decode eder, sonra YALNIZ 'image' layer'ını tarar
// (sequence layer aday keşfi için kullanılmaz). Tile yapısı önceki smoke ile
// kesinleşti: gerçek Graph image ID = feature.properties.id (feature.id DEĞİL),
// pano filtresi = properties.is_pano === true. Bu smoke pano YOĞUNLUĞUNU ölçer:
//  · image layer toplam feature sayısı,
//  · is_pano === true sayısı,
//  · ilk 5 pano adayı (properties.id / captured_at / creator_id / sequence_id),
//  · pano yoksa açık "bu tile'da pano yok" mesajı,
//  · İLK pano adayında YALNIZ 1 Graph entity hydrate (tile→graph zincir doğrulaması,
//    full-fetch'le AYNI hydrateImage() fonksiyonu kullanılır).
// İndirme / preview / candidates.json YAPILMAZ (hydrate yalnız metadata GET'idir,
// görsel indirilmez). Token loglanmaz.
async function smokeTest(token, regions) {
  console.log(`SMOKE — tek tile · 'image' layer pano taraması + İLK adayda 1 Graph hydrate (indirme/preview/candidates YOK)`);
  console.log(`--regions filtresi sonrası ${regions.length} bölge eşleşti; smoke yalnız İLK bölgenin İLK tile'ını okur.`);
  const region = regions[0];
  if (!region) { console.error("✗ smoke: bölge yok (--regions eşleşmedi)."); process.exit(1); }
  const tile0 = tilesForBbox(region.bbox, TILE_Z)[0];
  if (!tile0) { console.error("✗ smoke: bölge bbox'ından tile üretilemedi."); process.exit(1); }
  const key = `${tile0.z}/${tile0.x}/${tile0.y}`;
  console.log(`bölge: ${region.key} (${region.hint}) · tileset=${TILESET} · tek tile=${key}\n`);

  let buf;
  try { buf = await fetchTile(tile0.z, tile0.x, tile0.y, token); }
  catch (e) { console.error(`✗ tile indirme hatası [${key}]: ${e.message}`); process.exit(2); }

  let tile;
  try { tile = decodeTile(buf); }
  catch (e) { console.error(`✗ vector-tile decode hatası [${key}] (${buf.length} bayt): ${e.message}`); process.exit(2); }

  console.log(`${buf.length} bayt · layer'lar: ${Object.keys(tile.layers).join(", ") || "(yok)"}\n`);

  const layer = tile.layers[IMAGE_LAYER];
  if (!layer) { console.error(`✗ smoke: '${IMAGE_LAYER}' layer yok — tileset/zoom yanlış olabilir.`); process.exit(2); }

  // YALNIZ image layer'ı tara: toplam feature + is_pano === true sayısı,
  // ilk 5 panonun istenen alanları (properties.id / captured_at / creator_id / sequence_id).
  // KRİTİK: MVT uint64 'properties.id' JS Number'a çevrilirken MAX_SAFE_INTEGER
  // üstünde YUVARLANIR → yanlış/yuvarlanmış Graph ID Graph'ta 400 verir. Bu yüzden
  // YALNIZ safeGraphId() doğrulamasından geçen İLK aday hydrate edilir.
  const total = layer.length;
  let panoCount = 0, safeCount = 0, unsafeCount = 0;
  const firstPanos = [];   // gösterim: ilk 5 pano (güvenli/güvensiz işaretli)
  let subject = null;      // hydrate edilecek İLK güvenli-Graph-ID pano adayı
  for (let i = 0; i < total; i++) {
    const p = layer.feature(i).properties || {};
    if (p.is_pano !== true) continue; // sıkı eşitlik — yalnız gerçek pano
    panoCount++;
    const safeId = safeGraphId(p.id); // güvensiz/yuvarlanmış uint64 → null
    if (safeId) safeCount++; else unsafeCount++;
    if (firstPanos.length < 5) {
      firstPanos.push({
        rawId: p.id ?? null,   // ham property değeri (gösterim/uyarı için)
        safeId,                // güvenliyse string Graph ID, değilse null
        captured_at: p.captured_at ?? null,
        creator_id: p.creator_id ?? null,
        sequence_id: p.sequence_id ?? null,
      });
    }
    if (!subject && safeId) {   // körlemesine ilk pano DEĞİL → ilk GÜVENLİ aday
      subject = {
        id: safeId,
        captured_at: p.captured_at ?? null,
        creator_id: p.creator_id ?? null,
        sequence_id: p.sequence_id ?? null,
      };
    }
  }

  console.log(`image layer toplam feature : ${total}`);
  console.log(`is_pano === true sayısı     : ${panoCount}`);
  console.log(`güvenli Graph ID'li pano    : ${safeCount}`);
  console.log(`güvensiz/atlanan pano       : ${unsafeCount}`);

  if (panoCount === 0) {
    console.log(`\n✗ bu tile'da pano yok (image layer'da is_pano === true feature bulunamadı).`);
    console.log(`\nGraph hydrate denenmedi (aday yok) · indirme / preview / candidates.json YAPILMADI.`);
    return;
  }

  console.log(`\nilk ${firstPanos.length} pano adayı (id güvenliği işaretli):`);
  for (const c of firstPanos) {
    const iso = plausibleDateMs(c.captured_at);
    const flag = c.safeId ? "GÜVENLİ" : "GÜVENSİZ→atlanır";
    console.log(
      `  • id=${c.rawId} [${flag}] · captured_at=${c.captured_at}${iso ? ` (${iso})` : ""}` +
      ` · creator_id=${c.creator_id} · sequence_id=${c.sequence_id}`,
    );
  }

  // ── TEK Graph hydrate doğrulaması (İLK GÜVENLİ-ID pano adayı) ──────────────
  // Körlemesine ilk panoyu DEĞİL, safeGraphId()'ten geçen İLK adayı hydrate eder
  // (örn. Berlin'de unsafe 10030523663701088 atlanır, safe 3804604239831424 seçilir).
  // Amaç: tile-candidate → Graph-entity zincirinin çalıştığını YALNIZ 1 istekle,
  // full-fetch'le AYNI hydrateImage() yoluyla doğrulamak. Görsel İNDİRİLMEZ.
  if (!subject) {
    console.log(`\n✗ güvenli Graph ID taşıyan pano yok (hepsi MAX_SAFE_INTEGER üstü/uygunsuz) — hydrate atlandı.`);
    console.log(`\nGraph hydrate YAPILMADI · indirme / preview / candidates.json YAPILMADI.`);
    return;
  }
  console.log(`\n── Graph hydrate (YALNIZ 1 istek · ilk GÜVENLİ ID) ──`);
  console.log(`hydrate edilen aday: id=${subject.id}`);
  console.log(
    `tile adayı : id=${subject.id} · captured_at=${subject.captured_at}` +
    ` · creator_id=${subject.creator_id} · sequence_id=${subject.sequence_id}`,
  );

  let entity;
  try { entity = await hydrateImage(subject.id, token); }
  catch (e) { console.error(`✗ hydrate hatası [${subject.id}]: ${e.message}`); process.exit(2); }

  const w = entity?.width, h = entity?.height;
  const coords = entity?.geometry?.coordinates;
  const eiso = plausibleDateMs(entity?.captured_at);
  console.log(
    `graph sonucu: id=${entity?.id ?? "(yok)"}` +
    ` · is_pano=${entity?.is_pano}` +
    ` · ${w ?? "?"}×${h ?? "?"}` +
    ` · thumb_original_url=${entity?.thumb_original_url ? "VAR" : "YOK"}` +
    ` · creator=${entity?.creator?.username ?? entity?.creator?.id ?? "(yok)"}` +
    ` · geometry=${coords ? `[${coords[0]}, ${coords[1]}]` : "(yok)"}` +
    ` · captured_at=${entity?.captured_at ?? "(yok)"}${eiso ? ` (${eiso})` : ""}`,
  );

  console.log(`\n1 Graph hydrate yapıldı · indirme / preview / candidates.json YAPILMADI.`);
}

// ---- discover modu (METADATA-ONLY aday hasadı) ----------------------------
// Görsel KÜRATÖRLÜK için kısa liste üretir; HİÇBİR asset üretmez. Kurallar:
//  · YALNIZ 'image' layer; aday kimliği YALNIZ properties.id (feature.id DEĞİL),
//  · is_pano === true + güvenli Graph ID (safeGraphId) şartı (smoke/full ile aynı),
//  · bölge başına ≤2 tile FETCH · ≤12 Graph hydrate · ≤6 doğrulanmış aday,
//  · aynı image ID / aynı sequence ID / çok yakın koordinat (MIN_DIST_M) ELENİR,
//  · istekler SIRALI; mevcut fetchWithRetry retry/backoff korunur,
//  · "doğrulanmış" = validateEntity (is_pano + ≥4096×2048 + ~2:1 + thumb_original_url)
//    — TAMAMEN metadata; GÖRSEL İNDİRİLMEZ (sharp/raw/preview/webp YOK),
//  · çıktı: gitignored discovery-mapillary.json (candidates.json'a DOKUNULMAZ,
//    manifest/korNoktaRealScenes.ts ÜRETİLMEZ). build-real-scenes.mjs bunu okumaz.
async function discoverMode(token, regions) {
  console.log(`DISCOVER — metadata-only aday hasadı (GÖRSEL/PREVIEW/WEBP/RAW/manifest/candidates YOK)`);
  console.log(`${regions.length} bölge · bölge başına ≤${DISCOVER_MAX_TILES} tile · ≤${DISCOVER_MAX_HYDRATE} hydrate · ≤${DISCOVER_MAX_CANDS} aday`);
  console.log(`çıktı (gitignored): ${path.relative(process.cwd(), DISCOVER_OUT)}\n`);

  const out = [];
  const seenIds = new Set();        // global image ID dedup (rule 5)
  const seenSequences = new Set();  // global sequence ID dedup (rule 5)
  const visitedTiles = new Set();   // örtüşen bölgelerde aynı coverage tile'ı tekrar fetch etme
  const regionsScanned = [];
  let totalHydrate = 0, totalUnsafe = 0;

  for (const region of regions) {
    const tiles = tilesForBbox(region.bbox, TILE_Z);
    const regionPoints = [];        // bölge-içi koordinat yakınlığı (rule 5)
    let triedTiles = 0, hydrated = 0, taken = 0, discovered = 0, unsafe = 0;

    for (const t of tiles) {
      if (triedTiles >= DISCOVER_MAX_TILES) break;   // ≤2 tile FETCH / bölge
      if (hydrated >= DISCOVER_MAX_HYDRATE) break;   // ≤12 hydrate / bölge
      if (taken >= DISCOVER_MAX_CANDS) break;        // ≤6 aday / bölge

      const tileKey = `${t.z}/${t.x}/${t.y}`;
      if (visitedTiles.has(tileKey)) continue;       // tekrar fetch yok (triedTiles artmaz)
      visitedTiles.add(tileKey);
      triedTiles++;

      let ids;
      try {
        const buf = await fetchTile(t.z, t.x, t.y, token);
        // imageIdsFromTile: YALNIZ 'image' layer · properties.id · safeGraphId
        // (güvensiz/yuvarlanmış uint64 atlanır + sayılır; feature.id KULLANILMAZ).
        const res = imageIdsFromTile(buf);
        ids = res.ids;
        unsafe += res.unsafeSkipped;
        totalUnsafe += res.unsafeSkipped;
      } catch (e) {
        console.warn(`  ! tile [${tileKey}] hatası: ${e.message}`);
        continue;
      }
      discovered += ids.length;

      for (const { id, isPanoHint } of ids) {
        if (hydrated >= DISCOVER_MAX_HYDRATE) break;
        if (taken >= DISCOVER_MAX_CANDS) break;
        if (seenIds.has(id)) continue;               // aynı image ID (rule 5)
        seenIds.add(id);
        if (isPanoHint === false) continue;          // tile ipucu KESİN false → hydrate harcama

        // Tekil Graph ENTITY hydrate (bbox YOK → 500 yok). Otoriter metadata; GÖRSEL İNDİRİLMEZ.
        let meta;
        try { meta = await hydrateImage(id, token); }
        catch (e) { console.warn(`  ! hydrate ${id}: ${e.message}`); continue; }
        hydrated++; totalHydrate++;

        if (!validateEntity(meta)) continue;         // is_pano + ≥4096×2048 + ~2:1 + thumb_original_url

        const seqId = meta.sequence || null;
        if (seqId && seenSequences.has(seqId)) continue; // aynı sequence ID (rule 5)

        const [lng, lat] = meta.geometry?.coordinates || [];
        if (lat == null || lng == null) continue;
        if (regionPoints.some((p) => haversineM(p, { lat, lng }) < MIN_DIST_M)) continue; // çok yakın (rule 5)

        const geo = await reverseGeocode(lat, lng);  // throttled Nominatim — yalnız ülke/şehir metadata
        const contributor = meta.creator?.username || "Mapillary katkıcısı";
        regionPoints.push({ lat, lng });
        if (seqId) seenSequences.add(seqId);

        out.push({
          imageId: id,
          source: "mapillary",
          sourceType: "real_world",
          region: region.key,
          regionHint: region.hint,
          viewerUrl: `https://www.mapillary.com/app/?pKey=${id}`,
          sourceUrl: meta.thumb_original_url || null, // kaynak asset URL'i (METADATA — indirilmez)
          contributor,
          captureDate: plausibleDateMs(meta.captured_at),
          lat, lng,
          country: geo.country,
          countryCode: geo.countryCode,
          countryKey: (geo.countryCode || "").toLowerCase() || null,
          geoRegion: geo.region,
          city: geo.city,
          width: meta.width,
          height: meta.height,
          sequenceId: seqId,
          license: MLY_LICENSE,
          attribution: `© ${contributor} / Mapillary — ${MLY_LICENSE}`,
        });
        taken++;
        const place = [geo.country, geo.region, geo.city].filter(Boolean).join(" / ") || "(geo yok)";
        console.log(`  + ${id}  ${meta.width}×${meta.height}  | ${place}`);
      }
    }
    regionsScanned.push({ region: region.key, hint: region.hint, tiles: triedTiles, discovered, hydrated, taken, unsafe });
    console.log(`▸ ${region.key} (${region.hint}) — ${triedTiles} tile, ${discovered} ID, ${hydrated} hydrate, ${taken} aday`);
  }

  out.sort((a, b) => (a.region + a.imageId).localeCompare(b.region + b.imageId));
  await fs.writeFile(
    DISCOVER_OUT,
    JSON.stringify({ mode: "discover", generatedAt: new Date().toISOString(), count: out.length, regionsScanned, candidates: out }, null, 2),
  );

  // ── küratörlük için ülke/şehir/çeşitlilik özeti ──────────────────────────
  const byCountry = new Map();
  for (const c of out) {
    const k = c.country || c.countryCode || "(bilinmiyor)";
    byCountry.set(k, (byCountry.get(k) || 0) + 1);
  }
  console.log(`\n────────────────────────────────────────`);
  console.log(`toplam aday: ${out.length}   hydrate: ${totalHydrate}   güvensiz-ID atlandı: ${totalUnsafe}`);
  console.log(`ülke dağılımı (${byCountry.size} ülke):`);
  for (const [k, n] of [...byCountry.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  console.log(`\nçıktı (gitignored · metadata-only): ${path.relative(process.cwd(), DISCOVER_OUT)}`);
  console.log(`GÖRSEL/PREVIEW/WEBP/RAW/manifest/candidates.json ÜRETİLMEDİ.`);
  console.log(`\nSonraki adım: discovery-mapillary.json'u incele; iyi adayları görsel küratörlüğe seç.`);
}

// ---- ana akış -------------------------------------------------------------

// ── --preview modu · TOKEN'SİZ düşük-boy önizleme indirme ──────────────────
// preview-queue.json'daki id'leri okur; her biri için imzalı sourceUrl'i indirir,
// 1024×512 JPEG'e küçültüp preview-mapillary/<id>.jpg yazar. Idempotent (mevcut
// dosyayı atlar). Graph/token YOK — yalnız discovery'de yakalanmış imzalı URL'ler.
async function previewMode() {
  if (!existsSync(PREVIEW_QUEUE_PATH)) {
    console.error(`✗ preview-queue.json yok: ${PREVIEW_QUEUE_PATH}`);
    console.error("  Önce Faz B küratörlük kuyruğu üretilmeli (preview-queue.json).");
    process.exit(1);
  }
  const queue = JSON.parse(await fs.readFile(PREVIEW_QUEUE_PATH, "utf8"));
  const entries = Object.values(queue.regions || {}).flat();
  if (!entries.length) { console.error("✗ preview-queue.json boş."); process.exit(1); }
  await fs.mkdir(PREVIEW_MAPILLARY_DIR, { recursive: true });

  const nowS = Math.floor(Date.now() / 1000);
  console.log(`fetch-mapillary --preview — ${entries.length} aday · token'sız (imzalı sourceUrl)`);
  let ok = 0, skipExisting = 0, expired = 0, failed = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const tag = `[${i + 1}/${entries.length}] ${e.country}/${e.city || "?"} ${e.imageId}`;
    const outPath = path.join(PREVIEW_MAPILLARY_DIR, `${e.imageId}.jpg`);
    if (existsSync(outPath)) { skipExisting++; continue; } // idempotent: yeniden indirmez
    const m = (e.sourceUrl || "").match(/[?&]oe=([0-9A-Fa-f]+)/);
    if (m && parseInt(m[1], 16) <= nowS) {
      console.warn(`  ! ${tag}: imza süresi DOLMUŞ → token ile --discover yenilemesi gerekir`);
      expired++; continue;
    }
    try {
      const buf = await fetchBufferWithRetry(e.sourceUrl);
      await sharp(buf).resize(1024, 512, { fit: "fill" }).jpeg({ quality: 78 }).toFile(outPath);
      ok++;
      if ((i + 1) % 10 === 0 || i + 1 === entries.length) console.log(`  … ${i + 1}/${entries.length} indirildi`);
    } catch (err) {
      console.warn(`  ! ${tag}: ${err.message}`);
      failed++;
    }
    await sleep(120); // nazik throttle
  }
  console.log(`\n────────────────────────────────────────`);
  console.log(`indirilen: ${ok}   mevcut-atlanan: ${skipExisting}   süre-dolmuş: ${expired}   başarısız: ${failed}`);
  console.log(`önizlemeler: ${path.relative(process.cwd(), PREVIEW_MAPILLARY_DIR)}/<id>.jpg`);
  if (expired) console.log(`⚠ ${expired} imza dolmuş — token'lı "--discover" ile sourceUrl'leri yenile, sonra tekrar --preview.`);
  console.log(`Sonraki adım: node scripts/korNokta/montage-mapillary.mjs  → bölgesel kontak-sayfaları`);
}

// ── --fetch-accepted modu · TOKEN'SİZ tam-çözünürlük raw indirme ───────────
// accept-list-mapillary.json'daki KABUL edilen sahneleri imzalı sourceUrl'den
// raw/<imageId>.jpg olarak indirir (resize YOK). Idempotent (mevcut dosya atlanır).
// Graph/token YOK. Süresi dolmuş imza → token'lı "--discover" ile sourceUrl yenile.
async function fetchAcceptedMode() {
  if (!existsSync(ACCEPT_LIST_PATH)) {
    console.error(`✗ accept-list-mapillary.json yok: ${ACCEPT_LIST_PATH}`);
    console.error("  Önce Faz C kabul listesi üretilmeli (accepted[]).");
    process.exit(1);
  }
  const accept = JSON.parse(await fs.readFile(ACCEPT_LIST_PATH, "utf8"));
  const accepted = accept.accepted || [];
  if (!accepted.length) { console.error("✗ accept-list 'accepted' boş."); process.exit(1); }
  await fs.mkdir(RAW_DIR, { recursive: true });

  const nowS = Math.floor(Date.now() / 1000);
  console.log(`fetch-mapillary --fetch-accepted — ${accepted.length} sahne · token'sız (imzalı sourceUrl) · raw/ tam çözünürlük`);
  let ok = 0, skipExisting = 0, expired = 0, failed = 0;
  for (let i = 0; i < accepted.length; i++) {
    const a = accepted[i];
    const tag = `[${i + 1}/${accepted.length}] ${a.country}/${a.city || "?"} ${a.imageId}`;
    const outPath = path.join(RAW_DIR, `${a.imageId}.jpg`);
    if (existsSync(outPath)) { skipExisting++; continue; } // idempotent
    const m = (a.sourceUrl || "").match(/[?&]oe=([0-9A-Fa-f]+)/);
    if (!a.sourceUrl) { console.warn(`  ! ${tag}: sourceUrl yok`); failed++; continue; }
    if (m && parseInt(m[1], 16) <= nowS) {
      console.warn(`  ! ${tag}: imza süresi DOLMUŞ → token ile --discover yenilemesi gerekir`);
      expired++; continue;
    }
    try {
      const buf = await fetchBufferWithRetry(a.sourceUrl);
      // Doğrula: indirilen görsel ≥4096×2048 ve ~2:1 equirectangular mı (Rule 2).
      let dims;
      try { dims = await sharp(buf).metadata(); }
      catch { console.warn(`  ! ${tag}: görsel çözülemedi`); failed++; continue; }
      const dw = dims.width || 0, dh = dims.height || 0;
      if (dw < MIN_WIDTH || dh < MIN_HEIGHT || Math.abs(dw / dh - 2) > RATIO_TOL) {
        console.warn(`  ! ${tag}: indirilen ${dw}×${dh} — equirectangular 2:1 değil, atlandı`);
        failed++; continue;
      }
      await fs.writeFile(outPath, buf);
      ok++;
      console.log(`  + ${tag}  ${dw}×${dh}  ${(buf.length / 1048576).toFixed(2)}MB`);
    } catch (err) {
      console.warn(`  ! ${tag}: ${err.message}`);
      failed++;
    }
    await sleep(150); // nazik throttle
  }
  console.log(`\n────────────────────────────────────────`);
  console.log(`indirilen: ${ok}   mevcut-atlanan: ${skipExisting}   süre-dolmuş: ${expired}   başarısız: ${failed}`);
  console.log(`raw: ${path.relative(process.cwd(), RAW_DIR)}/<imageId>.jpg`);
  if (expired) console.log(`⚠ ${expired} imza dolmuş — token'lı "--discover" ile sourceUrl'leri yenile, sonra tekrar --fetch-accepted.`);
  if (failed) console.log(`⚠ ${failed} indirme başarısız — tekrar çalıştır (idempotent; yalnız eksikler indirilir).`);
  console.log(`\nSonraki adım: node scripts/korNokta/build-real-scenes.mjs`);
}

async function main() {
  const args = process.argv.slice(2);

  // --preview: Faz B görsel küratörlük indirmesi. TOKEN GEREKMEZ → token
  // kontrolünden ÖNCE kısa-devre. (Graph çağrısı yok; imzalı sourceUrl indirir.)
  if (args.includes("--preview")) {
    await previewMode();
    return;
  }

  // --fetch-accepted: Faz C tam-çözünürlük raw indirme. TOKEN GEREKMEZ → token
  // kontrolünden ÖNCE kısa-devre. (Graph çağrısı yok; imzalı sourceUrl indirir.)
  if (args.includes("--fetch-accepted")) {
    await fetchAcceptedMode();
    return;
  }

  // Rule 4: token YALNIZ environment variable'dan okunur. CLI arg / hardcode /
  // .env yazımı / ikinci fallback YOK. (CLI arg'da geçen token ps/şel geçmişine
  // sızabilir; bu yüzden bilinçli olarak desteklenmiyor.)
  const token = process.env.MAPILLARY_TOKEN;
  TOKEN_FOR_MASK = token || null; // log/hata maskelemesi için (gizli sızmaz)
  if (!token) {
    console.error("✗ Mapillary token yok — yalnız MAPILLARY_TOKEN environment variable'ından okunur.");
    console.error("  mapillary.com → Developers → uygulama oluştur → Client Token.");
    console.error("  Kullanım:  MAPILLARY_TOKEN=MLY|xxxx node scripts/korNokta/fetch-mapillary.mjs");
    process.exit(1);
  }

  // `--name=value` VE `--name value` (boşluklu) biçimlerinin İKİSİNİ de çözer.
  const argVal = (name) =>
    args.find((a) => a.startsWith(`${name}=`))?.split("=").slice(1).join("=")
    ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

  const perRegion = Number(argVal("--per-region")) > 0 ? Number(argVal("--per-region")) : 5;
  const onlyRegions = (argVal("--regions") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const regions = onlyRegions.length
    ? REGIONS.filter((r) => onlyRegions.includes(r.key))
    : REGIONS;
  // --regions verildi ama HİÇBİRİ eşleşmediyse: net hata + çık (sessiz boş-run yok).
  if (onlyRegions.length && regions.length === 0) {
    console.error(`✗ --regions eşleşmedi: "${onlyRegions.join(", ")}". Geçerli anahtarlar REGIONS dizisindedir.`);
    process.exit(1);
  }

  // CLI ayarları: `--discover` (metadata-only aday hasadı), `--smoke` (tek tile
  // gözlemi), `--max-tiles N` (yalnız tam fetch'te bölge başına tile üst sınırı).
  const discover = args.includes("--discover");
  const smoke = args.includes("--smoke");
  const argNum = (name, dflt) => {
    const n = Number(argVal(name));
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const maxTiles = argNum("--max-tiles", Infinity);

  if (discover) {
    // Metadata-only: GÖRSEL/PREVIEW/WEBP/RAW/manifest/candidates.json YOK.
    // Ayrı gitignored discovery-mapillary.json'a yazar (full-fetch'ten ÖNCE gelir).
    await discoverMode(token, regions);
    return;
  }

  if (smoke) {
    // Filtrelenmiş bölgeleri geçir (smoke yalnız ilk bölgenin ilk tile'ını okur); disk/indirme yok.
    await smokeTest(token, regions);
    return;
  }

  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.mkdir(PREVIEW_DIR, { recursive: true });

  let candidates = [];
  if (existsSync(CANDIDATES_PATH)) {
    try { candidates = JSON.parse(await fs.readFile(CANDIDATES_PATH, "utf8")).candidates || []; }
    catch { candidates = []; }
  }
  const knownIds = new Set(candidates.map((c) => c.sourceImageId));

  console.log(`fetch-mapillary — ${regions.length} bölge, hedef ${perRegion}/bölge`);
  console.log(`mevcut aday: ${candidates.length}\n`);

  let added = 0, skippedDup = 0, skippedQuality = 0, totalUnsafeIds = 0;
  const visitedTiles = new Set(); // run boyu coverage tile dedup (örtüşen bölgeler dahil)
  const seenIds = new Set();      // run boyu image ID dedup (gereksiz entity hydrate'i önler)

  for (const region of regions) {
    // AKTİF YOL: bölge bbox'ı → z14 coverage tile'ları; image ID'ler tile'dan keşfedilir.
    const tiles = tilesForBbox(region.bbox, TILE_Z);
    console.log(`▸ ${region.key} (${region.hint}) — ${tiles.length} coverage tile (z${TILE_Z})`);

    const regionPoints = candidates
      .filter((c) => c.region === region.key)
      .map((c) => ({ lat: c.lat, lng: c.lng }));
    const ctx = { candidates, knownIds, regionPoints };
    let takenThisRegion = 0, parsedTiles = 0, discoveredIds = 0, triedTiles = 0, unsafeIds = 0;

    for (const t of tiles) {
      if (takenThisRegion >= perRegion) break;
      if (triedTiles >= maxTiles) break; // --max-tiles üst sınırı (varsayılan ∞)

      const tileKey = `${t.z}/${t.x}/${t.y}`;
      if (visitedTiles.has(tileKey)) continue; // aynı tile tekrarı yok
      visitedTiles.add(tileKey);
      triedTiles++;

      let ids;
      try {
        const buf = await fetchTile(t.z, t.x, t.y, token);
        // güvenli GRAPH image ID'ler (+ is_pano ipucu); güvensiz/yuvarlanmış uint64 atlanır + sayılır
        const res = imageIdsFromTile(buf);
        ids = res.ids;
        unsafeIds += res.unsafeSkipped;
        totalUnsafeIds += res.unsafeSkipped;
      } catch (e) {
        console.warn(`  ! tile [${tileKey}] hatası: ${e.message}`);
        continue;
      }
      parsedTiles++;
      discoveredIds += ids.length;

      for (const { id, isPanoHint } of ids) {
        if (takenThisRegion >= perRegion) break;
        if (knownIds.has(id) || seenIds.has(id)) { skippedDup++; continue; } // image ID tekrarı yok
        seenIds.add(id);
        // tile is_pano ipucu KESİN false ise tekil entity çağrısını harcama (otorite yine entity).
        if (isPanoHint === false) { skippedQuality++; continue; }

        // Tekil Graph ENTITY çağrısı (bbox YOK) → authoritative metadata + doğrulama.
        let meta;
        try { meta = await hydrateImage(id, token); }
        catch (e) { console.warn(`  ! hydrate ${id}: ${e.message}`); continue; }
        if (!validateEntity(meta)) { skippedQuality++; continue; }

        const r = await processImageId(id, meta, region, ctx);
        if (r === "added") { takenThisRegion++; added++; }
        else if (r === "too-close" || r === "no-geo") skippedDup++;
        else skippedQuality++;
      }
    }
    console.log(`  ${region.key}: ${parsedTiles}/${tiles.length} tile parse, ${discoveredIds} güvenli image ID, ${unsafeIds} güvensiz ID atlandı, ${takenThisRegion} alındı`);
  }

  candidates.sort((a, b) => (a.region + a.sourceImageId).localeCompare(b.region + b.sourceImageId));
  await fs.writeFile(
    CANDIDATES_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: candidates.length, candidates }, null, 2),
  );

  console.log(`\n────────────────────────────────────────`);
  console.log(`eklenen: ${added}   tekrar/atlanan: ${skippedDup}   kalite-eleme: ${skippedQuality}   güvensiz-ID atlandı: ${totalUnsafeIds}`);
  console.log(`toplam aday: ${candidates.length}`);
  console.log(`preview manifest: ${path.relative(process.cwd(), CANDIDATES_PATH)}`);
  console.log(`önizlemeler: ${path.relative(process.cwd(), PREVIEW_DIR)}/<id>.jpg`);
  console.log(`\nSonraki adım: preview'ları incele, iyi id'leri build-real-scenes.mjs CURATION'a ekle.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
