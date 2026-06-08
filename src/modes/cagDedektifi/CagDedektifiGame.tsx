import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { CAG_DEDEKTIFI_SCENES, type CagDedektifiScene } from "./cagDedektifiScenes";
import { playSound } from "../../lib/sound";
import "./CagDedektifiGame.css";

type GameStatus = "playing" | "won" | "lost";

interface CagDedektifiGameProps {
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
const CLICK_DRAG_THRESHOLD_PX = 6;

function angularDistanceDeg(yawADeg: number, pitchADeg: number, yawBDeg: number, pitchBDeg: number) {
  const p1 = pitchADeg * DEG2RAD;
  const p2 = pitchBDeg * DEG2RAD;
  let dYaw = (yawADeg - yawBDeg) * DEG2RAD;
  while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
  while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
  const cosD = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dYaw);
  return Math.acos(Math.min(1, Math.max(-1, cosD))) * RAD2DEG;
}

function normalizeYawDeg(deg: number) {
  let v = deg % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// Convert a unit direction vector to (yaw, pitch) in degrees.
// Convention used here:
//   yaw  = 0,  pitch = 0  → +X axis (texture center of equirectangular sphere)
//   yaw  > 0 sweeps toward -Z
//   pitch > 0 looks up (+Y)
function directionToYawPitchDeg(dir: THREE.Vector3) {
  const v = dir.clone().normalize();
  const pitch = Math.asin(clamp(v.y, -1, 1));
  const yaw = Math.atan2(-v.z, v.x);
  return { yawDeg: normalizeYawDeg(yaw * RAD2DEG), pitchDeg: pitch * RAD2DEG };
}

function yawPitchDegToDirection(yawDeg: number, pitchDeg: number, out: THREE.Vector3) {
  const yaw = yawDeg * DEG2RAD;
  const pitch = pitchDeg * DEG2RAD;
  const cp = Math.cos(pitch);
  out.set(cp * Math.cos(yaw), Math.sin(pitch), -cp * Math.sin(yaw));
  return out;
}

export default function CagDedektifiGame({ onHome }: CagDedektifiGameProps) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const scene: CagDedektifiScene = CAG_DEDEKTIFI_SCENES[sceneIndex];

  const [timeLeft, setTimeLeft] = useState(scene.timeLimitSeconds);
  const [wrongClicks, setWrongClicks] = useState(0);
  const [score, setScore] = useState(0);
  const [status, setStatus] = useState<GameStatus>("playing");
  const [feedback, setFeedback] = useState("Sürükleyerek etrafına bak. Şüpheli detaya tıkla.");
  const [debugClick, setDebugClick] = useState<{ yaw: number; pitch: number } | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const debugMode = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).has("debugCag");
    } catch {
      return false;
    }
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const fovRef = useRef(DEFAULT_FOV);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const resetViewRef = useRef<() => void>(() => {});
  const clickHandlerRef = useRef<(yawDeg: number, pitchDeg: number) => void>(() => {});

  // Always keep latest game state available to the single viewer click listener.
  useEffect(() => {
    clickHandlerRef.current = (clickYawDeg: number, clickPitchDeg: number) => {
      if (status !== "playing") return;

      const yawNorm = normalizeYawDeg(clickYawDeg);

      if (debugMode) {
        // eslint-disable-next-line no-console
        console.log(
          `[CagDedektifi] click yaw=${yawNorm.toFixed(2)}° pitch=${clickPitchDeg.toFixed(2)}°`,
        );
        setDebugClick({ yaw: yawNorm, pitch: clickPitchDeg });
      }

      const dist = angularDistanceDeg(
        yawNorm,
        clickPitchDeg,
        scene.target.yaw,
        scene.target.pitch,
      );

      if (dist <= scene.target.radius) {
        const timeBonus = Math.max(0, timeLeft * 10);
        const wrongPenalty = wrongClicks * scene.wrongClickPenalty;
        const finalScore = Math.max(0, scene.correctBaseScore + timeBonus - wrongPenalty);
        playSound("correct");
        setScore(finalScore);
        setStatus("won");
        setFeedback(`Doğru cevap: ${scene.target.label}`);
        return;
      }

      playSound("wrong");
      const next = wrongClicks + 1;
      setWrongClicks(next);
      if (next >= scene.maxWrongClicks) {
        setStatus("lost");
        setFeedback("3 yanlış tık hakkın doldu.");
      } else {
        setFeedback(`Yanlış bölge. Kalan yanlış hakkı: ${scene.maxWrongClicks - next}`);
      }
    };
  }, [status, timeLeft, wrongClicks, debugMode, scene]);

  // Custom Three.js panorama viewer — built once per panorama URL.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setIsLoaded(false);
    setLoadError(null);

    // eslint-disable-next-line no-console
    console.log("[CagDedektifi] viewer init", scene.panorama);

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
    cameraRef.current = camera;

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

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const forward = new THREE.Vector3();
    const target = new THREE.Vector3();

    // Reset view state.
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
        // eslint-disable-next-line no-console
        console.log(
          `[CagDedektifi] panorama loaded ${loaded.image?.width}x${loaded.image?.height} anisotropy=${maxAnisotropy}`,
        );
        setIsLoaded(true);
      },
      undefined,
      (err) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : "Bilinmeyen hata";
        // eslint-disable-next-line no-console
        console.error("[CagDedektifi] panorama error", err);
        setLoadError(message);
      },
    );

    // ── Drag controls ────────────────────────────────────────────
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;
    let moved = false;
    let activePointerId: number | null = null;

    function getSensitivity() {
      // Sensitivity scales with FOV so panning feels consistent across zoom levels.
      return (fovRef.current * DEG2RAD) / Math.max(1, container?.clientHeight || 1);
    }

    function onPointerDown(e: PointerEvent) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      moved = false;
      activePointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      downX = e.clientX;
      downY = e.clientY;
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

      if (Math.abs(e.clientX - downX) > CLICK_DRAG_THRESHOLD_PX ||
          Math.abs(e.clientY - downY) > CLICK_DRAG_THRESHOLD_PX) {
        moved = true;
      }

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

      if (!moved) {
        handleClick(e.clientX, e.clientY);
      }
    }

    function onPointerCancel() {
      dragging = false;
      activePointerId = null;
      moved = false;
    }

    function handleClick(clientX: number, clientY: number) {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length === 0) return;
      const dir = hits[0].point.clone().sub(camera.position);
      const { yawDeg, pitchDeg } = directionToYawPitchDeg(dir);
      clickHandlerRef.current(yawDeg, pitchDeg);
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      // Positive deltaY = scroll down = zoom out (wider FOV).
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

    resetViewRef.current = () => {
      yawRef.current = 0;
      pitchRef.current = 0;
      fovRef.current = DEFAULT_FOV;
      updateCamera();
    };

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
      cameraRef.current = null;
      resetViewRef.current = () => {};
      // eslint-disable-next-line no-console
      console.log("[CagDedektifi] viewer destroyed");
    };
  }, [scene.panorama]);

  useEffect(() => {
    if (!isLoaded) return;
    if (status !== "playing") return;
    if (timeLeft <= 0) {
      setStatus("lost");
      setFeedback("Süre doldu. Anakronizmi bulamadın.");
      return;
    }
    const timer = window.setTimeout(() => setTimeLeft((v) => v - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [isLoaded, status, timeLeft]);

  function resetGame() {
    const nextIndex = (sceneIndex + 1) % CAG_DEDEKTIFI_SCENES.length;
    const nextScene = CAG_DEDEKTIFI_SCENES[nextIndex];
    setSceneIndex(nextIndex);
    setTimeLeft(nextScene.timeLimitSeconds);
    setWrongClicks(0);
    setScore(0);
    setStatus("playing");
    setFeedback("Sürükleyerek etrafına bak. Şüpheli detaya tıkla.");
    setDebugClick(null);
    resetViewRef.current();
  }

  const { yearLabel, eventLabel } = useMemo(() => {
    const match = scene.title.match(/^(\d{3,4})\s*(.*)$/);
    if (match) {
      return { yearLabel: match[1], eventLabel: match[2].trim() };
    }
    return { yearLabel: "", eventLabel: scene.title };
  }, [scene.title]);

  return (
    <div className="cag-screen">
      <div ref={containerRef} className="cag-viewer" />

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
        <span className="cag-brand" aria-hidden="true">Çağ Dedektifi</span>
      </div>

      <div className="cag-overlay cag-overlay--top-right">
        <div className="cag-chip" title="Kalan süre">
          <span className="cag-chip-icon" aria-hidden="true">⏱</span>
          <span className="cag-chip-value">{timeLeft}s</span>
        </div>
        <div className="cag-chip" title="Yanlış tık">
          <span className="cag-chip-icon" aria-hidden="true">✕</span>
          <span className="cag-chip-value">{wrongClicks}/{scene.maxWrongClicks}</span>
        </div>
        <div className="cag-chip" title="Skor">
          <span className="cag-chip-icon" aria-hidden="true">🏆</span>
          <span className="cag-chip-value">{score}</span>
        </div>
      </div>

      {(yearLabel || eventLabel) && (
        <div className="cag-overlay cag-overlay--top-center">
          <div className="cag-info-chip">
            {yearLabel && <span className="cag-info-year">{yearLabel}</span>}
            {yearLabel && eventLabel && <span className="cag-info-sep" aria-hidden="true">·</span>}
            {eventLabel && <span className="cag-info-event">{eventLabel}</span>}
          </div>
        </div>
      )}

      <div className="cag-overlay cag-overlay--bottom-left">
        <div className="cag-hint">
          <span className="cag-hint-dot" aria-hidden="true" />
          <span className="cag-hint-text">
            Sürükleyerek etrafına bak. Burada bu zamana ait olmayan bir şey var.
          </span>
        </div>
        <div className="cag-feedback">{feedback}</div>
      </div>

      {debugMode && (
        <div className="cag-overlay cag-overlay--bottom-right">
          <div className="cag-debug-panel">
            <strong>DEBUG</strong>
            <div>loaded: {String(isLoaded)}</div>
            <div>target yaw: {scene.target.yaw.toFixed(2)}°</div>
            <div>target pitch: {scene.target.pitch.toFixed(2)}°</div>
            <div>target radius: {scene.target.radius}°</div>
            <hr />
            {debugClick ? (
              <>
                <div>click yaw: {debugClick.yaw.toFixed(2)}°</div>
                <div>click pitch: {debugClick.pitch.toFixed(2)}°</div>
              </>
            ) : (
              <div>(henüz tık yok)</div>
            )}
          </div>
        </div>
      )}

      {status !== "playing" && (
        <div className="cag-result-backdrop">
          <section className="cag-result" role="dialog" aria-modal="true">
            <h2>{status === "won" ? "Vaka çözüldü." : "Vaka çözülemedi."}</h2>
            <p><strong>Doğru cevap:</strong> {scene.target.label}</p>
            <p>{scene.explanation}</p>
            {status === "won" && <p><strong>Skor:</strong> {score}</p>}

            <div className="cag-actions">
              <button className="cag-primary" onClick={resetGame}>Tekrar Oyna</button>
              <button className="cag-secondary" onClick={onHome}>Ana Menü</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
