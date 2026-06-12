/**
 * KorNoktaGuessMap — Kör Nokta harita bileşeni (Leaflet).
 *
 * İki mod:
 *   • "pick"   — dedektif pin bırakır/sürükler; onGuessChange ile bildirir.
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

interface KorNoktaGuessMapProps {
  mode: "pick" | "reveal";
  onGuessChange?: (guess: KnLatLng) => void;
  revealGuess?: KnLatLng | null;
  revealActual?: KnLatLng | null;
  className?: string;
}

const MAP_DEFAULT_CENTER: [number, number] = [25, 20];
const MAP_DEFAULT_ZOOM = 2;

export default function KorNoktaGuessMap({
  mode,
  onGuessChange,
  revealGuess,
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const map = L.map(el, {
      center: MAP_DEFAULT_CENTER,
      zoom: MAP_DEFAULT_ZOOM,
      minZoom: 2,
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

    let guessMarker: L.Marker | null = null;

    if (mode === "pick") {
      const emitGuess = (ll: L.LatLng) => {
        onGuessChangeRef.current?.({ lat: ll.lat, lng: ll.lng });
      };

      map.on("click", (e) => {
        if (guessMarker) {
          guessMarker.setLatLng(e.latlng);
        } else {
          guessMarker = L.marker(e.latlng, { draggable: true }).addTo(map);
          guessMarker.on("drag", (ev) => emitGuess((ev.target as L.Marker).getLatLng()));
          guessMarker.on("dragend", (ev) => emitGuess((ev.target as L.Marker).getLatLng()));
        }
        emitGuess(e.latlng);
      });
    } else {
      const actual = revealActual ?? null;
      const guess = revealGuess ?? null;

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

      if (guess) {
        L.marker([guess.lat, guess.lng], {
          interactive: false,
          keyboard: false,
        }).addTo(map);
      }

      if (actual && guess) {
        L.polyline(
          [
            [guess.lat, guess.lng],
            [actual.lat, actual.lng],
          ],
          {
            color: "#f59e0b",
            weight: 2,
            opacity: 0.85,
            dashArray: "6 6",
            interactive: false,
          },
        ).addTo(map);
        map.fitBounds(
          L.latLngBounds([
            [guess.lat, guess.lng],
            [actual.lat, actual.lng],
          ]),
          { padding: [40, 40], maxZoom: 8, animate: false },
        );
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
    };
    // Reveal koordinatları faz başına sabittir; bileşen faz değişiminde
    // key ile remount edilir, bu yüzden yalnız mode'a bağlanmak yeterli.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return <div ref={containerRef} className={"kn-map" + (className ? ` ${className}` : "")} />;
}
