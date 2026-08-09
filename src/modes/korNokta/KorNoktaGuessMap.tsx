/**
 * KorNoktaGuessMap — Kör Nokta harita bileşeni (Leaflet).
 *
 * İki mod:
 *   • "pick"   — dedektif pin bırakır/sürükler; her tıklama/sürükleme marker'ı
 *     taşır ve onGuessChange ile bildirir. Harita KİLİTLENMEZ: faz açık olduğu
 *     sürece oyuncu konumu istediği kadar değiştirir (son konum nihai sayılır).
 *   • "reveal" — tahmin + gerçek konum + kesik çizgi; salt-okunur,
 *     fitBounds ile iki nokta kadrajlanır.
 *
 * HaritaDedektifiGame'in Leaflet kurulumuyla aynı pattern (tile provider,
 * marker asset fix, click/scroll propagation guard'ları); faz bazlı
 * mount/unmount için bağımsız bileşen olarak ayrıldı.
 */

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { getMapTileProvider } from "../cagDedektifi/mapTileProvider";

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

export interface KnLatLng {
  lat: number;
  lng: number;
}

/** Çok-tahminli reveal için renkli takım tahmini. */
export interface KnRevealGuess extends KnLatLng {
  /** Marker + çizgi rengi (örn. "#4f8bff" Mavi, "#ef4444" Kırmızı). */
  color: string;
}

interface KorNoktaGuessMapProps {
  mode: "pick" | "reveal";
  onGuessChange?: (guess: KnLatLng) => void;
  revealGuess?: KnLatLng | null;
  /** Çok tahmin (takım modu): her biri kendi renginde marker + çizgi. */
  revealGuesses?: KnRevealGuess[] | null;
  revealActual?: KnLatLng | null;
  className?: string;
}

const MAP_DEFAULT_CENTER: [number, number] = [25, 20];
const MAP_DEFAULT_ZOOM = 2;
const MAP_MIN_ZOOM = 2;

/* ── Dar ekran (mobil app + mobil web) harita alt sınırı ──────────────────────
 * Harita konteyneri telefonda ≈370 px geniş. Sağlayıcı 512 px tile + zoomOffset
 * -1 kullandığı için harita zoom 2'de dünya 1024 px'e denk gelir → ekranda
 * boylamca ancak ~%36'sı kalır ve minZoom 2 olduğundan zoom-out düğmesi BAŞTAN
 * pasif gelirdi. Dedektif 35 sn'lik fazda görmediği kıtalara kör pan yapmak
 * zorunda kalıyor, oryantasyon için uzaklaşamıyordu.
 *
 * Dar ekranda alt sınırı (ve tahmin ekranının açılış zoom'unu) 1'e indiriyoruz:
 * dünya 512 px'e iner, 370 px'lik haritada ~%72'si görünür.
 *
 * 1'in ALTINA inilmez: zoomOffset -1 ile harita zoom'u 0 olduğunda tile z = -1
 * istenir ve sağlayıcı 404 döner (harita boş kalır). Yani 1, tile şemasının
 * izin verdiği gerçek taban.
 *
 * Geniş ekranda hiçbir şey değişmez — masaüstü aynı 2/2 değerleriyle açılır.
 */
const NARROW_VIEWPORT_QUERY = "(max-width: 899px)";
const MAP_NARROW_MIN_ZOOM = 1;

function isNarrowViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_VIEWPORT_QUERY).matches
  );
}

export default function KorNoktaGuessMap({
  mode,
  onGuessChange,
  revealGuess,
  revealGuesses,
  revealActual,
  className,
}: KorNoktaGuessMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Leaflet handler'ları React render döngüsü dışında yaşar; en güncel
  // callback'i ref üzerinden okur (effect'i yeniden bağlamadan).
  const onGuessChangeRef = useRef(onGuessChange);
  useEffect(() => {
    onGuessChangeRef.current = onGuessChange;
  }, [onGuessChange]);

  // pick marker'ı ref'te tutulur ki mount effect'i (yalnız [mode]'a bağlı)
  // yeniden bağlanmadan marker'a erişilebilsin.
  const guessMarkerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Dar ekranda dünya kadrajı iki kat genişler; masaüstünde değerler aynı
    // kalır. "reveal" modunda açılış zoom'unu zaten fitBounds ezer.
    const narrow = isNarrowViewport();

    const map = L.map(el, {
      center: MAP_DEFAULT_CENTER,
      zoom: narrow ? MAP_NARROW_MIN_ZOOM : MAP_DEFAULT_ZOOM,
      minZoom: narrow ? MAP_NARROW_MIN_ZOOM : MAP_MIN_ZOOM,
      maxZoom: 18,
      zoomSnap: 1,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 40,
      wheelDebounceTime: 10,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: false,
      keyboard: false,
    });

    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);

    const provider = getMapTileProvider();
    L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: provider.maxZoom,
      ...(provider.subdomains ? { subdomains: provider.subdomains } : {}),
      ...(provider.tileSize ? { tileSize: provider.tileSize } : {}),
      ...(provider.zoomOffset !== undefined ? { zoomOffset: provider.zoomOffset } : {}),
    }).addTo(map);

    if (mode === "pick") {
      const emitGuess = (ll: L.LatLng) => {
        onGuessChangeRef.current?.({ lat: ll.lat, lng: ll.lng });
      };

      map.on("click", (e) => {
        // Her tıklama marker'ı yeni konuma taşır (kilit yok) → tahmin güncellenir.
        const existing = guessMarkerRef.current;
        if (existing) {
          existing.setLatLng(e.latlng);
        } else {
          const marker = L.marker(e.latlng, { draggable: true }).addTo(map);
          // Sürükleme de desteklenir: her drag/dragend güncel konumu bildirir.
          marker.on("drag", (ev) => {
            emitGuess((ev.target as L.Marker).getLatLng());
          });
          marker.on("dragend", (ev) => {
            emitGuess((ev.target as L.Marker).getLatLng());
          });
          guessMarkerRef.current = marker;
        }
        emitGuess(e.latlng);
      });
    } else {
      const actual = revealActual ?? null;
      // Çok-tahmin (takım modu) önceliklidir; yoksa tek revealGuess (geri uyum).
      const guesses: KnRevealGuess[] =
        revealGuesses && revealGuesses.length > 0
          ? revealGuesses
          : revealGuess
            ? [{ ...revealGuess, color: "#f59e0b" }]
            : [];

      if (actual) {
        const answerIcon = L.divIcon({
          className: "kn-answer-marker",
          html: '<span class="kn-answer-marker__dot" aria-hidden="true"></span>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        L.marker([actual.lat, actual.lng], {
          icon: answerIcon,
          interactive: false,
          keyboard: false,
        }).addTo(map);
      }

      const boundsPts: [number, number][] = [];
      if (actual) boundsPts.push([actual.lat, actual.lng]);

      for (const g of guesses) {
        const guessIcon = L.divIcon({
          className: "kn-guess-marker",
          html: `<span class="kn-guess-marker__dot" style="background:${g.color}" aria-hidden="true"></span>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        L.marker([g.lat, g.lng], {
          icon: guessIcon,
          interactive: false,
          keyboard: false,
        }).addTo(map);
        boundsPts.push([g.lat, g.lng]);

        if (actual) {
          L.polyline(
            [
              [g.lat, g.lng],
              [actual.lat, actual.lng],
            ],
            {
              color: g.color,
              weight: 2,
              opacity: 0.85,
              dashArray: "6 6",
              interactive: false,
            },
          ).addTo(map);
        }
      }

      if (boundsPts.length >= 2) {
        map.fitBounds(L.latLngBounds(boundsPts), {
          padding: [40, 40],
          maxZoom: 8,
          animate: false,
        });
      } else if (actual) {
        map.setView([actual.lat, actual.lng], 4, { animate: false });
      }
    }

    const raf = window.requestAnimationFrame(() => {
      map.invalidateSize();
    });

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(el);

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      map.remove();
      guessMarkerRef.current = null;
    };
    // Reveal koordinatları faz başına sabittir; bileşen faz değişiminde
    // key ile remount edilir, bu yüzden yalnız mode'a bağlanmak yeterli.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return <div ref={containerRef} className={"kn-map" + (className ? ` ${className}` : "")} />;
}
