/**
 * ConquestMapViewport — pinch / pan / double-tap layer for the Kuşatma map
 * on mobile.
 *
 * Wraps the map subtree in a clipped box and drives a CSS transform on an
 * inner layer.  The map component itself (TurkeyConquestMap) is untouched:
 * it keeps its authored viewBox, its region `onClick` handlers, and its
 * desktop behaviour, because this wrapper is only mounted from the mobile
 * branch of ConquestGame.  Nothing here knows about game rules.
 *
 * ── Why a CSS transform rather than a viewBox animation ──────────────────
 * Re-rendering the SVG on every pointer move would re-run TurkeyConquestMap's
 * per-region computation (24 regions × several layers) at touch frequency.
 * A transform on a wrapper div is composited, never re-renders React, and
 * keeps hit-testing correct — the browser maps pointer coordinates back
 * through the transform, so region taps still land on the right region at
 * any zoom level.  Labels and strokes scale with the map, which is what we
 * want: zooming in is how a player reads a crowded corner of the board.
 *
 * ── Pan vs. tap ──────────────────────────────────────────────────────────
 * The hard requirement is that dragging the board must never be read as a
 * move.  Two independent guards:
 *   1. A drag is only "real" past MOVE_SLOP px, so thumb jitter during a tap
 *      is not a pan.
 *   2. Once a gesture *has* panned or pinched, the click event that the
 *      browser synthesises afterwards is swallowed in the capture phase,
 *      before it can reach a region path.
 * A short, still touch therefore stays a selection; anything else does not.
 *
 * Panning is also disabled entirely at zoom 1 (the fit-to-screen view), so
 * the default board can never be dragged off into empty space.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode,
} from "react";

/** Zoom bounds. 1 = whole map fits the slot (the authored default view).
 *  MAX is tuned to the Türkiye board: at 3.2 the smallest regions
 *  (İstanbul, Hatay, Kilis) are comfortably thumb-sized on a 390px-wide
 *  phone without the label outlines breaking up. */
const MIN_SCALE = 1;
const MAX_SCALE = 3.2;
/** Where double-tap lands. Deliberately below MAX so a second double-tap
 *  still has somewhere to go before hitting the ceiling. */
const DOUBLE_TAP_SCALE = 2.1;

/** Pointer travel (px) past which a gesture stops being a tap. */
const MOVE_SLOP = 10;
/** Max ms a still touch can last and still count as a tap. */
const TAP_MAX_MS = 500;
/** Double-tap recognition window / max travel between the two taps. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 34;

interface Props {
  children: ReactNode;
  /** Turns the whole gesture layer off (kept mounted so the DOM is stable). */
  enabled?: boolean;
  /** Announced to the parent so HUD affordances can react to zoom. */
  onZoomChange?: (scale: number) => void;
}

interface Vec { x: number; y: number }

export default function ConquestMapViewport({
  children, enabled = true, onZoomChange,
}: Props) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  // Live transform. Kept in a ref (not state) so pointermove never re-renders.
  const tRef = useRef({ k: 1, x: 0, y: 0 });
  // Mirrored into state only when the *zoomed / not zoomed* bit flips, which
  // is all the UI needs in order to show or hide the reset control.
  const [zoomed, setZoomed] = useState(false);

  const pointersRef  = useRef(new Map<number, Vec>());
  const startRef     = useRef<{ t: number; p: Vec; k: number; x: number; y: number } | null>(null);
  const pinchRef     = useRef<{ dist: number; mid: Vec; k: number; x: number; y: number } | null>(null);
  const movedRef     = useRef(false);
  const swallowRef   = useRef(false);
  const lastTapRef   = useRef<{ t: number; p: Vec } | null>(null);

  /** Clamp translation so the scaled board always covers the viewport —
   *  the user can never drag the map away and stare at empty space. */
  const clamp = useCallback((k: number, x: number, y: number) => {
    const el = outerRef.current;
    if (!el) return { k, x, y };
    const w = el.clientWidth, h = el.clientHeight;
    const minX = w - w * k, minY = h - h * k;   // negative or 0
    return {
      k,
      x: k <= 1 ? 0 : Math.min(0, Math.max(minX, x)),
      y: k <= 1 ? 0 : Math.min(0, Math.max(minY, y)),
    };
  }, []);

  const paint = useCallback((animate = false) => {
    const el = innerRef.current;
    if (!el) return;
    const { k, x, y } = tRef.current;
    el.style.transition = animate
      ? "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)"
      : "none";
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
  }, []);

  const apply = useCallback((k: number, x: number, y: number, animate = false) => {
    const next = clamp(Math.min(MAX_SCALE, Math.max(MIN_SCALE, k)), x, y);
    const prevZoomed = tRef.current.k > 1.01;
    tRef.current = next;
    paint(animate);
    const nowZoomed = next.k > 1.01;
    if (nowZoomed !== prevZoomed) setZoomed(nowZoomed);
    onZoomChange?.(next.k);
  }, [clamp, paint, onZoomChange]);

  const reset = useCallback(() => apply(1, 0, 0, true), [apply]);

  /** Zoom about a viewport-relative anchor point, keeping the board content
   *  under the anchor fixed (standard focal zoom). */
  const zoomAt = useCallback((nextK: number, anchor: Vec, animate = false) => {
    const { k, x, y } = tRef.current;
    const clampedK = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextK));
    const ratio = clampedK / k;
    apply(clampedK, anchor.x - (anchor.x - x) * ratio, anchor.y - (anchor.y - y) * ratio, animate);
  }, [apply]);

  // Re-fit whenever the slot resizes (rotation, keyboard, dock collapse).
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const { k, x, y } = tRef.current;
      apply(k, x, y);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [apply]);

  // Drop any zoom when the layer is switched off so the next enable starts fit.
  useEffect(() => {
    if (!enabled && tRef.current.k !== 1) reset();
  }, [enabled, reset]);

  const localPoint = (e: PointerEvent | React.PointerEvent): Vec => {
    const r = outerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled) return;
    const pts = pointersRef.current;
    pts.set(e.pointerId, localPoint(e));
    // Capture keeps a drag alive when the finger leaves the board's box.
    // It throws for pointer ids the UA doesn't know (synthetic events in
    // tests, and some WebView edge cases) — losing capture degrades the
    // gesture, it must never break the board.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* no capture */ }

    if (pts.size === 1) {
      const p = localPoint(e);
      const { k, x, y } = tRef.current;
      startRef.current = { t: Date.now(), p, k, x, y };
      movedRef.current = false;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const { k, x, y } = tRef.current;
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid:  { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        k, x, y,
      };
      // A second finger always means "this is a gesture, not a tap".
      movedRef.current = true;
      swallowRef.current = true;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!enabled) return;
    const pts = pointersRef.current;
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, localPoint(e));

    if (pts.size >= 2 && pinchRef.current) {
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const p = pinchRef.current;
      const nextK = Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.k * (dist / p.dist)));
      const ratio = nextK / p.k;
      // Focal zoom about the *initial* midpoint, plus the midpoint drift so
      // a two-finger drag pans at the same time as it scales.
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      apply(
        nextK,
        mid.x - (p.mid.x - p.x) * ratio,
        mid.y - (p.mid.y - p.y) * ratio,
      );
      return;
    }

    const start = startRef.current;
    if (!start || pts.size !== 1) return;
    const p = localPoint(e);
    const dx = p.x - start.p.x, dy = p.y - start.p.y;
    if (!movedRef.current && Math.hypot(dx, dy) > MOVE_SLOP) {
      movedRef.current = true;
      // Suppress the follow-up click for ANY real drag, including one at fit
      // scale where the board cannot pan. The gesture being inert does not
      // make it a selection: a thumb that slid 30px across the board before
      // lifting is not the player choosing that region, and treating it as
      // one costs them their move for the round.
      swallowRef.current = true;
    }
    if (movedRef.current && start.k > 1) {
      apply(start.k, start.x + dx, start.y + dy);
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    const pts = pointersRef.current;
    pts.delete(e.pointerId);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* never captured */ }

    if (pts.size < 2) pinchRef.current = null;
    if (pts.size > 0) return;

    const start = startRef.current;
    startRef.current = null;
    if (!enabled || !start) return;

    const stillATap = !movedRef.current && Date.now() - start.t < TAP_MAX_MS;
    if (!stillATap) return;

    // Double-tap → toggle between fit and a readable close-up, anchored on
    // the tapped point so the region under the thumb stays under the thumb.
    const now = Date.now();
    const prev = lastTapRef.current;
    const p = { x: e.clientX, y: e.clientY };
    const r = outerRef.current!.getBoundingClientRect();
    const local = { x: p.x - r.left, y: p.y - r.top };
    if (
      prev && now - prev.t < DOUBLE_TAP_MS
      && Math.hypot(p.x - prev.p.x, p.y - prev.p.y) < DOUBLE_TAP_SLOP
    ) {
      lastTapRef.current = null;
      swallowRef.current = true;          // the 2nd tap must not select a region
      if (tRef.current.k > 1.01) reset();
      else zoomAt(DOUBLE_TAP_SCALE, local, true);
      return;
    }
    lastTapRef.current = { t: now, p };
  };

  // Swallow the synthetic click that follows a pan / pinch / double-tap, in
  // the capture phase so it never reaches a region path.
  const onClickCapture = (e: React.MouseEvent) => {
    if (!swallowRef.current) return;
    // The viewport's own chrome must stay clickable. Without this, the tap
    // that pans the board arms the swallow flag and the very next tap — the
    // one on "fit to screen" — is eaten, so the control silently needs two
    // presses. The flag exists to protect region selection, nothing else.
    if (e.target instanceof Element && e.target.closest("[data-mapvp-control]")) {
      return;
    }
    swallowRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // Trackpad / mouse wheel zoom. Not a phone gesture, but it makes the
  // behaviour inspectable in a desktop browser during development and costs
  // nothing at runtime.
  const onWheel = (e: React.WheelEvent) => {
    if (!enabled) return;
    e.preventDefault();
    const r = outerRef.current!.getBoundingClientRect();
    zoomAt(
      tRef.current.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12),
      { x: e.clientX - r.left, y: e.clientY - r.top },
    );
  };

  return (
    <div
      className="mcq-mapvp"
      ref={outerRef}
      data-zoomed={zoomed ? "true" : undefined}
      data-enabled={enabled ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      /* If capture is lost (or was never granted), the browser stops
         delivering pointerup here and the id would stay in the map — the
         next touch would then look like a second finger and start a phantom
         pinch. Treat losing capture as the gesture ending. */
      onLostPointerCapture={endPointer}
      onClickCapture={onClickCapture}
      onWheel={onWheel}
    >
      <div className="mcq-mapvp-inner" ref={innerRef}>
        {children}
      </div>
      {zoomed && (
        <button
          type="button"
          className="mcq-mapvp-reset"
          data-mapvp-control=""
          onClick={reset}
          aria-label="Haritayı sığdır"
          title="Haritayı sığdır"
        >
          <span aria-hidden="true">⤢</span>
        </button>
      )}
    </div>
  );
}
