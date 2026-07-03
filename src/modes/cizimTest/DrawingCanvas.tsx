/**
 * DrawingCanvas.tsx — Çizim Test'in çizim yüzeyi (mouse + dokunmatik + kalem).
 *
 * Bilinçli olarak minimal: tek kalem (mürekkep rengi/kalınlığı sabit),
 * temizle dışında araç yok — amaç 10 saniyede hızlı ve komik çizim.
 * Kağıt dokusu kanvasın ALTINDAKİ .ct-paper katmanından gelir; kanvas
 * şeffaftır ve export edilen PNG de şeffaf kalır (kart yüzü kendi kağıt
 * zeminini verir).
 *
 * Giriş TEK yoldan, Pointer Events'ten yürür (mouse/touch/pen ortak mantık):
 *   - Yalnız BİR aktif pointer çizer (activePointerId); multi-touch'ta ikinci
 *     parmak stroke başlatamaz, birincil olmayan pointer'lar yok sayılır.
 *   - setPointerCapture ile parmak/mouse kanvas sınırından çıksa da move/up
 *     olayları kanvasa akmaya devam eder — stroke yarım kalmaz, kenar dışı
 *     segmentler kanvas sınırında doğal kırpılır.
 *   - Kaydırma/zoom engeli CSS'ten gelir (.ct-canvas { touch-action: none });
 *     kanvas dışındaki alanlarda sayfa normal kayar.
 *   - getCoalescedEvents (varsa) yüksek frekanslı ara noktaları da işler;
 *     dokunmatikte çizgi köşeli değil akıcı çıkar.
 *
 * Export: broadcast payload'ı küçük tutmak için sabit ölçekli (240×180)
 * offscreen kanvasa indirgenip PNG data-URL döner (çizgi sanatı ~3-10 KB).
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export const DRAW_W = 480;
export const DRAW_H = 360;
const EXPORT_W = 240;
const EXPORT_H = 180;
const INK = "#233050";
const INK_WIDTH = 4.5;

export interface DrawingCanvasHandle {
  clear: () => void;
  /** Şeffaf zeminli, küçültülmüş PNG data-URL. Boş kanvasta da geçerli PNG döner. */
  exportPng: () => string;
}

interface DrawingCanvasProps {
  /** false iken çizim girişleri yok sayılır (tur arası kilit). */
  enabled: boolean;
}

export const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(
  function DrawingCanvas({ enabled }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const lastRef = useRef<{ x: number; y: number } | null>(null);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    useImperativeHandle(ref, () => ({
      clear() {
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, DRAW_W, DRAW_H);
      },
      exportPng() {
        const src = canvasRef.current;
        const out = document.createElement("canvas");
        out.width = EXPORT_W;
        out.height = EXPORT_H;
        const ctx = out.getContext("2d");
        if (ctx && src) {
          ctx.drawImage(src, 0, 0, EXPORT_W, EXPORT_H);
        }
        return out.toDataURL("image/png");
      },
    }));

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = INK;
      ctx.lineWidth = INK_WIDTH;

      // CSS ölçeklenmiş kanvasta pointer koordinatını iç çözünürlüğe çevir.
      // Rect-oran haritalaması responsive genişlik / DPR / safe-area / viewport
      // değişimlerinden bağımsız doğru kalır (iç çözünürlük sabit 480×360).
      const toLocal = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((clientX - rect.left) / rect.width) * DRAW_W,
          y: ((clientY - rect.top) / rect.height) * DRAW_H,
        };
      };

      // Aktif stroke'un pointer'ı; null = çizim yok. Tek pointer kuralının
      // tek kaynağı — ikinci parmak/pointer down'ları burada elenir.
      let activePointerId: number | null = null;

      const drawSegment = (clientX: number, clientY: number) => {
        const last = lastRef.current;
        const p = toLocal(clientX, clientY);
        if (!last) {
          lastRef.current = p;
          return;
        }
        // Orta-nokta quadratic yumuşatma — ham segmentlerden daha akıcı.
        const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        lastRef.current = p;
      };

      const onDown = (e: PointerEvent) => {
        if (!enabledRef.current) return;
        if (activePointerId !== null) return; // zaten çizen bir pointer var
        if (!e.isPrimary) return; // multi-touch'ta ikincil parmaklar çizemez
        if (e.pointerType === "mouse" && e.button !== 0) return;
        activePointerId = e.pointerId;
        // Capture: parmak kanvas dışına taşsa da move/up buraya akar.
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* kapatılmış pointer (nadir yarış) — capture'sız devam */
        }
        e.preventDefault();
        const p = toLocal(e.clientX, e.clientY);
        lastRef.current = p;
        // Tek tık/dokunuş = nokta bırak (kısa süreli çizimlerde noktalar önemli).
        ctx.beginPath();
        ctx.arc(p.x, p.y, INK_WIDTH / 2, 0, Math.PI * 2);
        ctx.fillStyle = INK;
        ctx.fill();
      };

      const onMove = (e: PointerEvent) => {
        if (e.pointerId !== activePointerId || !enabledRef.current) return;
        // Coalesced olaylar (varsa) dokunmatikte frame arası ara noktaları verir.
        const points: { clientX: number; clientY: number }[] =
          typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length
            ? e.getCoalescedEvents()
            : [e];
        for (const p of points) drawSegment(p.clientX, p.clientY);
      };

      const endStroke = (e: PointerEvent) => {
        if (e.pointerId !== activePointerId) return;
        activePointerId = null;
        lastRef.current = null;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* capture zaten düşmüş */
        }
      };

      // Long-press menüsü (Android/iOS) stroke'u kesmesin.
      const onContextMenu = (e: Event) => e.preventDefault();

      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", endStroke);
      canvas.addEventListener("pointercancel", endStroke);
      canvas.addEventListener("lostpointercapture", endStroke);
      canvas.addEventListener("contextmenu", onContextMenu);
      return () => {
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", endStroke);
        canvas.removeEventListener("pointercancel", endStroke);
        canvas.removeEventListener("lostpointercapture", endStroke);
        canvas.removeEventListener("contextmenu", onContextMenu);
      };
    }, []);

    return (
      <canvas
        ref={canvasRef}
        className="ct-canvas"
        width={DRAW_W}
        height={DRAW_H}
        aria-label="Çizim alanı"
      />
    );
  },
);
