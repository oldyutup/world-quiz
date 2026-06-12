import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import {
  calculateDistanceKm,
  calculateLocationScore,
} from "../modes/cagDedektifi/geoUtils";
import { getMapTileProvider } from "../modes/cagDedektifi/mapTileProvider";

// ─────────────────────────────────────────────────────────────
// DEV-ONLY Harita Dedektifi 360 kalite test simülasyonu
// (http://localhost:5173/history-360-test). Production build'e girmez —
// main.tsx bu sayfayı yalnızca import.meta.env.DEV iken mount eder.
//
// Amaç: yeni "üret → AI upscale → 4096×2048 WebP" asset pipeline'ının
// çıktısını, oyunun gerçek akışıyla (360 viewer + mini map tahmin +
// puanlama) yan yana test etmek. Ana oyuna ve mevcut sahne listesine
// dokunmaz; geoUtils + mapTileProvider yalnızca import edilir.
// Asset pipeline: scripts/history360/ (generate.mjs + postprocess.mjs)
// ─────────────────────────────────────────────────────────────

interface TestScene {
  id: string;
  yearLabel: string;
  eventLabel: string;
  panorama: string;
  location: { lat: number; lng: number; placeLabel: string };
  scoreCurve: { maxScore: number; scaleKm: number };
  explanation: string;
  debug: string;
}

const PIPELINE_NOTE =
  "AI Horde · Flux.1-Schnell 1408×704 + RealESRGAN ×4 → Lanczos 4096×2048 · seam blend · WebP q82";

const TEST_SCENES: TestScene[] = [
  {
    id: "h360_001_giza_pyramids_construction",
    yearLabel: "MÖ ~2560",
    eventLabel: "Giza Piramitlerinin İnşası",
    panorama:
      "/assets/history/360-test/h360_001_giza_pyramids_construction_4096x2048.webp",
    location: { lat: 29.9792, lng: 31.1342, placeLabel: "Giza Platosu, Mısır" },
    scoreCurve: { maxScore: 5000, scaleKm: 350 },
    explanation:
      "Büyük Piramit, MÖ 2560 civarında Firavun Khufu için Giza Platosu'nda inşa edildi. On binlerce işçi, Nil üzerinden taşınan kireçtaşı bloklarını rampalar ve kızaklarla yerine taşıdı; inşaat yaklaşık 20 yıl sürdü.",
    debug: PIPELINE_NOTE,
  },
  {
    id: "h360_002_eiffel_tower_construction",
    yearLabel: "1888",
    eventLabel: "Eyfel Kulesi'nin İnşası",
    panorama:
      "/assets/history/360-test/h360_002_eiffel_tower_construction_4096x2048.webp",
    location: {
      lat: 48.8584,
      lng: 2.2945,
      placeLabel: "Champ de Mars / Eyfel Kulesi, Paris, Fransa",
    },
    scoreCurve: { maxScore: 5000, scaleKm: 450 },
    explanation:
      "Eyfel Kulesi, 1889 Dünya Fuarı için 1887-1889 arasında Champ de Mars'ta inşa edildi. 18.000'den fazla dövme demir parça ve 2,5 milyon perçinle yükselen kule, tamamlandığında dünyanın en yüksek yapısı oldu.",
    debug: PIPELINE_NOTE,
  },
  {
    id: "h360_003_ephesus_harbor_daily_life",
    yearLabel: "MS ~100",
    eventLabel: "Efes Liman Şehrinde Gündelik Yaşam",
    panorama:
      "/assets/history/360-test/h360_003_ephesus_harbor_daily_life_4096x2048.webp",
    location: {
      lat: 37.9417,
      lng: 27.3417,
      placeLabel: "Efes Antik Kenti, Selçuk, İzmir, Türkiye",
    },
    scoreCurve: { maxScore: 5000, scaleKm: 300 },
    explanation:
      "Efes, Roma döneminde Akdeniz'in en işlek liman kentlerinden biriydi. Mermer sütunlu Liman Caddesi (Arkadiane) limanı kent merkezine bağlar; tüccarlar, amforalar ve gemilerle dolu liman kente büyük zenginlik taşırdı.",
    debug: PIPELINE_NOTE,
  },
];

// Leaflet'in default marker asset'leri bundler altında kırılır — oyunla aynı
// düzeltme (HaritaDedektifiGame.tsx ile birebir).
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const MIN_PITCH_DEG = -85;
const MAX_PITCH_DEG = 85;
// Oyundan daha geniş zoom aralığı (oyun: 65-90) — kalite testi için yakın
// zoom'da netliği inceleyebilmek amacıyla bilinçli olarak 50'ye iner.
const MIN_FOV = 50;
const MAX_FOV = 100;
const DEFAULT_FOV = 80;
const SPHERE_RADIUS = 500;

const MAP_DEFAULT_CENTER: [number, number] = [25, 20];
const MAP_DEFAULT_ZOOM = 3;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeYawDeg(deg: number) {
  let v = deg % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

function yawPitchDegToDirection(yawDeg: number, pitchDeg: number, out: THREE.Vector3) {
  const yaw = yawDeg * DEG2RAD;
  const pitch = pitchDeg * DEG2RAD;
  const cp = Math.cos(pitch);
  out.set(cp * Math.cos(yaw), Math.sin(pitch), -cp * Math.sin(yaw));
  return out;
}

interface RoundResult {
  sceneId: string;
  eventLabel: string;
  distanceKm: number;
  score: number;
  maxScore: number;
}

export default function History360TestPage() {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [results, setResults] = useState<RoundResult[]>([]);
  const [isFinished, setIsFinished] = useState(false);

  const scene = TEST_SCENES[sceneIndex];
  const totalScenes = TEST_SCENES.length;
  const isLastScene = sceneIndex === totalScenes - 1;
  const totalScore = results.reduce((sum, r) => sum + r.score, 0);

  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [guess, setGuess] = useState<{ lat: number; lng: number } | null>(null);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [showDebug, setShowDebug] = useState(true);
  const [imageInfo, setImageInfo] = useState<string>("");

  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const answerMarkerRef = useRef<L.Marker | null>(null);
  const answerLineRef = useRef<L.Polyline | null>(null);

  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const fovRef = useRef(DEFAULT_FOV);

  // Leaflet click handler'ı React state'ini görmez — sonuç kilidini ref'ten okur.
  const resultRef = useRef<RoundResult | null>(null);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  // ── 360 panorama viewer — oyun viewer'ının birebir klonu ────
  useEffect(() => {
    const container = viewerContainerRef.current;
    if (!container) return;

    setIsLoaded(false);
    setLoadError(null);
    setImageInfo("");

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

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(initialWidth, initialHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

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
        loaded.colorSpace = THREE.SRGBColorSpace;
        loaded.mapping = THREE.EquirectangularReflectionMapping;
        loaded.anisotropy = maxAnisotropy;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.magFilter = THREE.LinearFilter;
        loaded.generateMipmaps = true;
        loaded.needsUpdate = true;
        material.map = loaded;
        material.needsUpdate = true;
        texture = loaded;
        const img = loaded.image as { width?: number; height?: number };
        setImageInfo(`${img?.width ?? "?"}×${img?.height ?? "?"}`);
        setIsLoaded(true);
      },
      undefined,
      (err) => {
        if (disposed) return;
        setLoadError(err instanceof Error ? err.message : "Panorama yüklenemedi");
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
      fovRef.current = clamp(fovRef.current + e.deltaY * 0.05, MIN_FOV, MAX_FOV);
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

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("wheel", onWheel);
      if (texture) texture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (canvas.parentElement === container) container.removeChild(canvas);
    };
  }, [scene.panorama]);

  // ── Leaflet mini map — oyunun kurulumuyla aynı ──────────────
  useEffect(() => {
    const el = mapContainerRef.current;
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
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
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
      if (resultRef.current) return;
      placeOrMoveMarker(e.latlng);
    });

    mapRef.current = map;

    const raf = window.requestAnimationFrame(() => map.invalidateSize());
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(el);

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Panel boyutu değişince Leaflet'in ölçüsü bayatlar — geçiş bitince tazele.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => map.invalidateSize(), 280);
    return () => window.clearTimeout(t);
  }, [mapExpanded, result, isFinished]);

  const handleSubmitGuess = () => {
    if (!guess || result) return;
    const map = mapRef.current;
    if (!map) return;

    const distanceKm = calculateDistanceKm(guess, scene.location);
    const score = calculateLocationScore(distanceKm, scene.scoreCurve);

    if (markerRef.current?.dragging) {
      markerRef.current.dragging.disable();
    }

    const answerLatLng = L.latLng(scene.location.lat, scene.location.lng);
    const guessLatLng = L.latLng(guess.lat, guess.lng);

    const answerIcon = L.divIcon({
      className: "h360-answer-marker",
      html: '<span class="h360-answer-marker__dot" aria-hidden="true"></span>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    answerMarkerRef.current = L.marker(answerLatLng, {
      icon: answerIcon,
      interactive: false,
      keyboard: false,
    }).addTo(map);

    answerLineRef.current = L.polyline([guessLatLng, answerLatLng], {
      color: "#f59e0b",
      weight: 2,
      opacity: 0.85,
      dashArray: "6 6",
      interactive: false,
    }).addTo(map);

    map.fitBounds(L.latLngBounds([guessLatLng, answerLatLng]), {
      padding: [40, 40],
      maxZoom: 8,
      animate: true,
    });

    const round: RoundResult = {
      sceneId: scene.id,
      eventLabel: scene.eventLabel,
      distanceKm,
      score,
      maxScore: scene.scoreCurve.maxScore,
    };
    setResults((prev) => [...prev, round]);
    setResult(round);
  };

  const resetForScene = () => {
    const map = mapRef.current;
    if (answerLineRef.current && map) map.removeLayer(answerLineRef.current);
    answerLineRef.current = null;
    if (answerMarkerRef.current && map) map.removeLayer(answerMarkerRef.current);
    answerMarkerRef.current = null;
    if (markerRef.current && map) map.removeLayer(markerRef.current);
    markerRef.current = null;
    map?.setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, { animate: false });
    setGuess(null);
    setResult(null);
  };

  const handleNext = () => {
    if (isLastScene) {
      setIsFinished(true);
      return;
    }
    resetForScene();
    setSceneIndex((i) => i + 1);
  };

  // Debug: sonucu beklemeden herhangi bir sahneye atla (puanlar sıfırlanır).
  const jumpToScene = (index: number) => {
    resetForScene();
    setResults([]);
    setIsFinished(false);
    setSceneIndex(index);
  };

  const handleRestart = () => {
    resetForScene();
    setResults([]);
    setIsFinished(false);
    setSceneIndex(0);
  };

  const distanceLabel = (km: number) =>
    km >= 10 ? `${Math.round(km).toLocaleString("tr-TR")} km` : `${km.toFixed(1)} km`;

  const stopBubble = useMemo(
    () => ({
      onWheel: (e: React.WheelEvent) => e.stopPropagation(),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    }),
    [],
  );

  const panelExpanded = mapExpanded || result !== null || isFinished;

  return (
    <div style={styles.screen}>
      <style>{embeddedCss}</style>
      <div ref={viewerContainerRef} style={styles.viewer} />

      {!isLoaded && !loadError && !isFinished && (
        <div style={styles.loadingOverlay}>
          <div className="h360-spinner" />
          <div style={styles.loadingText}>Sahne yükleniyor…</div>
        </div>
      )}

      {loadError && (
        <div style={{ ...styles.loadingOverlay, ...styles.loadingError }}>
          <strong>Sahne yüklenemedi</strong>
          <div style={styles.loadingText}>{loadError}</div>
          <div style={styles.loadingText}>
            Asset üretimi: <code>scripts/history360/README</code> akışı — önce
            generate.mjs + postprocess.mjs çalıştırılmış olmalı.
          </div>
        </div>
      )}

      <div style={styles.topLeft}>
        <span style={styles.brand}>History 360 Test</span>
        <span style={styles.sceneCounter}>
          Sahne {sceneIndex + 1}/{totalScenes}
        </span>
      </div>

      <div style={styles.topCenter}>
        <div style={styles.yearChip}>{scene.yearLabel}</div>
      </div>

      <div style={styles.topRight}>
        <span style={styles.totalChip}>
          Toplam: {totalScore.toLocaleString("tr-TR")}
        </span>
        {TEST_SCENES.map((s, i) => (
          <button
            key={s.id}
            onClick={() => jumpToScene(i)}
            style={i === sceneIndex ? styles.jumpBtnActive : styles.jumpBtn}
            title={`${s.eventLabel} (atla — skorlar sıfırlanır)`}
          >
            {i + 1}
          </button>
        ))}
        <button onClick={() => setShowDebug((v) => !v)} style={styles.jumpBtn}>
          dbg
        </button>
      </div>

      {showDebug && !isFinished && (
        <div style={styles.debugBox}>
          <div>{scene.panorama.split("/").pop()}</div>
          <div>
            doku: {imageInfo || "—"} · FOV {MIN_FOV}–{MAX_FOV}° (wheel zoom)
          </div>
          <div>{scene.debug}</div>
        </div>
      )}

      <div
        style={{
          ...styles.mapPanel,
          width: panelExpanded ? 560 : 360,
          height: isFinished ? 440 : panelExpanded ? 470 : 300,
        }}
        onMouseEnter={() => setMapExpanded(true)}
        onMouseLeave={() => setMapExpanded(false)}
        {...stopBubble}
      >
        <div
          ref={mapContainerRef}
          style={{
            ...styles.mapContainer,
            display: isFinished ? "none" : "block",
          }}
        />

        {isFinished ? (
          <div style={styles.resultBlock}>
            <span style={styles.eyebrow}>Test Bitti</span>
            <h2 style={styles.placeTitle}>Özet</h2>
            <div style={styles.finalList}>
              {results.map((r) => (
                <div key={r.sceneId} style={styles.finalRow}>
                  <span style={styles.finalRowLabel}>{r.eventLabel}</span>
                  <span style={styles.finalRowValue}>
                    {distanceLabel(r.distanceKm)} ·{" "}
                    {r.score.toLocaleString("tr-TR")}
                  </span>
                </div>
              ))}
            </div>
            <div style={styles.statsRow}>
              <div style={styles.stat}>
                <span style={styles.statValue}>
                  {totalScore.toLocaleString("tr-TR")}
                </span>
                <span style={styles.statLabel}>Toplam Puan</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statValue}>
                  {results.length > 0
                    ? Math.round(totalScore / results.length).toLocaleString("tr-TR")
                    : 0}
                </span>
                <span style={styles.statLabel}>Ortalama</span>
              </div>
            </div>
            <button style={styles.submitBtn} onClick={handleRestart}>
              Yeniden Oyna
            </button>
          </div>
        ) : result ? (
          <div style={styles.resultBlock}>
            <span style={styles.eyebrow}>{scene.eventLabel}</span>
            <h2 style={styles.placeTitle}>{scene.location.placeLabel}</h2>
            <div style={styles.statsRow}>
              <div style={styles.stat}>
                <span style={styles.statValue}>
                  {distanceLabel(result.distanceKm)}
                </span>
                <span style={styles.statLabel}>Uzaklık</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statValue}>
                  {result.score.toLocaleString("tr-TR")}
                  <span style={styles.statMax}>
                    {" / "}
                    {result.maxScore.toLocaleString("tr-TR")}
                  </span>
                </span>
                <span style={styles.statLabel}>Puan</span>
              </div>
            </div>
            <p style={styles.explanation}>{scene.explanation}</p>
            <button style={styles.submitBtn} onClick={handleNext}>
              {isLastScene ? "Bitir" : "Sıradaki Sahne"}
            </button>
          </div>
        ) : (
          <div style={styles.guessFooter}>
            <span style={styles.guessHint}>
              {guess
                ? `${guess.lat.toFixed(3)}, ${guess.lng.toFixed(3)}`
                : "Haritaya tıklayıp tahmin noktası seç"}
            </span>
            <button
              style={guess ? styles.submitBtn : styles.submitBtnDisabled}
              onClick={handleSubmitGuess}
              disabled={!guess}
            >
              Tahmini Gönder
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Pseudo-class / keyframe gerektiren küçük parçalar — sayfa dev-only olduğu
// için ayrı CSS dosyası yerine gömülü tutuldu.
const embeddedCss = `
.h360-spinner {
  width: 42px; height: 42px; border-radius: 50%;
  border: 3px solid rgba(255,255,255,0.25); border-top-color: #fff;
  animation: h360spin 0.9s linear infinite;
}
@keyframes h360spin { to { transform: rotate(360deg); } }
.h360-answer-marker__dot {
  display: block; width: 18px; height: 18px; border-radius: 50%;
  background: #f59e0b; border: 3px solid #fff7ed;
  box-shadow: 0 0 0 2px rgba(245,158,11,0.55), 0 2px 6px rgba(0,0,0,0.45);
}
`;

const styles: Record<string, CSSProperties> = {
  screen: {
    position: "fixed",
    inset: 0,
    background: "#0b0f14",
    color: "#e8edf2",
    fontFamily: "system-ui, -apple-system, sans-serif",
    overflow: "hidden",
  },
  viewer: {
    position: "absolute",
    inset: 0,
    cursor: "grab",
    touchAction: "none",
  },
  loadingOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    background: "rgba(11,15,20,0.82)",
    zIndex: 30,
  },
  loadingError: { color: "#fca5a5" },
  loadingText: { fontSize: 14, opacity: 0.85 },
  topLeft: {
    position: "absolute",
    top: 14,
    left: 16,
    display: "flex",
    alignItems: "center",
    gap: 10,
    zIndex: 20,
  },
  brand: {
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: 0.4,
    padding: "7px 12px",
    background: "rgba(13,17,22,0.78)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 8,
  },
  sceneCounter: {
    fontSize: 13,
    padding: "7px 10px",
    background: "rgba(13,17,22,0.78)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 8,
    opacity: 0.9,
  },
  topCenter: {
    position: "absolute",
    top: 14,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 20,
  },
  yearChip: {
    fontSize: 15,
    fontWeight: 700,
    padding: "8px 16px",
    background: "rgba(13,17,22,0.78)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 999,
  },
  topRight: {
    position: "absolute",
    top: 14,
    right: 16,
    display: "flex",
    alignItems: "center",
    gap: 6,
    zIndex: 20,
  },
  totalChip: {
    fontSize: 13,
    fontWeight: 600,
    padding: "7px 12px",
    background: "rgba(13,17,22,0.78)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 8,
    marginRight: 4,
  },
  jumpBtn: {
    minWidth: 32,
    padding: "6px 8px",
    fontSize: 13,
    background: "rgba(13,17,22,0.78)",
    color: "#e8edf2",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 8,
    cursor: "pointer",
  },
  jumpBtnActive: {
    minWidth: 32,
    padding: "6px 8px",
    fontSize: 13,
    background: "#3b82f6",
    color: "#fff",
    border: "1px solid #3b82f6",
    borderRadius: 8,
    cursor: "pointer",
  },
  debugBox: {
    position: "absolute",
    left: 16,
    bottom: 16,
    zIndex: 20,
    padding: "8px 12px",
    background: "rgba(13,17,22,0.78)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    fontSize: 11,
    lineHeight: 1.6,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#9fb3c8",
    maxWidth: 420,
  },
  mapPanel: {
    position: "absolute",
    right: 16,
    bottom: 16,
    zIndex: 25,
    display: "flex",
    flexDirection: "column",
    background: "rgba(13,17,22,0.92)",
    border: "1px solid rgba(255,255,255,0.16)",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
    transition: "width 0.22s ease, height 0.22s ease",
  },
  mapContainer: { flex: 1, minHeight: 0 },
  guessFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "10px 12px",
  },
  guessHint: {
    fontSize: 12,
    color: "#9fb3c8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  submitBtn: {
    padding: "10px 18px",
    fontSize: 14,
    fontWeight: 700,
    background: "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  submitBtnDisabled: {
    padding: "10px 18px",
    fontSize: 14,
    fontWeight: 700,
    background: "rgba(59,130,246,0.35)",
    color: "rgba(255,255,255,0.55)",
    border: "none",
    borderRadius: 8,
    cursor: "not-allowed",
  },
  resultBlock: {
    padding: "14px 16px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    overflowY: "auto",
  },
  eyebrow: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#7dd3fc",
    fontWeight: 700,
  },
  placeTitle: { margin: 0, fontSize: 18, lineHeight: 1.3 },
  statsRow: { display: "flex", gap: 24 },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statMax: { fontSize: 13, fontWeight: 500, opacity: 0.6 },
  statLabel: { fontSize: 11, opacity: 0.65, textTransform: "uppercase" },
  explanation: { margin: 0, fontSize: 13, lineHeight: 1.55, color: "#c4d0dc" },
  finalList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "4px 0",
  },
  finalRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 13,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    paddingBottom: 6,
  },
  finalRowLabel: { color: "#c4d0dc" },
  finalRowValue: { fontWeight: 600, whiteSpace: "nowrap" },
};
