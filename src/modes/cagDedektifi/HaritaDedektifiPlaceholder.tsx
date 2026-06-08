import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

interface HaritaDedektifiPlaceholderProps {
  onHome: () => void;
}

export default function HaritaDedektifiPlaceholder({ onHome }: HaritaDedektifiPlaceholderProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [30, 20],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: true,
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıda bulunanlar',
      maxZoom: 19,
    }).addTo(map);

    const placeOrMoveMarker = (latlng: L.LatLng) => {
      if (markerRef.current) {
        markerRef.current.setLatLng(latlng);
      } else {
        const marker = L.marker(latlng, { draggable: true }).addTo(map);
        marker.on("drag", (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          setCoords({ lat: ll.lat, lng: ll.lng });
        });
        marker.on("dragend", (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          setCoords({ lat: ll.lat, lng: ll.lng });
        });
        markerRef.current = marker;
      }
      setCoords({ lat: latlng.lat, lng: latlng.lng });
    };

    map.on("click", (e) => {
      placeOrMoveMarker(e.latlng);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  return (
    <div className="cag-screen">
      <div className="cag-overlay cag-overlay--top-left">
        <button className="cag-back" onClick={onHome} aria-label="Ana menüye dön">
          <span aria-hidden="true">←</span>
          <span className="cag-back-label">Menü</span>
        </button>
        <span className="cag-brand" aria-hidden="true">Harita Dedektifi</span>
      </div>

      <div className="harita-smoke">
        <div ref={mapContainerRef} className="harita-smoke-map" />
        <div className="harita-smoke-debug">
          {coords ? (
            <>
              <span>Lat: {coords.lat.toFixed(4)}</span>
              <span>Lng: {coords.lng.toFixed(4)}</span>
            </>
          ) : (
            <span>Haritaya tıklayın</span>
          )}
        </div>
      </div>
    </div>
  );
}
