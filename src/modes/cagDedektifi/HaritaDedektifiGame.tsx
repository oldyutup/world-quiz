import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import {
  HARITA_DEDEKTIFI_SCENES,
  type HaritaDedektifiScene,
} from "./haritaDedektifiScenes";
import { getMapTileProvider } from "./mapTileProvider";
import "./CagDedektifiGame.css";

// Leaflet's default marker assets break under bundlers — re-point them at the
// imported URLs so the pin shows up.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

interface HaritaDedektifiGameProps {
  onHome: () => void;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const MIN_PITCH_DEG = -85;
const MAX_PITCH_DEG = 85;
const MIN_FOV = 65;
const MAX_FOV = 90;
const DEFAULT_FOV = 80;
const SPHERE_RADIUS = 500;

function normalizeYawDeg(deg: number) {
  let v = deg % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function yawPitchDegToDirection(yawDeg: number, pitchDeg: number, out: THREE.Vector3) {
  const yaw = yawDeg * DEG2RAD;
  const pitch = pitchDeg * DEG2RAD;
  const cp = Math.cos(pitch);
  out.set(cp * Math.cos(yaw), Math.sin(pitch), -cp * Math.sin(yaw));
  return out;
}

export default function HaritaDedektifiGame({ onHome }: HaritaDedektifiGameProps) {
  const scene: HaritaDedektifiScene = HARITA_DEDEKTIFI_SCENES[0];

  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [guess, setGuess] = useState<{ lat: number; lng: number } | null>(null);
  const [mapPanelExpanded, setMapPanelExpanded] = useState(false);

  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const fovRef = useRef(DEFAULT_FOV);

  // ── 360 panorama viewer ─────────────────────────────────────
  useEffect(() => {
    const container = viewerContainerRef.current;
    if (!container) return;

    setIsLoaded(false);
    setLoadError(null);

    const initialWidth = container.clientWidth || 1;
    const initialHeight = container.clientHeight || 1;

    const threeScene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      initialWidth / initialHeight,
      0.1,
      1100,
    );
    camera.position.set(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(initialWidth, initialHeight, false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outputColorSpace = (THREE as any).SRGBColorSpace;
    if (outputColorSpace !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (renderer as any).outputColorSpace = outputColorSpace;
    }
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
    container.appendChild(renderer.domElement);

    const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32);
    const material = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
    const mesh = new THREE.Mesh(geometry, material);
    threeScene.add(mesh);

    const forward = new THREE.Vector3();
    const target = new THREE.Vector3();

    yawRef.current = 0;
    pitchRef.current = 0;
    fovRef.current = DEFAULT_FOV;

    let texture: THREE.Texture | null = null;
    let disposed = false;
    let rafId = 0;

    function updateCamera() {
      yawPitchDegToDirection(yawRef.current, pitchRef.current, forward);
      target.copy(camera.position).add(forward);
      camera.lookAt(target);
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
    }

    function renderLoop() {
      if (disposed) return;
      renderer.render(threeScene, camera);
      rafId = window.requestAnimationFrame(renderLoop);
    }

    updateCamera();
    renderLoop();

    const loader = new THREE.TextureLoader();
    loader.load(
      scene.panorama,
      (loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const colorSpace = (THREE as any).SRGBColorSpace;
        if (colorSpace !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (loaded as any).colorSpace = colorSpace;
        }
        loaded.mapping = THREE.EquirectangularReflectionMapping;
        loaded.anisotropy = maxAnisotropy;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.magFilter = THREE.LinearFilter;
        loaded.generateMipmaps = true;
        loaded.needsUpdate = true;
        material.map = loaded;
        material.needsUpdate = true;
        texture = loaded;
        setIsLoaded(true);
      },
      undefined,
      (err) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : "Bilinmeyen hata";
        setLoadError(message);
      },
    );

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let activePointerId: number | null = null;

    function getSensitivity() {
      return (fovRef.current * DEG2RAD) / Math.max(1, container?.clientHeight || 1);
    }

    function onPointerDown(e: PointerEvent) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      activePointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging) return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      const sens = getSensitivity();
      yawRef.current = normalizeYawDeg(yawRef.current + dx * sens * RAD2DEG);
      pitchRef.current = clamp(
        pitchRef.current + dy * sens * RAD2DEG,
        MIN_PITCH_DEG,
        MAX_PITCH_DEG,
      );
      updateCamera();
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragging) return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    function onPointerCancel() {
      dragging = false;
      activePointerId = null;
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const next = clamp(fovRef.current + e.deltaY * 0.05, MIN_FOV, MAX_FOV);
      fovRef.current = next;
      updateCamera();
    }

    function onResize() {
      if (!container) return;
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("wheel", onWheel);

      if (texture) texture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (canvas.parentElement === container) {
        container.removeChild(canvas);
      }
    };
  }, [scene.panorama]);

  // ── Leaflet mini map ────────────────────────────────────────
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;

    // Neutral world-ish framing — Mediterranean-centered so the player does
    // not get a free hint from the initial map position, but close enough
    // that country labels (not just continent names) render right away.
    const map = L.map(el, {
      center: [25, 20],
      zoom: 3,
      minZoom: 2,
      maxZoom: 18,
      // Each + / - press or wheel notch advances a full zoom level instead of
      // creeping by halves, so the mini map feels responsive instead of mushy.
      zoomSnap: 1,
      zoomDelta: 1,
      // Lower px-per-zoom → a quick wheel flick crosses several zoom levels.
      wheelPxPerZoomLevel: 40,
      wheelDebounceTime: 10,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
      // Explicit mobile / desktop interaction switches. Defaults already
      // enable these, but spelling them out makes the contract obvious and
      // guards against a future refactor that silently flips a default.
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: false,
      keyboard: false,
    });

    // Keep map taps and wheel scrolls from leaking out of the panel (e.g.
    // closing parent overlays) without smothering Leaflet's own pan / pinch
    // listeners — those live on document and would die if we stopped
    // propagation at the React level. This is the Leaflet-blessed pattern.
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

    function placeOrMoveMarker(latlng: L.LatLng) {
      if (markerRef.current) {
        markerRef.current.setLatLng(latlng);
      } else {
        const marker = L.marker(latlng, { draggable: true }).addTo(map);
        marker.on("drag", (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          setGuess({ lat: ll.lat, lng: ll.lng });
        });
        marker.on("dragend", (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          setGuess({ lat: ll.lat, lng: ll.lng });
        });
        markerRef.current = marker;
      }
      setGuess({ lat: latlng.lat, lng: latlng.lng });
    }

    map.on("click", (e) => {
      placeOrMoveMarker(e.latlng);
    });

    mapRef.current = map;

    // Leaflet measures the container at construction time; if the layout
    // settles after mount, recompute so tiles cover the full panel.
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
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // When the panel expands/collapses on hover, Leaflet's cached size goes
  // stale and tiles render gray until the next interaction. Re-measure after
  // the CSS transition settles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => {
      map.invalidateSize();
    }, 260);
    return () => window.clearTimeout(t);
  }, [mapPanelExpanded]);

  const handleSubmitGuess = () => {
    if (!guess) return;
    // PR-4 will compute distance/score and show the result modal.
    // eslint-disable-next-line no-console
    console.log("[HaritaDedektifi] submit guess", guess);
  };

  // Only click + wheel are forwarded here. We deliberately do NOT stop
  // pointermove / touchmove / pointerup / touchend — Leaflet's drag and
  // pinch handlers are attached to `document`, and React's synthetic
  // stopPropagation bubbles up through the React root *before* the native
  // event reaches document. Killing those events here is exactly what was
  // breaking mobile pan and pinch. The panorama canvas owns its own native
  // listeners on itself only, so move events on the panel never reach it
  // either way.
  const stopBubble = useMemo(
    () => ({
      onWheel: (e: React.WheelEvent) => e.stopPropagation(),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    }),
    [],
  );

  return (
    <div className="cag-screen">
      <div ref={viewerContainerRef} className="cag-viewer" />

      {!isLoaded && !loadError && (
        <div className="cag-loading-overlay">
          <div className="cag-loading-spinner" />
          <div className="cag-loading-text">Sahne yükleniyor...</div>
        </div>
      )}

      {loadError && (
        <div className="cag-loading-overlay cag-loading-overlay--error">
          <strong>Sahne yüklenemedi</strong>
          <div className="cag-loading-text">{loadError}</div>
        </div>
      )}

      <div className="cag-overlay cag-overlay--top-left">
        <button className="cag-back" onClick={onHome} aria-label="Ana menüye dön">
          <span aria-hidden="true">←</span>
          <span className="cag-back-label">Menü</span>
        </button>
        <span className="cag-brand" aria-hidden="true">Harita Dedektifi</span>
      </div>

      <div className="cag-overlay cag-overlay--top-center">
        <div className="cag-info-chip">
          <span className="cag-info-year">{scene.yearLabel}</span>
          <span className="cag-info-sep" aria-hidden="true">·</span>
          <span className="cag-info-event">{scene.eventLabel}</span>
        </div>
      </div>

      <div
        className={`harita-map-panel${mapPanelExpanded ? " is-expanded" : ""}`}
        onMouseEnter={() => setMapPanelExpanded(true)}
        onMouseLeave={() => setMapPanelExpanded(false)}
        {...stopBubble}
      >
        <div ref={mapContainerRef} className="harita-map-panel__map" />
        {guess && (
          <div className="harita-map-panel__debug">
            {guess.lat.toFixed(3)}, {guess.lng.toFixed(3)}
          </div>
        )}
        <button
          type="button"
          className="harita-map-panel__submit"
          onClick={handleSubmitGuess}
          disabled={!guess}
        >
          Tahmini Gönder
        </button>
      </div>
    </div>
  );
}
