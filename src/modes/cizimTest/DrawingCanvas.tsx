/**
 * DrawingCanvas.tsx — Çizim Test'in mouse-only çizim yüzeyi.
 *
 * Bilinçli olarak minimal: tek kalem (mürekkep rengi/kalınlığı sabit),
 * temizle dışında araç yok — amaç 10 saniyede hızlı ve komik çizim.
 * Kağıt dokusu kanvasın ALTINDAKİ .ct-paper katmanından gelir; kanvas
 * şeffaftır ve export edilen PNG de şeffaf kalır (kart yüzü kendi kağıt
 * zeminini verir).
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
    const drawingRef = useRef(false);
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

      // CSS ölçeklenmiş kanvasta mouse koordinatını iç çözünürlüğe çevir.
      const toLocal = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((e.clientX - rect.left) / rect.width) * DRAW_W,
          y: ((e.clientY - rect.top) / rect.height) * DRAW_H,
        };
      };

      const onDown = (e: MouseEvent) => {
        if (!enabledRef.current || e.button !== 0) return;
        drawingRef.current = true;
        const p = toLocal(e);
        lastRef.current = p;
        // Tek tık = nokta bırak (kısa süreli çizimlerde noktalar önemli).
        ctx.beginPath();
        ctx.arc(p.x, p.y, INK_WIDTH / 2, 0, Math.PI * 2);
        ctx.fillStyle = INK;
        ctx.fill();
      };

      const onMove = (e: MouseEvent) => {
        if (!drawingRef.current || !enabledRef.current) return;
        const last = lastRef.current;
        const p = toLocal(e);
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

      const stop = () => {
        drawingRef.current = false;
        lastRef.current = null;
      };

      canvas.addEventListener("mousedown", onDown);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", stop);
      canvas.addEventListener("mouseleave", () => {
        // Kanvas dışına çıkınca çizgiyi koparma ama son noktayı sıfırla ki
        // geri girişte sıçrama çizgisi oluşmasın.
        lastRef.current = null;
      });
      return () => {
        canvas.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", stop);
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
