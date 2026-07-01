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
import type { KorNoktaAttribution } from "./korNoktaScenes";
import { resolveAssetUrl, isCrossOriginUrl } from "../../lib/assetUrl";

interface Panorama360Props {
  src: string;
  className?: string;
  /** Gerçek dünya sahnelerinde dolu — köşede tıklanabilir atıf kredisi gösterilir. */
  attribution?: KorNoktaAttribution;
  /**
   * Dokuyu yatay olarak çevirir (yazılar düz okunur). Bu viewer küreyi
   * `BackSide` ile çiziyor ama three.js'in equirectangular reçetesindeki
   * `geometry.scale(-1,1,1)` adımını UYGULAMIYOR; sonuçta panorama yatayda
   * AYNALANIR. AI/tarihi sahnelerde fark edilmez (okunur tabela yok) ve onların
   * görünümü KORUNMALI olduğu için viewer'ı global düzeltmiyoruz. Gerçek dünya
   * (Panoramax) sahnelerinde tabela/alfabe önemli ipucu → yalnız onlarda
   * `mirrorX` ile aynalamayı geri alıyoruz. Görsel asset'e DOKUNULMAZ
   * (kaynağa sadık), düzeltme sadece dokuyu örneklerken yapılır.
   */
  mirrorX?: boolean;
}

function sourceLabel(source: KorNoktaAttribution["source"]): string {
  return source === "mapillary" ? "Mapillary" : "Panoramax";
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

export default function Panorama360({ src, className, attribution, mirrorX = false }: Panorama360Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Yükleme başarısızsa kullanıcı "Tekrar Dene" ile bu sayacı artırır → effect
  // yeniden çalışır, sahne baştan yüklenir (özellikle native'de remote asset
  // düşük bağlantıda ilk seferde düşerse kullanıcı kilitlenmez).
  const [reloadNonce, setReloadNonce] = useState(0);

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

    // Web'de relative path (same-origin) AYNEN; native'de Torble web origin'inden
    // mutlak HTTPS URL. Cross-origin ise CORS'lu iste (doku "tainted" olmasın).
    const resolvedSrc = resolveAssetUrl(src);
    const loader = new THREE.TextureLoader();
    if (isCrossOriginUrl(resolvedSrc)) {
      loader.setCrossOrigin("anonymous");
    }
    loader.load(
      resolvedSrc,
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
        if (mirrorX) {
          // Dokuyu U ekseninde ters örnekle (1 - u): kürenin BackSide aynalamasını
          // geri alır, yazılar düz okunur. wrapS=Repeat, 360 dikişinde zaten doğru.
          loaded.wrapS = THREE.RepeatWrapping;
          loaded.repeat.x = -1;
          loaded.offset.x = 1;
        }
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
        // Uzak (native) asset ise büyük olasılıkla bağlantı sorunu; yerelse ham
        // hata. Her durumda app çökmez — kullanıcı anlaşılır mesaj görür.
        const detail = err instanceof Error && err.message ? err.message : null;
        setLoadError(
          isCrossOriginUrl(resolvedSrc)
            ? "İnternet bağlantını kontrol edip tekrar dene."
            : detail || "Görsel yüklenemedi.",
        );
      },
    );

    // Aktif işaretçiler (fare/tek dokunuş → sürükle bak; iki dokunuş → pinch zoom).
    // Pointer Events kullanıldığı için fare ve dokunmatik tek kod yolundan işlenir;
    // canvas'ta CSS `touch-action: none` var (sayfa kaydırma/pinch ile çakışmaz).
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchPrevDist = 0;

    function getSensitivity() {
      return (view.fov * DEG2RAD) / Math.max(1, container?.clientHeight || 1);
    }

    function pinchDistance() {
      const pts = Array.from(pointers.values());
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    function onPointerDown(e: PointerEvent) {
      // Fare: yalnız sol tuş. Dokunmatik/kalem primary → button 0 (sorun değil).
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) pinchPrevDist = pinchDistance();
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    function onPointerMove(e: PointerEvent) {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // İki işaretçi → pinch zoom (FOV). Parmaklar açılınca yaklaş (fov küçülür).
      if (pointers.size >= 2) {
        const dist = pinchDistance();
        if (pinchPrevDist > 0 && dist > 0) {
          view.fov = clamp(view.fov + (pinchPrevDist - dist) * 0.2, MIN_FOV, MAX_FOV);
          updateCamera();
        }
        pinchPrevDist = dist;
        return;
      }

      // Tek işaretçi → sürükleyerek bak.
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      const sens = getSensitivity();
      view.yaw = normalizeYawDeg(view.yaw + dx * sens * RAD2DEG);
      view.pitch = clamp(view.pitch + dy * sens * RAD2DEG, MIN_PITCH_DEG, MAX_PITCH_DEG);
      updateCamera();
    }

    function onPointerUp(e: PointerEvent) {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size < 2) pinchPrevDist = 0;
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    function onPointerCancel(e: PointerEvent) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchPrevDist = 0;
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
  }, [src, mirrorX, reloadNonce]);

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
          <button
            type="button"
            className="kn-pano__retry"
            onClick={() => {
              setLoadError(null);
              setReloadNonce((n) => n + 1);
            }}
          >
            Tekrar Dene
          </button>
        </div>
      )}
      {attribution && isLoaded && (
        <a
          className="kn-pano__credit"
          href={attribution.attributionUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`${sourceLabel(attribution.source)} · ${attribution.license} · ${attribution.author}${attribution.captureDate ? ` · ${attribution.captureDate}` : ""} — kaynağı yeni sekmede aç`}
        >
          <span className="kn-pano__credit-src">{sourceLabel(attribution.source)}</span>
          <span className="kn-pano__credit-dot" aria-hidden="true">·</span>
          <span className="kn-pano__credit-lic">{attribution.license}</span>
          <span className="kn-pano__credit-author">
            <span className="kn-pano__credit-dot" aria-hidden="true">·</span>
            {attribution.author}
          </span>
        </a>
      )}
    </div>
  );
}
