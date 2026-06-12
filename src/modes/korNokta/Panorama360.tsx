/**
 * Panorama360 — Kör Nokta için 360 equirectangular panorama viewer.
 *
 * HaritaDedektifiGame içindeki viewer effect'in bağımsız kopyasıdır
 * (oradaki kod tek dosyalık oyun akışına gömülü; Kör Nokta'nın faz bazlı
 * mount/unmount ihtiyacı için ayrı bileşen gerekti — mevcut moda
 * DOKUNULMADI). Görsel hiçbir resize/canvas/yeniden encode adımından
 * geçmez: imagePath doğrudan THREE.TextureLoader'a verilir.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

interface Panorama360Props {
  src: string;
  className?: string;
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

export default function Panorama360({ src, className }: Panorama360Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
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

    const view = { yaw: 0, pitch: 0, fov: DEFAULT_FOV };

    let texture: THREE.Texture | null = null;
    let disposed = false;
    let rafId = 0;

    function updateCamera() {
      yawPitchDegToDirection(view.yaw, view.pitch, forward);
      target.copy(camera.position).add(forward);
      camera.lookAt(target);
      camera.fov = view.fov;
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
      src,
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
      return (view.fov * DEG2RAD) / Math.max(1, container?.clientHeight || 1);
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
      view.yaw = normalizeYawDeg(view.yaw + dx * sens * RAD2DEG);
      view.pitch = clamp(view.pitch + dy * sens * RAD2DEG, MIN_PITCH_DEG, MAX_PITCH_DEG);
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
      view.fov = clamp(view.fov + e.deltaY * 0.05, MIN_FOV, MAX_FOV);
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
  }, [src]);

  return (
    <div className={"kn-pano" + (className ? ` ${className}` : "")}>
      <div ref={containerRef} className="kn-pano__canvas" />
      {!isLoaded && !loadError && (
        <div className="kn-pano__overlay">
          <div className="kn-pano__spinner" />
          <span>Sahne yükleniyor…</span>
        </div>
      )}
      {loadError && (
        <div className="kn-pano__overlay kn-pano__overlay--error">
          <strong>Sahne yüklenemedi</strong>
          <span>{loadError}</span>
        </div>
      )}
    </div>
  );
}
