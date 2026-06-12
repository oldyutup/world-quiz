import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────────
// DEV-ONLY panorama viewer comparison page (http://localhost:5173/panorama-test).
// Not reachable in production builds — main.tsx only mounts this when
// import.meta.env.DEV is true. Compares the same panorama file across:
//   A) a clone of the Harita Dedektifi in-game Three.js viewer settings
//   B) a minimal Three.js panorama viewer (classic three.js example setup)
//   C) Pannellum loaded from CDN (no npm package added)
// ─────────────────────────────────────────────────────────────

// Active panorama is chosen from the `?file=` query param when present and safe,
// otherwise it falls back to the default scene file below.
const PANORAMA_DIR = "/assets/detective-scenes/";
const DEFAULT_PANORAMA_FILE = "viking_village_360.png";

// A file param is only accepted if it is a plain file name: no slashes, no
// backslashes, no "..", no ":" and no "http" (blocks paths, traversal, URLs).
function isSafePanoramaFile(name: string) {
  if (!name) return false;
  if (name.includes("/")) return false;
  if (name.includes("\\")) return false;
  if (name.includes("..")) return false;
  if (name.includes(":")) return false;
  if (name.toLowerCase().includes("http")) return false;
  return true;
}

function resolvePanoramaSrc() {
  const file = new URLSearchParams(window.location.search).get("file");
  const safeFile = file && isSafePanoramaFile(file) ? file : DEFAULT_PANORAMA_FILE;
  return PANORAMA_DIR + safeFile;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const SPHERE_RADIUS = 500;
const MIN_PITCH_DEG = -85;
const MAX_PITCH_DEG = 85;

const FOV_OPTIONS = [60, 70, 80, 90] as const;
const PIXEL_RATIO_OPTIONS = [1, 1.5, 2] as const;

type FilterMode = "linear-mipmap" | "linear" | "nearest";

const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
  { value: "linear-mipmap", label: "Linear+Mipmap (oyun)" },
  { value: "linear", label: "Linear (mipmap yok)" },
  { value: "nearest", label: "Nearest (referans)" },
];

interface SharedView {
  yawDeg: number;
  pitchDeg: number;
}

interface PanelStats {
  canvasWidth: number;
  canvasHeight: number;
  clientWidth: number;
  clientHeight: number;
  rendererPixelRatio: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

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

function applyFilterMode(texture: THREE.Texture, mode: FilterMode) {
  if (mode === "linear-mipmap") {
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
  } else if (mode === "linear") {
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
  } else {
    texture.generateMipmaps = false;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
  }
  texture.needsUpdate = true;
}

function StatsBlock({ stats }: { stats: PanelStats | null }) {
  if (!stats) return <div style={styles.stats}>yükleniyor…</div>;
  return (
    <div style={styles.stats}>
      <span>
        canvas: {stats.canvasWidth}×{stats.canvasHeight}
      </span>
      <span>
        client: {stats.clientWidth}×{stats.clientHeight}
      </span>
      <span>devicePixelRatio: {window.devicePixelRatio}</span>
      <span>
        renderer pixelRatio:{" "}
        {stats.rendererPixelRatio === null ? "—" : stats.rendererPixelRatio}
      </span>
      <span>
        image: {stats.imageWidth ?? "?"}×{stats.imageHeight ?? "?"}
      </span>
    </div>
  );
}

// ── Three.js panel (game clone / minimal) ────────────────────

interface ThreePanelProps {
  title: string;
  description: string;
  variant: "game" | "minimal";
  panoramaSrc: string;
  fov: number;
  pixelRatio: number;
  filterMode: FilterMode;
  sharedView: SharedView;
}

interface ThreePanelApi {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  texture: THREE.Texture | null;
}

function ThreePanel({
  title,
  description,
  variant,
  panoramaSrc,
  fov,
  pixelRatio,
  filterMode,
  sharedView,
}: ThreePanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ThreePanelApi | null>(null);
  const fovRef = useRef(fov);
  const filterRef = useRef(filterMode);
  const [stats, setStats] = useState<PanelStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  fovRef.current = fov;
  filterRef.current = filterMode;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialWidth = container.clientWidth || 1;
    const initialHeight = container.clientHeight || 1;

    const threeScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      fovRef.current,
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

    // Variant A mirrors the in-game viewer: BackSide sphere, equirectangular
    // reflection mapping, 64×32 segments. Variant B is the classic three.js
    // panorama example: front-side sphere mirrored with scale(-1,1,1), default
    // UV mapping, 60×40 segments.
    const geometry =
      variant === "game"
        ? new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32)
        : new THREE.SphereGeometry(SPHERE_RADIUS, 60, 40);
    if (variant === "minimal") geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial(
      variant === "game" ? { side: THREE.BackSide } : {},
    );
    const mesh = new THREE.Mesh(geometry, material);
    threeScene.add(mesh);

    const forward = new THREE.Vector3();
    const target = new THREE.Vector3();

    const api: ThreePanelApi = { renderer, camera, texture: null };
    apiRef.current = api;

    let disposed = false;
    let rafId = 0;

    function renderLoop() {
      if (disposed) return;
      yawPitchDegToDirection(sharedView.yawDeg, sharedView.pitchDeg, forward);
      target.copy(camera.position).add(forward);
      camera.lookAt(target);
      if (camera.fov !== fovRef.current) {
        camera.fov = fovRef.current;
        camera.updateProjectionMatrix();
      }
      renderer.render(threeScene, camera);
      rafId = window.requestAnimationFrame(renderLoop);
    }
    renderLoop();

    const loader = new THREE.TextureLoader();
    loader.load(
      panoramaSrc,
      (loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        loaded.colorSpace = THREE.SRGBColorSpace;
        if (variant === "game") {
          loaded.mapping = THREE.EquirectangularReflectionMapping;
        }
        loaded.anisotropy = maxAnisotropy;
        applyFilterMode(loaded, filterRef.current);
        material.map = loaded;
        material.needsUpdate = true;
        api.texture = loaded;
      },
      undefined,
      (err) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : "Panorama yüklenemedi");
      },
    );

    // Drag-to-look writes into the shared view object, so panel A and B stay
    // pointed at the exact same spot no matter which one is dragged.
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    function sensitivity() {
      return (fovRef.current * DEG2RAD) / Math.max(1, container?.clientHeight || 1);
    }

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      dragging = true;
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
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const sens = sensitivity();
      sharedView.yawDeg = normalizeYawDeg(sharedView.yawDeg + dx * sens * RAD2DEG);
      sharedView.pitchDeg = clamp(
        sharedView.pitchDeg + dy * sens * RAD2DEG,
        MIN_PITCH_DEG,
        MAX_PITCH_DEG,
      );
    }

    function onPointerUp() {
      dragging = false;
    }

    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    function onResize() {
      if (!container) return;
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    const statsTimer = window.setInterval(() => {
      const image = api.texture?.image as
        | { width?: number; height?: number }
        | undefined;
      setStats({
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        rendererPixelRatio: renderer.getPixelRatio(),
        imageWidth: image?.width ?? null,
        imageHeight: image?.height ?? null,
      });
    }, 500);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      window.clearInterval(statsTimer);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      if (api.texture) api.texture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (canvas.parentElement === container) container.removeChild(canvas);
      apiRef.current = null;
    };
    // sharedView is a stable mutable object; variant never changes per panel.
  }, [variant, sharedView, panoramaSrc]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.renderer.setPixelRatio(pixelRatio);
    const container = containerRef.current;
    if (container) {
      api.renderer.setSize(
        container.clientWidth || 1,
        container.clientHeight || 1,
        false,
      );
    }
  }, [pixelRatio]);

  useEffect(() => {
    const texture = apiRef.current?.texture;
    if (texture) applyFilterMode(texture, filterMode);
  }, [filterMode]);

  return (
    <section style={styles.panel}>
      <header style={styles.panelHeader}>
        <strong>{title}</strong>
        <span style={styles.panelDescription}>{description}</span>
        <span style={styles.fovBadge}>FOV: {fov}°</span>
      </header>
      <div ref={containerRef} style={styles.viewer} />
      {error && <div style={styles.error}>Hata: {error}</div>}
      <StatsBlock stats={stats} />
    </section>
  );
}

// ── Pannellum panel (CDN, no npm package) ────────────────────

const PANNELLUM_JS = "https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js";
const PANNELLUM_CSS = "https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css";

let pannellumLoadPromise: Promise<void> | null = null;

function loadPannellum(): Promise<void> {
  if (pannellumLoadPromise) return pannellumLoadPromise;
  pannellumLoadPromise = new Promise<void>((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = PANNELLUM_CSS;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = PANNELLUM_JS;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Pannellum CDN'den yüklenemedi (internet bağlantısı gerekli)"));
    document.head.appendChild(script);
  });
  return pannellumLoadPromise;
}

function verticalToHorizontalFov(vfovDeg: number, aspect: number) {
  return 2 * Math.atan(Math.tan((vfovDeg * DEG2RAD) / 2) * aspect) * RAD2DEG;
}

function PannellumPanel({ fov, panoramaSrc }: { fov: number; panoramaSrc: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null);
  const [stats, setStats] = useState<PanelStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = panoramaSrc;
  }, [panoramaSrc]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    loadPannellum()
      .then(() => {
        if (disposed || !container) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pannellum = (window as any).pannellum;
        const aspect =
          (container.clientWidth || 1) / Math.max(1, container.clientHeight || 1);
        viewerRef.current = pannellum.viewer(container, {
          type: "equirectangular",
          panorama: panoramaSrc,
          autoLoad: true,
          showControls: false,
          hfov: verticalToHorizontalFov(fov, aspect),
          minHfov: 30,
          maxHfov: 150,
        });
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : "Pannellum yüklenemedi");
      });

    const statsTimer = window.setInterval(() => {
      const canvas = container.querySelector("canvas");
      if (!canvas) return;
      setStats((prev) => ({
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        rendererPixelRatio: null,
        imageWidth: prev?.imageWidth ?? null,
        imageHeight: prev?.imageHeight ?? null,
      }));
    }, 500);

    return () => {
      disposed = true;
      window.clearInterval(statsTimer);
      try {
        viewerRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      viewerRef.current = null;
    };
    // fov changes are applied via setHfov below, not by rebuilding the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const container = containerRef.current;
    if (!viewer || !container) return;
    const aspect =
      (container.clientWidth || 1) / Math.max(1, container.clientHeight || 1);
    try {
      viewer.setHfov(verticalToHorizontalFov(fov, aspect), 0);
    } catch {
      /* viewer may not be ready yet */
    }
  }, [fov]);

  const mergedStats: PanelStats | null = stats
    ? {
        ...stats,
        imageWidth: imageSize?.w ?? null,
        imageHeight: imageSize?.h ?? null,
      }
    : null;

  return (
    <section style={styles.panel}>
      <header style={styles.panelHeader}>
        <strong>C) Pannellum (CDN)</strong>
        <span style={styles.panelDescription}>
          WebGL shader tabanlı equirectangular viewer — pixel ratio / filter
          kontrolleri uygulanmaz, kendi varsayılanlarını kullanır.
        </span>
        <span style={styles.fovBadge}>
          FOV: {fov}° (dikey → hfov'a çevrilir)
        </span>
      </header>
      <div ref={containerRef} style={styles.viewer} />
      {error && <div style={styles.error}>Hata: {error}</div>}
      <StatsBlock stats={mergedStats} />
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────

export default function PanoramaTestPage() {
  const [fov, setFov] = useState<number>(80);
  const [pixelRatio, setPixelRatio] = useState<number>(
    Math.min(window.devicePixelRatio, 2),
  );
  const [filterMode, setFilterMode] = useState<FilterMode>("linear-mipmap");
  const sharedViewRef = useRef<SharedView>({ yawDeg: 0, pitchDeg: 0 });
  // Resolve the active file once from the query param; stays fixed for this load.
  const panoramaSrcRef = useRef<string>(resolvePanoramaSrc());
  const panoramaSrc = panoramaSrcRef.current;

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Panorama Viewer Karşılaştırma Testi (dev-only)</h1>
      <p style={styles.subtitle}>
        Dosya: <code>{panoramaSrc}</code> — A ve B panelleri sürüklenince aynı
        noktaya bakar; Pannellum bağımsız gezilir.
      </p>

      <div style={styles.controls}>
        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>FOV (dikey)</span>
          {FOV_OPTIONS.map((value) => (
            <button
              key={value}
              onClick={() => setFov(value)}
              style={fov === value ? styles.buttonActive : styles.button}
            >
              {value}°
            </button>
          ))}
        </div>
        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Pixel ratio (A+B)</span>
          {PIXEL_RATIO_OPTIONS.map((value) => (
            <button
              key={value}
              onClick={() => setPixelRatio(value)}
              style={pixelRatio === value ? styles.buttonActive : styles.button}
            >
              {value}
            </button>
          ))}
        </div>
        <div style={styles.controlGroup}>
          <span style={styles.controlLabel}>Texture filter (A+B)</span>
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setFilterMode(option.value)}
              style={filterMode === option.value ? styles.buttonActive : styles.button}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <ThreePanel
        title="A) Oyun viewer klonu"
        description="Harita Dedektifi ayarları: BackSide küre 64×32, EquirectangularReflectionMapping, anisotropy max, sRGB, antialias, pixelRatio min(dpr,2)."
        variant="game"
        panoramaSrc={panoramaSrc}
        fov={fov}
        pixelRatio={pixelRatio}
        filterMode={filterMode}
        sharedView={sharedViewRef.current}
      />
      <ThreePanel
        title="B) Minimal Three.js"
        description="Klasik three.js panorama örneği: scale(-1,1,1) küre 60×40, varsayılan UV mapping."
        variant="minimal"
        panoramaSrc={panoramaSrc}
        fov={fov}
        pixelRatio={pixelRatio}
        filterMode={filterMode}
        sharedView={sharedViewRef.current}
      />
      <PannellumPanel fov={fov} panoramaSrc={panoramaSrc} />
    </div>
  );
}

// ── Inline styles (page is dev-only; no CSS file on purpose) ─

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#101418",
    color: "#e8edf2",
    fontFamily: "system-ui, -apple-system, sans-serif",
    padding: "16px 24px 48px",
    boxSizing: "border-box",
  },
  title: { fontSize: 20, margin: "0 0 4px" },
  subtitle: { fontSize: 13, opacity: 0.8, margin: "0 0 16px" },
  controls: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    padding: "12px 16px",
    background: "#1a2027",
    borderRadius: 8,
    marginBottom: 20,
    position: "sticky",
    top: 8,
    zIndex: 10,
    boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
  },
  controlGroup: { display: "flex", alignItems: "center", gap: 6 },
  controlLabel: { fontSize: 12, opacity: 0.7, marginRight: 4 },
  button: {
    background: "#2a323c",
    color: "#e8edf2",
    border: "1px solid #3a444f",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  },
  buttonActive: {
    background: "#3b82f6",
    color: "#fff",
    border: "1px solid #3b82f6",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  },
  panel: {
    marginBottom: 28,
    background: "#161b21",
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid #242c35",
  },
  panelHeader: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: 10,
    padding: "10px 14px",
    fontSize: 14,
  },
  panelDescription: { fontSize: 12, opacity: 0.65 },
  fovBadge: {
    marginLeft: "auto",
    fontSize: 13,
    fontWeight: 600,
    color: "#7dd3fc",
    whiteSpace: "nowrap",
  },
  viewer: {
    width: "100%",
    height: "70vh",
    cursor: "grab",
    background: "#000",
    touchAction: "none",
  },
  stats: {
    display: "flex",
    flexWrap: "wrap",
    gap: 18,
    padding: "8px 14px",
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#9fb3c8",
    background: "#0d1116",
  },
  error: {
    padding: "8px 14px",
    color: "#fca5a5",
    fontSize: 13,
  },
};
