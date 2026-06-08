// Harita Dedektifi tile provider seçimi.
//
// Standart OpenStreetMap tile'ları (tile.openstreetmap.org) etiketleri yerel
// alfabede (Arapça, Kiril, Çince…) sunar — oyuncu için okunması zor. Bu
// modülde Latin alfabesiyle render edilmiş raster tile sağlayıcılarına
// fallback zinciri tanımlıyoruz. Leaflet altyapısı korunur (vektör tile yok).
//
// Yapılandırma:
//   • VITE_MAPTILER_KEY varsa  → MapTiler streets-v2 raster (Latin etiketler)
//   • yoksa                    → CartoDB Voyager (Latin etiketler, token gerekmez)
//
// Hiçbir sağlayıcı için zorunlu ortam değişkeni yoktur; key yoksa harita
// çalışmaya devam eder.

export interface MapTileProvider {
  id: string;
  url: string;
  attribution: string;
  maxZoom: number;
  subdomains?: string;
}

const CARTO_VOYAGER: MapTileProvider = {
  id: "carto-voyager",
  url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19,
  subdomains: "abcd",
};

function maptilerStreets(key: string): MapTileProvider {
  // MapTiler streets-v2 raster — Latin etiketler default. Dinamik dil
  // parametresi raster XYZ'de güvenilir değil; Latin render yeterli.
  return {
    id: "maptiler-streets",
    url: `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${encodeURIComponent(
      key,
    )}`,
    attribution:
      '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıda bulunanlar',
    maxZoom: 22,
  };
}

export function getMapTileProvider(): MapTileProvider {
  const key = (import.meta.env.VITE_MAPTILER_KEY as string | undefined)?.trim();
  if (key) return maptilerStreets(key);
  return CARTO_VOYAGER;
}
