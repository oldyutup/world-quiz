import { useEffect, useRef, useState, useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  geoNaturalEarth1, geoPath,
} from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, Geometry, Feature } from "geojson";
import { TOPOID_TO_DISPLAY } from "../data/countries";

/* ─────────────────────────────────────────────────
   SHARED TOPO CACHE
   Both WorldMap and SilhouetteView share one fetch.
───────────────────────────────────────────────── */
const WORLD_URL  = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
let   _topoCache: Feature<Geometry>[] | null = null;
const _topoWaiters: Array<(f: Feature<Geometry>[]) => void> = [];

function loadTopo(): Promise<Feature<Geometry>[]> {
  return new Promise(resolve => {
    if (_topoCache) { resolve(_topoCache); return; }
    _topoWaiters.push(resolve);
    if (_topoWaiters.length > 1) return; // already fetching
    fetch(WORLD_URL)
      .then(r => r.json())
      .then((topo: Topology) => {
        const fc = feature(topo, topo.objects.countries as GeometryCollection) as FeatureCollection<Geometry>;
        _topoCache = fc.features as Feature<Geometry>[];
        _topoWaiters.forEach(fn => fn(_topoCache!));
        _topoWaiters.length = 0;
      });
  });
}

/* ═══════════════════════════════════════════════════════════════
   WORLD MAP
═══════════════════════════════════════════════════════════════ */
interface MapProps {
  guessedISOs: Set<string>;
  lastGuessed: string | null;
  showLabels:  boolean;
  activeIds:   Set<string>;
  resetKey:    number;
  region?:     string;
  /** Optional click handler — opt-in. When omitted, paths render without onClick (legacy behaviour). */
  onCountryClick?: (topoId: string) => void;
  /** Optional id to flash red — used by Wheel Mode. */
  wrongId?: string;
}

interface ComputedFeature {
  id: string; d: string; area: number; cx: number; cy: number; display: string;
}

const MIN_LABEL = 120;

/** Manual label offsets for countries whose centroid is pulled off mainland by overseas territories.
 *  Values are projected SVG units at k=1. */
const LABEL_OFFSET: Record<string, [number, number]> = {
  "250": [17, -10], // Fransa — centroid pulled SW by overseas territories
};
const ZOOM_MIN  = 1;
const ZOOM_MAX  = 12;
const ZOOM_STEP = 1.4;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Compute the transform {k, tx, ty} that fits all countries in activeIds
 * into the viewport (w × h) with padding. Returns null for world/no scope.
 */
function fitRegion(
  activeIds: Set<string>,
  computed: ComputedFeature[],
  w: number,
  h: number,
): { k: number; tx: number; ty: number } | null {
  if (!activeIds.size) return null;
  const inScope = computed.filter(cf => activeIds.has(cf.id) && cf.cx !== 0);
  if (!inScope.length) return null;

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const cf of inScope) {
    const r = Math.sqrt(cf.area) * 0.55;
    x0 = Math.min(x0, cf.cx - r);
    y0 = Math.min(y0, cf.cy - r);
    x1 = Math.max(x1, cf.cx + r);
    y1 = Math.max(y1, cf.cy + r);
  }
  if (!isFinite(x0) || !isFinite(y0)) return null;

  const PAD = 40;
  const bw  = x1 - x0;
  const bh  = y1 - y0;
  if (bw < 1 || bh < 1) return null;

  const k  = clamp(Math.min((w - PAD * 2) / bw, (h - PAD * 2) / bh), ZOOM_MIN, ZOOM_MAX);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { k, tx: w / 2 - cx * k, ty: h / 2 - cy * k };
}

export default function WorldMap({ guessedISOs, lastGuessed, showLabels, activeIds, resetKey, region, onCountryClick, wrongId }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef       = useRef<SVGSVGElement>(null);
  const rawRef       = useRef<Feature<Geometry>[]>([]);

  const [computed, setComputed] = useState<ComputedFeature[]>([]);
  const [dims, setDims]         = useState({ w: 960, h: 500 });
  const [loading, setLoading]   = useState(true);

  const xfRef   = useRef({ k: 1, tx: 0, ty: 0 });
  const [xf, setXf] = useState({ k: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const projectedDimsRef = useRef({ w: 0, h: 0 });
  // Track pointer movement so a drag never fires onCountryClick.
  // Stays harmless when onCountryClick is undefined.
  const wasDragRef = useRef(false);
  const downPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 10 && height > 10)
      setDims(prev => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    loadTopo().then(features => { rawRef.current = features; setLoading(false); });
  }, []);

  useEffect(() => {
    const features = rawRef.current;
    if (loading || !features.length || dims.w === 0) return;
    if (projectedDimsRef.current.w === dims.w && projectedDimsRef.current.h === dims.h) return;
    projectedDimsRef.current = { w: dims.w, h: dims.h };

    const proj = geoNaturalEarth1().scale(dims.w / 6.2).translate([dims.w / 2, dims.h / 2]);
    const pg   = geoPath(proj);
    const next: ComputedFeature[] = [];
    features.forEach(f => {
      const id = String((f as Feature & { id?: unknown }).id ?? "");
      const d  = pg(f);
      if (!d) return;
      const area     = pg.area(f);
      const [cx, cy] = pg.centroid(f);
      next.push({ id, d, area, cx: isNaN(cx) ? 0 : cx, cy: isNaN(cy) ? 0 : cy, display: TOPOID_TO_DISPLAY[id] ?? "" });
    });
    setComputed(next);
  }, [loading, dims]);

  useEffect(() => {
    if (resetKey === 0) return;
    const reset = { k: 1, tx: 0, ty: 0 };
    xfRef.current = reset;
    setXf(reset);
  }, [resetKey]);

  // Auto-zoom to fit the selected region whenever region or layout changes
  useEffect(() => {
    if (!region || region === "world" || computed.length === 0 || dims.w === 0) return;
    const fit = fitRegion(activeIds, computed, dims.w, dims.h);
    if (!fit) return;
    xfRef.current = fit;
    setXf({ ...fit });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, activeIds, computed, dims]);

  const applyZoom = useCallback((newK: number, focalX?: number, focalY?: number) => {
    const old = xfRef.current;
    const k   = clamp(newK, ZOOM_MIN, ZOOM_MAX);
    const fx  = focalX ?? dims.w / 2;
    const fy  = focalY ?? dims.h / 2;
    const ratio = k / old.k;
    const maxP  = dims.w * (k - 1) * 0.6 + dims.w * 0.3;
    const next  = { k, tx: clamp(fx - ratio*(fx-old.tx), -maxP, maxP), ty: clamp(fy - ratio*(fy-old.ty), -maxP, maxP) };
    xfRef.current = next; setXf({ ...next });
  }, [dims]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      applyZoom(xfRef.current.k * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [applyZoom]);

  const onPD = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, tx0: xfRef.current.tx, ty0: xfRef.current.ty };
    wasDragRef.current = false;
    downPosRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPM = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    if (!wasDragRef.current) {
      const dx = Math.abs(e.clientX - downPosRef.current.x);
      const dy = Math.abs(e.clientY - downPosRef.current.y);
      if (dx + dy > 5) wasDragRef.current = true;
    }
    const { k } = xfRef.current;
    const maxP  = dims.w * (k - 1) * 0.6 + dims.w * 0.3;
    const next  = { k, tx: clamp(dragRef.current.tx0+e.clientX-dragRef.current.sx,-maxP,maxP), ty: clamp(dragRef.current.ty0+e.clientY-dragRef.current.sy,-maxP,maxP) };
    xfRef.current = next; setXf({ ...next });
  };
  const onPU = (e: ReactPointerEvent<SVGSVGElement>) => {
    // Click dispatch via pointerup: setPointerCapture on the SVG redirects
    // pointer events to the SVG, which can prevent the synthesized `click`
    // from firing on the underlying <path>. We resolve the path the user
    // released over via elementFromPoint and read data-topo-id.
    //
    // No-op when onCountryClick is not provided → legacy behaviour unchanged.
    if (
      onCountryClick &&
      e.type === "pointerup" &&
      e.button === 0 &&
      !wasDragRef.current
    ) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el instanceof SVGPathElement) {
        const topoId = el.getAttribute("data-topo-id");
        if (topoId) onCountryClick(topoId);
      }
    }
    dragRef.current = null;
  };

  if (loading || computed.length === 0) {
    return (
      <div ref={containerRef} className="map-container-inner">
        <div className="map-loading"><div className="spinner" /><span>Harita yükleniyor…</span></div>
      </div>
    );
  }

  const cssTransform = `translate(${xf.tx}px,${xf.ty}px) scale(${xf.k})`;
  const labelScale   = 1 / xf.k;

  return (
    <div ref={containerRef} className="map-container-inner">
      <svg ref={svgRef} viewBox={`0 0 ${dims.w} ${dims.h}`} className="world-svg"
        style={{ width: "100%", height: "100%", cursor: dragRef.current ? "grabbing" : "grab" }}
        aria-label="Dünya haritası"
        onPointerDown={onPD} onPointerMove={onPM} onPointerUp={onPU} onPointerCancel={onPU}
      >
        <rect width={dims.w} height={dims.h} fill="var(--ocean)" />
        <g style={{ transform: cssTransform, transformOrigin: "0 0" }}>
          {computed.map(cf => {
            const inScope   = activeIds.has(cf.id);
            const isGuessed = guessedISOs.has(cf.id);
            const isLast    = cf.id === lastGuessed;
            const isWrong   = wrongId === cf.id;
            return (
              <path key={cf.id + cf.d.slice(1, 8)} d={cf.d}
                data-topo-id={cf.id}
                className={["country-path",!inScope?"out-of-scope":"",isGuessed?"guessed":"",isLast?"last":"",isWrong?"wheel-wrong":""].filter(Boolean).join(" ")}
                style={onCountryClick ? { cursor: "pointer" } : undefined}
              />
            );
          })}
          {showLabels && computed
            .filter(cf => guessedISOs.has(cf.id) && cf.display && cf.area >= MIN_LABEL && cf.cx !== 0)
            .map(cf => {
              const base = Math.min(11, Math.max(5, Math.sqrt(cf.area) * 0.27));
              return (
                <g key={"lbl-"+cf.id} transform={`translate(${cf.cx + (LABEL_OFFSET[cf.id]?.[0] ?? 0)},${cf.cy + (LABEL_OFFSET[cf.id]?.[1] ?? 0)})`}>
                  <text textAnchor="middle" dominantBaseline="central" fontSize={base*labelScale}
                    className={"country-label"+(cf.id===lastGuessed?" label-last":"")}>
                    {cf.display}
                  </text>
                </g>
              );
            })}
        </g>
      </svg>
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={() => applyZoom(xfRef.current.k * ZOOM_STEP)} aria-label="Yakınlaştır">+</button>
        <div className="zoom-divider" />
        <button className="zoom-btn" onClick={() => applyZoom(xfRef.current.k / ZOOM_STEP)} aria-label="Uzaklaştır">&#8722;</button>
      </div>
      <div className="map-hint">Sürükle: hareket &nbsp;|&nbsp; Scroll: zoom</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SILHOUETTE VIEW
   Renders ONE country's outline, fit to container, no decorations.
═══════════════════════════════════════════════════════════════ */
export interface SilhouetteProps {
  topoId: string;
  flash:  "correct" | "wrong" | null;
}

export function SilhouetteView({ topoId, flash }: SilhouetteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [silPath,  setSilPath]  = useState<string>("");
  const [vbox,     setVbox]     = useState("0 0 400 300");
  const [loading,  setLoading]  = useState(true);
  const [dims,     setDims]     = useState({ w: 400, h: 300 });

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 10 && height > 10) setDims(prev => prev.w === width && prev.h === height ? prev : { w: width, h: height });
  }, []);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    loadTopo().then(() => setLoading(false));
  }, []);

  /* Recompute the single-country path whenever topoId or dims change */
  useEffect(() => {
    if (loading || !_topoCache || dims.w === 0 || !topoId) return;

    const feat = _topoCache.find(f => String((f as Feature & { id?: unknown }).id) === topoId);
    if (!feat) { setSilPath(""); return; }

    /* ── Step 1: natural-earth projection to get raw pixel path ── */
    /* Use a generous canvas to avoid precision loss */
    const W = 2400, H = 1200;
    const proj = geoNaturalEarth1().scale(W / 6.2).translate([W / 2, H / 2]);
    const pg   = geoPath(proj);

    /* ── Step 2: compute bounding box of this one country ── */
    const bounds = pg.bounds(feat);               // [[x0,y0],[x1,y1]]
    const bx0 = bounds[0][0], by0 = bounds[0][1];
    const bx1 = bounds[1][0], by1 = bounds[1][1];
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw < 1 || bh < 1) { setSilPath(""); return; }

    /* ── Step 3: fit to our container with padding ── */
    const PAD  = 40;
    const aw   = dims.w - PAD * 2;
    const ah   = dims.h - PAD * 2;
    const sc   = Math.min(aw / bw, ah / bh);

    /* Translate so bbox top-left maps to (PAD, PAD), centre within space */
    const ox   = PAD + (aw - bw * sc) / 2 - bx0 * sc;
    const oy   = PAD + (ah - bh * sc) / 2 - by0 * sc;

    /* ── Step 4: re-project with fitted scale ── */
    const fittedProj = geoNaturalEarth1()
      .scale((W / 6.2) * sc)
      .translate([W / 2 * sc + ox, H / 2 * sc + oy]);
    const pgFit = geoPath(fittedProj);
    const d     = pgFit(feat);

    setSilPath(d ?? "");
    setVbox(`0 0 ${dims.w} ${dims.h}`);
  }, [loading, topoId, dims]);

  /* Use geoIdentity to scale the path via a simple CSS transform instead
     — above approach is correct geoNaturalEarth re-projection which handles
       the curved projection math properly. */

  if (loading) {
    return (
      <div ref={containerRef} className="sil-container">
        <div className="map-loading"><div className="spinner" /><span>Yükleniyor…</span></div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={["sil-container", flash ? "sil-flash-" + flash : ""].filter(Boolean).join(" ")}
    >
      {silPath ? (
        <svg viewBox={vbox} className="sil-svg" aria-label="Ülke silüeti">
          <rect width={dims.w} height={dims.h} fill="var(--sil-bg)" />
          <path d={silPath} className="sil-path" />
        </svg>
      ) : (
        <div className="map-loading">
          <span style={{ color: "var(--muted)" }}>Silüet hesaplanıyor…</span>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ROUTE MAP VIEW
   A full-viewport map variant for Route Mode.
   Uses the shared topo cache (loadTopo).

   Color roles:
     route-start   — start country (accent blue glow)
     route-visited — steps already walked (green)
     route-current — the step the user is currently at (bright green, pulse)
     route-target  — destination (amber/gold, always visible)
     route-normal  — all other countries (default dark land)
═══════════════════════════════════════════════════════════════ */
export interface RouteMapProps {
  /** Canonical English keys of the full route walked so far (incl. start) */
  routeKeys:   string[];
  /** Canonical English key of start country */
  startKey:    string;
  /** Canonical English key of target country */
  targetKey:   string;
  /** topoId lookup: English key → topoId  (built once in RouteGame) */
  keyToTopoId: Record<string, string>;
}

export function RouteMapView({ routeKeys, startKey, targetKey, keyToTopoId }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef       = useRef<SVGSVGElement>(null);
  const rawRef2      = useRef<Feature<Geometry>[]>([]);

  const [computed2, setComputed2] = useState<ComputedFeature[]>([]);
  const [dims2, setDims2]         = useState({ w: 960, h: 500 });
  const [loading2, setLoading2]   = useState(true);

  const xf2Ref  = useRef({ k: 1, tx: 0, ty: 0 });
  const [xf2, setXf2] = useState({ k: 1, tx: 0, ty: 0 });
  const drag2Ref = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const projDims2Ref = useRef({ w: 0, h: 0 });

  const measure2 = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 10 && height > 10)
      setDims2(prev => prev.w === width && prev.h === height ? prev : { w: width, h: height });
  }, []);

  useEffect(() => {
    measure2();
    const ro = new ResizeObserver(measure2);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure2]);

  useEffect(() => {
    loadTopo().then(features => { rawRef2.current = features; setLoading2(false); });
  }, []);

  useEffect(() => {
    const features = rawRef2.current;
    if (loading2 || !features.length || dims2.w === 0) return;
    if (projDims2Ref.current.w === dims2.w && projDims2Ref.current.h === dims2.h) return;
    projDims2Ref.current = { w: dims2.w, h: dims2.h };

    const proj = geoNaturalEarth1().scale(dims2.w / 6.2).translate([dims2.w / 2, dims2.h / 2]);
    const pg   = geoPath(proj);
    const next: ComputedFeature[] = [];
    features.forEach(f => {
      const id = String((f as Feature & { id?: unknown }).id ?? "");
      const d  = pg(f);
      if (!d) return;
      const area     = pg.area(f);
      const [cx, cy] = pg.centroid(f);
      next.push({ id, d, area, cx: isNaN(cx) ? 0 : cx, cy: isNaN(cy) ? 0 : cy, display: TOPOID_TO_DISPLAY[id] ?? "" });
    });
    setComputed2(next);
  }, [loading2, dims2]);

  /* zoom */
  const applyZoom2 = useCallback((newK: number, focalX?: number, focalY?: number) => {
    const old = xf2Ref.current;
    const k   = clamp(newK, ZOOM_MIN, ZOOM_MAX);
    const fx  = focalX ?? dims2.w / 2;
    const fy  = focalY ?? dims2.h / 2;
    const ratio = k / old.k;
    const maxP  = dims2.w * (k - 1) * 0.6 + dims2.w * 0.3;
    const next  = { k, tx: clamp(fx - ratio*(fx-old.tx), -maxP, maxP), ty: clamp(fy - ratio*(fy-old.ty), -maxP, maxP) };
    xf2Ref.current = next; setXf2({ ...next });
  }, [dims2]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      applyZoom2(xf2Ref.current.k * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [applyZoom2]);

  const onPD2 = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    drag2Ref.current = { sx: e.clientX, sy: e.clientY, tx0: xf2Ref.current.tx, ty0: xf2Ref.current.ty };
  };
  const onPM2 = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag2Ref.current) return;
    const { k } = xf2Ref.current;
    const maxP  = dims2.w * (k - 1) * 0.6 + dims2.w * 0.3;
    const next  = { k, tx: clamp(drag2Ref.current.tx0+e.clientX-drag2Ref.current.sx,-maxP,maxP), ty: clamp(drag2Ref.current.ty0+e.clientY-drag2Ref.current.sy,-maxP,maxP) };
    xf2Ref.current = next; setXf2({ ...next });
  };
  const onPU2 = () => { drag2Ref.current = null; };

  if (loading2 || computed2.length === 0) {
    return (
      <div ref={containerRef} className="map-container-inner">
        <div className="map-loading"><div className="spinner" /><span>Harita yükleniyor…</span></div>
      </div>
    );
  }

  /* Build lookup sets from topoIds */
  const startId   = keyToTopoId[startKey]   ?? "";
  const targetId  = keyToTopoId[targetKey]  ?? "";
  const visitedIds = new Set(routeKeys.slice(0, -1).map(k => keyToTopoId[k]).filter(Boolean));
  const currentId  = keyToTopoId[routeKeys[routeKeys.length - 1]] ?? "";

  const cssTransform2 = `translate(${xf2.tx}px,${xf2.ty}px) scale(${xf2.k})`;
  const labelScale2   = 1 / xf2.k;

  return (
    <div ref={containerRef} className="map-container-inner">
      <svg ref={svgRef} viewBox={`0 0 ${dims2.w} ${dims2.h}`} className="world-svg"
        style={{ width: "100%", height: "100%", cursor: drag2Ref.current ? "grabbing" : "grab" }}
        aria-label="Rota haritası"
        onPointerDown={onPD2} onPointerMove={onPM2} onPointerUp={onPU2} onPointerCancel={onPU2}
      >
        <rect width={dims2.w} height={dims2.h} fill="var(--ocean)" />
        <g style={{ transform: cssTransform2, transformOrigin: "0 0" }}>
          {computed2.map(cf => {
            const isStart   = cf.id === startId;
            const isTarget  = cf.id === targetId;
            const isVisited = visitedIds.has(cf.id);
            const isCurrent = cf.id === currentId && cf.id !== targetId;

            const cls = [
              "country-path",
              isTarget  ? "rt-target"  : "",
              isStart   ? "rt-start"   : "",
              isVisited ? "rt-visited" : "",
              isCurrent ? "rt-current" : "",
            ].filter(Boolean).join(" ");

            return <path key={cf.id + cf.d.slice(1, 8)} d={cf.d} className={cls} />;
          })}

          {/* Labels for route countries + target */}
          {computed2
            .filter(cf =>
              cf.area >= MIN_LABEL && cf.cx !== 0 && cf.display &&
              (visitedIds.has(cf.id) || cf.id === currentId || cf.id === targetId || cf.id === startId)
            )
            .map(cf => {
              const base = Math.min(11, Math.max(5, Math.sqrt(cf.area) * 0.27));
              const isTarget = cf.id === targetId;
              return (
                <g key={"rl-" + cf.id} transform={`translate(${cf.cx},${cf.cy})`}>
                  <text
                    textAnchor="middle" dominantBaseline="central"
                    fontSize={base * labelScale2}
                    className={"country-label" + (isTarget ? " rt-label-target" : " label-last")}
                  >
                    {cf.display}
                  </text>
                </g>
              );
            })}
        </g>
      </svg>

      {/* Zoom controls */}
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={() => applyZoom2(xf2Ref.current.k * ZOOM_STEP)} aria-label="Yakınlaştır">+</button>
        <div className="zoom-divider" />
        <button className="zoom-btn" onClick={() => applyZoom2(xf2Ref.current.k / ZOOM_STEP)} aria-label="Uzaklaştır">&#8722;</button>
      </div>
      <div className="map-hint">Sürükle: hareket &nbsp;|&nbsp; Scroll: zoom</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DUEL MAP VIEW
   Same base as WorldMap but supports two coloured claim sets.
   myTopoIds  → green (the local player)
   oppTopoIds → red  (the opponent)
═══════════════════════════════════════════════════════════════ */
export interface DuelMapProps {
  myTopoIds:   Set<string>;
  oppTopoIds:  Set<string>;
  showLabels?: boolean;
  region?:     string;
  activeIds?:  Set<string>;
}

export function DuelMapView({ myTopoIds, oppTopoIds, showLabels = false, region, activeIds }: DuelMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef       = useRef<SVGSVGElement>(null);
  const rawRef3      = useRef<Feature<Geometry>[]>([]);

  const [computed3, setComputed3] = useState<ComputedFeature[]>([]);
  const [dims3, setDims3]         = useState({ w: 960, h: 500 });
  const [loading3, setLoading3]   = useState(true);

  const xf3Ref  = useRef({ k: 1, tx: 0, ty: 0 });
  const [xf3, setXf3] = useState({ k: 1, tx: 0, ty: 0 });
  const drag3Ref = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const proj3Ref = useRef({ w: 0, h: 0 });

  const measure3 = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 10 && height > 10)
      setDims3(p => p.w === width && p.h === height ? p : { w: width, h: height });
  }, []);

  useEffect(() => {
    measure3();
    const ro = new ResizeObserver(measure3);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure3]);

  useEffect(() => {
    loadTopo().then(f => { rawRef3.current = f; setLoading3(false); });
  }, []);

  useEffect(() => {
    const features = rawRef3.current;
    if (loading3 || !features.length || dims3.w === 0) return;
    if (proj3Ref.current.w === dims3.w && proj3Ref.current.h === dims3.h) return;
    proj3Ref.current = { w: dims3.w, h: dims3.h };
    const proj = geoNaturalEarth1().scale(dims3.w / 6.2).translate([dims3.w / 2, dims3.h / 2]);
    const pg   = geoPath(proj);
    const next: ComputedFeature[] = [];
    features.forEach(f => {
      const id = String((f as Feature & { id?: unknown }).id ?? "");
      const d  = pg(f); if (!d) return;
      const area = pg.area(f); const [cx, cy] = pg.centroid(f);
      next.push({ id, d, area, cx: isNaN(cx)?0:cx, cy: isNaN(cy)?0:cy, display: TOPOID_TO_DISPLAY[id]??""  });
    });
    setComputed3(next);
  }, [loading3, dims3]);

  // Auto-zoom to fit the selected region
  useEffect(() => {
    if (!region || region === "world" || !activeIds?.size || computed3.length === 0 || dims3.w === 0) return;
    const fit = fitRegion(activeIds, computed3, dims3.w, dims3.h);
    if (!fit) return;
    xf3Ref.current = fit;
    setXf3({ ...fit });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, activeIds, computed3, dims3]);

  const applyZoom3 = useCallback((nk: number, fx?: number, fy?: number) => {
    const old = xf3Ref.current; const k = clamp(nk, ZOOM_MIN, ZOOM_MAX);
    const _fx = fx ?? dims3.w/2; const _fy = fy ?? dims3.h/2;
    const r = k/old.k; const maxP = dims3.w*(k-1)*0.6+dims3.w*0.3;
    const next = { k, tx: clamp(_fx-r*(_fx-old.tx),-maxP,maxP), ty: clamp(_fy-r*(_fy-old.ty),-maxP,maxP) };
    xf3Ref.current = next; setXf3({...next});
  }, [dims3]);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      applyZoom3(xf3Ref.current.k*(e.deltaY<0?ZOOM_STEP:1/ZOOM_STEP), e.clientX-r.left, e.clientY-r.top);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [applyZoom3]);

 const onPD3 = (e: ReactPointerEvent<SVGSVGElement>) => {
  e.preventDefault();
  e.stopPropagation();

  svgRef.current?.setPointerCapture(e.pointerId);
    drag3Ref.current = { sx:e.clientX, sy:e.clientY, tx0:xf3Ref.current.tx, ty0:xf3Ref.current.ty };
  };
  const onPM3 = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag3Ref.current) return;
    const { k } = xf3Ref.current; const maxP = dims3.w*(k-1)*0.6+dims3.w*0.3;
    const next = { k, tx: clamp(drag3Ref.current.tx0+e.clientX-drag3Ref.current.sx,-maxP,maxP), ty: clamp(drag3Ref.current.ty0+e.clientY-drag3Ref.current.sy,-maxP,maxP) };
    xf3Ref.current = next; setXf3({...next});
  };
  const onPU3 = () => { drag3Ref.current = null; };

  if (loading3 || computed3.length === 0) {
    return <div ref={containerRef} className="map-container-inner"><div className="map-loading"><div className="spinner"/><span>Harita yükleniyor…</span></div></div>;
  }

  const t3 = `translate(${xf3.tx}px,${xf3.ty}px) scale(${xf3.k})`;

  return (
    <div ref={containerRef} className="map-container-inner">
      <svg
  ref={svgRef}
  viewBox={`0 0 ${dims3.w} ${dims3.h}`}
  className="world-svg"
  style={{
    width: "100%",
    height: "100%",
    cursor: drag3Ref.current ? "grabbing" : "grab",
    touchAction: "none",
  }}
  onPointerDown={onPD3}
  onPointerMove={onPM3}
  onPointerUp={onPU3}
  onPointerCancel={onPU3}
>
        <rect width={dims3.w} height={dims3.h} fill="var(--ocean)"/>
        <g style={{ transform:t3, transformOrigin:"0 0" }}>
          {computed3.map(cf => {
            const isMine = myTopoIds.has(cf.id);
            const isOpp  = oppTopoIds.has(cf.id);
            const cls = ["country-path", isMine ? "duel-mine" : isOpp ? "duel-opp" : ""].filter(Boolean).join(" ");
            return <path key={cf.id+cf.d.slice(1,8)} d={cf.d} className={cls}/>;
          })}
        </g>

        {/* Country labels — only for claimed countries, shown when toggle is on.
             Zoom-aware: at low zoom, only large countries show labels.
             Font is capped so it never grows huge or stays microscopic.
             Areas below MIN_LABEL are always hidden. */}
        {showLabels && (
          <g style={{ transform: t3, transformOrigin: "0 0" }}>
            {computed3
             .filter(cf => {
  if (cf.cx === 0 || !cf.display) return false;

  const isClaimed = myTopoIds.has(cf.id) || oppTopoIds.has(cf.id);
  if (!isClaimed) return false;

  const effectiveMin = 40 / (xf3.k * xf3.k);
  if (cf.area < effectiveMin) return false;

  return true;
})
              .map(cf => {
                // Font size: based on sqrt(area) scaled by label-scale,
                // clamped so it stays readable but not huge.
                const labelScale3 = Math.max(0.6, 1 / Math.sqrt(xf3.k));
                const base = Math.min(10, Math.max(4.5, Math.sqrt(cf.area) * 0.22));
                const finalSize = base * labelScale3;
                // Don't render if too tiny to read
                if (finalSize < 2) return null;
                return (
                  <g key={"dl-" + cf.id} transform={`translate(${cf.cx + (LABEL_OFFSET[cf.id]?.[0] ?? 0)},${cf.cy + (LABEL_OFFSET[cf.id]?.[1] ?? 0)})`}>
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={finalSize}
                      className="country-label label-last"
                      style={{ pointerEvents: "none" }}
                    >
                      {cf.display}
                    </text>
                  </g>
                );
              })}
          </g>
        )}
      </svg>
      <div className="zoom-controls">
        <button className="zoom-btn" onClick={()=>applyZoom3(xf3Ref.current.k*ZOOM_STEP)}>+</button>
        <div className="zoom-divider"/>
        <button className="zoom-btn" onClick={()=>applyZoom3(xf3Ref.current.k/ZOOM_STEP)}>&#8722;</button>
      </div>
      <div className="map-hint">Sürükle: hareket &nbsp;|&nbsp; Scroll: zoom</div>

      {/* Legend */}
      <div className="duel-legend">
        <span className="duel-legend-item duel-legend-mine">● Ben</span>
        <span className="duel-legend-item duel-legend-opp">● Rakip</span>
      </div>
    </div>
  );
}
