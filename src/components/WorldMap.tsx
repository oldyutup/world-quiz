import { useEffect, useRef, useState, useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, Geometry, Feature } from "geojson";
import { TOPOID_TO_DISPLAY } from "../data/countries";

interface Props {
  guessedISOs:    Set<string>;
  lastGuessed:    string | null;
  showLabels:     boolean;
  activeIds:      Set<string>;   // NEW: which IDs are in-scope for current continent/mode
}

interface ComputedFeature {
  id: string; d: string; area: number; cx: number; cy: number; display: string;
}

const WORLD_URL   = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const MIN_LABEL   = 120;
const ZOOM_MIN    = 1;
const ZOOM_MAX    = 12;
const ZOOM_STEP   = 1.4;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export default function WorldMap({ guessedISOs, lastGuessed, showLabels, activeIds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef       = useRef<SVGSVGElement>(null);
  const rawRef       = useRef<Feature<Geometry>[]>([]);

  const [computed, setComputed] = useState<ComputedFeature[]>([]);
  const [dims, setDims]         = useState({ w: 960, h: 500 });
  const [loading, setLoading]   = useState(true);

  const xfRef   = useRef({ k: 1, tx: 0, ty: 0 });
  const [xf, setXf] = useState({ k: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);

  /* measure */
  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 10 && height > 10) setDims({ w: width, h: height });
  }, []);
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  /* fetch */
  useEffect(() => {
    fetch(WORLD_URL).then(r => r.json()).then((topo: Topology) => {
      const fc = feature(topo, topo.objects.countries as GeometryCollection) as FeatureCollection<Geometry>;
      rawRef.current = fc.features as Feature<Geometry>[];
      setLoading(false);
    });
  }, []);

  /* reproject */
  const reproject = useCallback(() => {
    const features = rawRef.current;
    if (!features.length || dims.w === 0) return;
    const proj = geoNaturalEarth1().scale(dims.w / 6.2).translate([dims.w / 2, dims.h / 2]);
    const pg   = geoPath(proj);
    const next: ComputedFeature[] = [];
    features.forEach((f) => {
      const id = String((f as Feature & { id?: unknown }).id ?? "");
      const d  = pg(f);
      if (!d) return;
      const area    = pg.area(f);
      const [cx,cy] = pg.centroid(f);
      next.push({ id, d, area, cx: isNaN(cx)?0:cx, cy: isNaN(cy)?0:cy, display: TOPOID_TO_DISPLAY[id]??""  });
    });
    setComputed(next);
    xfRef.current = { k:1, tx:0, ty:0 };
    setXf({ k:1, tx:0, ty:0 });
  }, [dims]);
  useEffect(() => { if (!loading) reproject(); }, [loading, reproject]);

  /* zoom */
  const applyZoom = useCallback((newK: number, focalX?: number, focalY?: number) => {
    const old   = xfRef.current;
    const k     = clamp(newK, ZOOM_MIN, ZOOM_MAX);
    const fx    = focalX ?? dims.w/2;
    const fy    = focalY ?? dims.h/2;
    const ratio = k / old.k;
    const maxP  = dims.w*(k-1)*0.6 + dims.w*0.3;
    const next  = { k, tx: clamp(fx - ratio*(fx-old.tx), -maxP, maxP), ty: clamp(fy - ratio*(fy-old.ty), -maxP, maxP) };
    xfRef.current = next; setXf({...next});
  }, [dims]);

  /* wheel */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      applyZoom(xfRef.current.k * (e.deltaY < 0 ? ZOOM_STEP : 1/ZOOM_STEP), e.clientX-r.left, e.clientY-r.top);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [applyZoom]);

  /* drag */
  const onPD = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, tx0: xfRef.current.tx, ty0: xfRef.current.ty };
  };
  const onPM = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const { k } = xfRef.current;
    const maxP  = dims.w*(k-1)*0.6 + dims.w*0.3;
    const next  = { k, tx: clamp(dragRef.current.tx0+e.clientX-dragRef.current.sx, -maxP, maxP), ty: clamp(dragRef.current.ty0+e.clientY-dragRef.current.sy, -maxP, maxP) };
    xfRef.current = next; setXf({...next});
  };
  const onPU = () => { dragRef.current = null; };

  if (loading || computed.length === 0) {
    return (
      <div ref={containerRef} className="map-container-inner">
        <div className="map-loading"><div className="spinner"/><span>Harita yukleniyor...</span></div>
      </div>
    );
  }

  const cssTransform = `translate(${xf.tx}px,${xf.ty}px) scale(${xf.k})`;
  const labelScale   = 1 / xf.k;

  return (
    <div ref={containerRef} className="map-container-inner">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${dims.w} ${dims.h}`}
        className="world-svg"
        style={{ width:"100%", height:"100%", cursor: dragRef.current ? "grabbing" : "grab" }}
        aria-label="Dunya haritasi"
        onPointerDown={onPD} onPointerMove={onPM} onPointerUp={onPU} onPointerCancel={onPU}
      >
        <rect width={dims.w} height={dims.h} fill="var(--ocean)"/>
        <g style={{ transform: cssTransform, transformOrigin:"0 0" }}>
          {computed.map((cf) => {
            const inScope  = activeIds.has(cf.id);
            const isGuessed = guessedISOs.has(cf.id);
            const isLast    = cf.id === lastGuessed;
            return (
              <path
                key={cf.id + cf.d.slice(1,8)}
                d={cf.d}
                className={[
                  "country-path",
                  !inScope ? "out-of-scope" : "",
                  isGuessed ? "guessed" : "",
                  isLast    ? "last"    : "",
                ].filter(Boolean).join(" ")}
              />
            );
          })}

          {showLabels && computed
            .filter(cf => guessedISOs.has(cf.id) && cf.display && cf.area >= MIN_LABEL && cf.cx !== 0)
            .map(cf => {
              const base = Math.min(11, Math.max(5, Math.sqrt(cf.area)*0.27));
              return (
                <g key={"lbl-"+cf.id} transform={"translate("+cf.cx+","+cf.cy+")"}>
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
        <button className="zoom-btn" onClick={() => applyZoom(xfRef.current.k*ZOOM_STEP)} aria-label="Yakinlastir">+</button>
        <div className="zoom-divider"/>
        <button className="zoom-btn" onClick={() => applyZoom(xfRef.current.k/ZOOM_STEP)} aria-label="Uzaklastir">&#8722;</button>
      </div>

      <div className="map-hint">Surukle: hareket&nbsp;&nbsp;|&nbsp;&nbsp;Scroll: zoom</div>
    </div>
  );
}
