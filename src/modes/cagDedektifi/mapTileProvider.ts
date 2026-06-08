// Harita Dedektifi tile provider seçimi.
//
// Standart OpenStreetMap tile'ları (tile.openstreetmap.org) etiketleri yerel
// alfabede (Arapça, Kiril, Çince…) sunar — oyuncu için okunması zor. Bu
// modülde Latin alfabesiyle render edilmiş raster tile sağlayıcılarına
// fallback zinciri tanımlıyoruz. Leaflet altyapısı korunur (vektör tile yok).
//
// Yapılandırma:
//   • VITE_MAPTILER_KEY varsa  → MapTiler Streets v4 raster (Latin etiketler,
//     net şehir/yol görünümü). Default URL doğrudan 512 px tile döner.
//   • yoksa                    → CartoDB Voyager (Latin etiketler, token
//     gerekmez).
//
// MapTiler URL formatı (dashboard ile birebir):
//   512 default : https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png?key=...
//   256 variant : https://api.maptiler.com/maps/streets-v4/256/{z}/{x}/{y}.png?key=...
// Yanlışlıkla `/512/` segmenti eklemek 401 / "Get a valid key" hatası verir.
//
// Hiçbir sağlayıcı için zorunlu ortam değişkeni yoktur; key yoksa harita
// çalışmaya devam eder.

export interface MapTileProvider {
  id: string;
  url: string;
  attribution: string;
  maxZoom: number;
  subdomains?: string;
  tileSize?: number;
  zoomOffset?: number;
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
  // streets-v4 default endpoint 512 px raster tile döner; Leaflet 256 px
  // varsayar, bu yüzden tileSize 512 + zoomOffset -1 ile eşleştiriyoruz.
  return {
    id: "maptiler-streets",
    url: `https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png?key=${encodeURIComponent(
      key,
    )}`,
    attribution:
      '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 22,
    tileSize: 512,
    zoomOffset: -1,
  };
}

let providerLogged = false;

export function getMapTileProvider(): MapTileProvider {
  const rawKey = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
  const key = rawKey?.trim();
  const provider = key ? maptilerStreets(key) : CARTO_VOYAGER;

  if (import.meta.env.DEV && !providerLogged) {
    providerLogged = true;
    if (provider.id === "maptiler-streets") {
      // eslint-disable-next-line no-console
      console.log("Map provider: MapTiler Streets");
      // Key'in kendisi loglanmaz; sadece varlığı ve URL şablonu (key parametresi
      // <redacted> ile gizlenmiş halde) gösterilir. 401/403 alındığında
      // formatın doğru olup olmadığını anlamak için yeterli.
      const redacted = provider.url.replace(/key=[^&]+/, "key=<redacted>");
      // eslint-disable-next-line no-console
      console.log(
        `MapTiler key detected (length=${key!.length}); tile URL template: ${redacted}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log("Map provider: Carto fallback");
      if (rawKey !== undefined && key === "") {
        // eslint-disable-next-line no-console
        console.warn(
          "VITE_MAPTILER_KEY is defined but empty — restart `vite dev` after editing .env.local.",
        );
      }
    }
  }

  return provider;
}
