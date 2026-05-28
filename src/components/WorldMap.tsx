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
        // Kosovo: no ISO id in world-atlas → assign "XK" to match our country entry.
        // Somaliland: no ISO id, not a separate country → assign Somalia's id "706"
        //   so its polygon is painted whenever Somalia is guessed.
        // W. Sahara: has id "732" but is treated as part of Morocco (id "504")
        //   so its polygon is painted whenever Morocco is guessed.
        _topoCache = (fc.features as Feature<Geometry>[]).map(f => {
          const props = (f as unknown as { properties?: { name?: string } }).properties;
          if (f.id == null || f.id === "") {
            if (props?.name === "Kosovo")     return { ...f, id: "XK" };
            if (props?.name === "Somaliland") return { ...f, id: "706" };
          }
          if (f.id === "732") return { ...f, id: "504" }; // W. Sahara → Morocco
          return f;
        });
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

/**
 * Zoom-dependent area threshold for labels.
 *   k=1   → ~800   (only large countries pass; mid-large rely on ALWAYS_LABEL_IDS)
 *   k=2   → ~230   (medium European/Asian countries appear)
 *   k=4   → ~65    (small countries — Belgium, Netherlands, Switzerland)
 *   k=8   → ~18    (micro-states emerge)
 *   k=12  → ~9     (everything)
 */
function visibleAreaMin(k: number): number {
  return 800 / Math.pow(k, 1.8);
}

/**
 * Target on-screen font size for a country label, in screen pixels.
 *
 * Two contributions:
 *   • areaBase: bigger countries get slightly bigger labels (sqrt-damped so
 *     the range stays sane between Singapore and Russia).
 *   • zoomBoost: log2(k) so labels grow gently as the user zooms in
 *     (k=1 → +0, k=2 → +1.5, k=4 → +3, k=8 → +4.5).
 * Clamped to [10, 22] px so labels never become microscopic or huge.
 *
 * Callers should divide by k when setting the SVG fontSize attribute, because
 * the label group is rendered inside a `transform: scale(k)` <g>.
 */
function labelScreenSize(area: number, k: number): number {
  const areaBase  = Math.sqrt(area) * 0.12;
  const zoomBoost = Math.log2(Math.max(1, k)) * 0.7;
  return clamp(7.5 + areaBase + zoomBoost, 9, 13.5);
}

/**
 * Mid-to-large countries that should always be labelled when the toggle is on
 * (and mode-specific conditions are met), regardless of zoom level. These have
 * a projected area below 800 px² at scale w/6.2 but are prominent enough that
 * the world view feels incomplete without them.
 */
const ALWAYS_LABEL_IDS: Set<string> = new Set([
  "792", // Türkiye
  "250", // Fransa
  "276", // Almanya
  "724", // İspanya
  "380", // İtalya
  "364", // İran
  "818", // Mısır
  "682", // Suudi Arabistan
  "710", // Güney Afrika
  "360", // Endonezya
  "032", // Arjantin
  "012", // Cezayir
  "566", // Nijerya
  "484", // Meksika
  "586", // Pakistan
  "804", // Ukrayna
  "616", // Polonya
  "643", // Rusya
  "156", // Çin
  "840", // ABD
  "124", // Kanada
  "076", // Brezilya
  "036", // Avustralya
  "356", // Hindistan
]);

/** Manual label offsets for countries whose centroid is pulled off mainland by overseas territories.
 *  Values are projected SVG units at k=1. */
const LABEL_OFFSET: Record<string, [number, number]> = {
  "250": [17, -10], // Fransa — centroid pulled SW by overseas territories
};
const ZOOM_MIN  = 1;
const ZOOM_MAX  = 12;
const ZOOM_STEP = 1.4;

/** Keyboard zoom presets — must stay within [ZOOM_MIN, ZOOM_MAX].
 *  Keys 0 and 1 are handled separately as full resets to the world view.
 *  Keys 2–5 keep the viewport centre anchored, so the region the user is
 *  looking at stays in frame as zoom changes. */
const ZOOM_PRESETS: Record<string, number> = {
  "2": 2,    // continent
  "3": 3.5,  // region
  "4": 5.5,  // country group
  "5": 8,    // close detail
};

/** Skip global shortcuts when the user is typing in a form field. */
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return t.isContentEditable;
}

/* ═══════════════════════════════════════════════════════════════
   MAP THEME SYSTEM
   Each theme overrides only the canvas-side CSS vars (ocean, land,
   land-stroke, land-oos) via inline custom properties on the map
   container. Game-feedback colors (--guessed/--guessed-last/--green/
   --red/--amber) intentionally stay global so route/duel semantics
   remain consistent across themes.
═══════════════════════════════════════════════════════════════ */
type MapThemeId = "classic" | "minimal" | "atlas" | "night" | "satellite";
interface MapThemeDef {
  id:   MapThemeId;
  name: string;
  vars: { "--ocean": string; "--land": string; "--land-stroke": string; "--land-oos": string };
  /** When set, the map renders this image as a backdrop inside the pan/zoom
   *  group. Country paths still render on top (so click/colour/state still
   *  work). The image is offline-reprojected to match geoNaturalEarth1. */
  imageUrl?:    string;
  /** Caption shown at the bottom-right while this theme is active. */
  attribution?: string;
}
const MAP_THEMES: Record<MapThemeId, MapThemeDef> = {
  classic:   { id: "classic", name: "Classic",
    vars: { "--ocean": "#0d2137", "--land": "#1e2d40", "--land-stroke": "#2a3e55", "--land-oos": "#151e2a" } },
  minimal:   { id: "minimal", name: "Minimal",
    vars: { "--ocean": "#1d2735", "--land": "#2f3a4a", "--land-stroke": "#45506a", "--land-oos": "#232c38" } },
  atlas:     { id: "atlas",   name: "Atlas",
    vars: { "--ocean": "#2a4e6c", "--land": "#475347", "--land-stroke": "#6b7869", "--land-oos": "#2e362d" } },
  night:     { id: "night",   name: "Night",
    vars: { "--ocean": "#050b14", "--land": "#15202d", "--land-stroke": "#243443", "--land-oos": "#0a0f15" } },
  satellite: { id: "satellite", name: "Satellite",
    // vars stay close to classic so the brief moment before the image loads
    // doesn't flash a wildly different colour scheme.
    vars: { "--ocean": "#0d2137", "--land": "#1e2d40", "--land-stroke": "#1a1a1a", "--land-oos": "#0a0f14" },
    imageUrl:    "/assets/map/blue-marble-ne.jpg",
    attribution: "Imagery: NASA Blue Marble" },
};
const MAP_THEME_ORDER: MapThemeId[] = ["classic", "minimal", "atlas", "night", "satellite"];
const THEME_STORAGE_KEY = "world-quiz:map-theme";

function useMapTheme(): [MapThemeId, (t: MapThemeId) => void] {
  const [theme, setThemeState] = useState<MapThemeId>(() => {
    if (typeof window === "undefined") return "classic";
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY) as MapThemeId | null;
      if (stored && MAP_THEMES[stored]) return stored;
    } catch { /* localStorage may be unavailable */ }
    return "classic";
  });
  const setTheme = useCallback((t: MapThemeId) => {
    setThemeState(t);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, t); } catch { /* ignore */ }
  }, []);
  return [theme, setTheme];
}

function MapThemePicker({ active, onChange }: { active: MapThemeId; onChange: (t: MapThemeId) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("touchstart", onDown);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="map-theme-picker">
      {open && (
        <div className="map-theme-panel" role="menu" aria-label="Harita teması">
          {MAP_THEME_ORDER.map(id => {
            const t = MAP_THEMES[id];
            return (
              <button
                key={id}
                type="button"
                className={"map-theme-option" + (id === active ? " active" : "")}
                onClick={() => { onChange(id); setOpen(false); }}
                role="menuitemradio"
                aria-checked={id === active}
              >
                <span className="map-theme-swatch"
                  style={{ background: `linear-gradient(135deg, ${t.vars["--ocean"]} 0%, ${t.vars["--land"]} 100%)` }}
                />
                <span className="map-theme-name">{t.name}</span>
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        className={"map-theme-toggle" + (open ? " open" : "")}
        onClick={() => setOpen(o => !o)}
        aria-label="Harita teması"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Harita teması"
      >
        {/* layers icon */}
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 8 12 14 2 8 12 2" />
          <polyline points="2 14 12 20 22 14" />
        </svg>
      </button>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Clamp pan offsets so the map cannot drift past the viewport edges.
 *
 * The map is projected with geoNaturalEarth1().scale(w/6.2).translate([w/2, h/2]) —
 * that puts the map width = w and the map height ≈ 0.52 * w (NaturalEarth aspect),
 * centred at (w/2, h/2) in the un-transformed <g>. The CSS transform applied to
 * that <g> is `translate(tx, ty) scale(k)`, so a map point (x, y) lands on screen
 * at (tx + k*x, ty + k*y).
 *
 * Allowance ramps in with k. At k ≤ 1.05 the map is locked to its initial
 * centred position (txCentre, tyCentre); at k ≈ 1.55 the user gets the full
 * geometric range so they can reach all of the scaled map plus a 30 px slack.
 * Between those, allowance interpolates linearly. This stops the world from
 * drifting at zoom-out while keeping pan rich when zoomed in.
 */
const MAP_ASPECT = 0.52; // NaturalEarth height-to-width

/**
 * Pick the initial pan/zoom transform for a freshly-mounted (or reset) map.
 *
 * Desktop (w ≥ 768) → k=1, no offset: unchanged behaviour, world fits the
 * container as before.
 *
 * Mobile (w < 768) → frame the *useful land band* instead of the projection
 * bounding box. NaturalEarth's canvas is `w × 0.52w` but ~30% of that height
 * is empty polar ocean and elliptical corners; fitting the canvas leaves the
 * viewport feeling like a small map floating in blue. We zoom past that, drop
 * the equator slightly below viewport centre (more landmass lives north of
 * it), and let the map overflow the viewport horizontally — pan and pinch are
 * already wired in so the player can reach Australia or Alaska.
 *
 * Tuning:
 *   USEFUL_BAND_RATIO — fraction of projection height occupied by continents.
 *     0.70 ≈ 75°N to 55°S, which crops Arctic open ocean and most of
 *     Antarctica off-screen. Most useful land remains visible.
 *   VIEWPORT_FILL    — how much of viewport height the band should fill.
 *     0.92 keeps a small breathing margin top/bottom while the band dominates.
 *   NORTH_BIAS       — fraction of projection height to shift equator down by.
 *     0.08 nudges Africa, S. Asia, and the Americas higher in frame without
 *     pushing Australia or southern Africa off-screen.
 */
function initialTransform(w: number, h: number) {
  if (w <= 0 || h <= 0) return { k: 1, tx: 0, ty: 0 };
  if (w >= 768)         return { k: 1, tx: 0, ty: 0 };

  const USEFUL_BAND_RATIO = 0.70;
  const VIEWPORT_FILL     = 0.92;
  const NORTH_BIAS        = 0.08;

  const mapH      = w * MAP_ASPECT;
  const targetH   = mapH * USEFUL_BAND_RATIO;
  const k         = clamp((h * VIEWPORT_FILL) / targetH, 1, ZOOM_MAX);
  const tx        = (1 - k) * w / 2;
  const ty        = (1 - k) * h / 2 + k * mapH * NORTH_BIAS;
  return { k, tx, ty };
}

function clampPan(tx: number, ty: number, k: number, w: number, h: number) {
  const mapW = w;
  const mapH = w * MAP_ASPECT;

  const slack = clamp((k - 1.05) * 60, 0, 30);
  const ramp  = slack / 30;

  // Centred transform: keeps projection centre (w/2, h/2) at screen centre.
  const txCentre = (1 - k) * w / 2;
  const tyCentre = (1 - k) * h / 2;

  // Half-range the user may stray from centre. Excess past the viewport plus
  // slack, gated by the ramp so low k stays locked even if the map already
  // extends past the viewport (tall-projection / short-viewport case).
  const txAllowance = Math.max(0, (k * mapW - w) / 2 + slack) * ramp;
  const tyAllowance = Math.max(0, (k * mapH - h) / 2 + slack) * ramp;

  return {
    tx: clamp(tx, txCentre - txAllowance, txCentre + txAllowance),
    ty: clamp(ty, tyCentre - tyAllowance, tyCentre + tyAllowance),
  };
}

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
  // Start at 0×0 so the initial-transform effect waits for the ResizeObserver
  // to deliver the real container size. A non-zero placeholder (especially a
  // desktop-sized one) would race the measurement: the effect would fire with
  // the placeholder dims, latch didInitRef, and skip the real mobile dims that
  // arrive a tick later. The loading branch below renders without an SVG until
  // dims are real, so 0×0 is safe.
  const [dims, setDims]         = useState({ w: 0, h: 0 });
  const [loading, setLoading]   = useState(true);
  const [mapTheme, setMapTheme] = useMapTheme();

  const xfRef   = useRef({ k: 1, tx: 0, ty: 0 });
  const [xf, setXf] = useState({ k: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const projectedDimsRef = useRef({ w: 0, h: 0 });
  const didInitRef = useRef(false);
  // Tracks the (region, dims) we last auto-fitted to. Parents (e.g. WheelDuel /
  // WheelGroup) rebuild `activeIds` as a new Set on every render, which would
  // otherwise re-fire the auto-fit effect and snap the user's pan/zoom back to
  // the framed region after every score tick or room update.
  const lastFitKeyRef = useRef<string>("");
  const dimsRef = useRef({ w: 0, h: 0 });
  dimsRef.current = dims;
  // Track pointer movement so a drag never fires onCountryClick.
  // Stays harmless when onCountryClick is undefined.
  const wasDragRef = useRef(false);
  const downPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Multi-pointer state for two-finger pinch zoom on touch screens.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    initialDist: number; initialK: number; initialTx: number; initialTy: number;
  } | null>(null);

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
    // Allow a manual reset to re-fit the active region on the next pass.
    lastFitKeyRef.current = "";
    const reset = initialTransform(dimsRef.current.w, dimsRef.current.h);
    xfRef.current = reset;
    setXf(reset);
  }, [resetKey]);

  // Apply the mobile-aware initial transform once dims is known. Skipped when
  // a region is set (the auto-fit effect below picks the framing instead).
  useEffect(() => {
    if (dims.w === 0) return;
    if (region && region !== "world") return;
    if (didInitRef.current) return;
    didInitRef.current = true;
    const init = initialTransform(dims.w, dims.h);
    xfRef.current = init;
    setXf(init);
  }, [dims, region]);

  // Auto-zoom to fit the selected region. Fires once per (region, dims)
  // combination — not on every activeIds identity flip — so user pan/zoom
  // survives subsequent parent re-renders. Re-fits if the user resizes /
  // rotates the device, or when region changes.
  useEffect(() => {
    if (!region || region === "world" || computed.length === 0 || dims.w === 0) return;
    const key = `${region}|${Math.round(dims.w)}x${Math.round(dims.h)}`;
    if (lastFitKeyRef.current === key) return;
    const fit = fitRegion(activeIds, computed, dims.w, dims.h);
    if (!fit) return;
    lastFitKeyRef.current = key;
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
    const { tx, ty } = clampPan(fx - ratio*(fx-old.tx), fy - ratio*(fy-old.ty), k, dims.w, dims.h);
    const next  = { k, tx, ty };
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 0 and 1 both jump back to the initial world view (mobile-aware).
      if (e.key === "0" || e.key === "1") {
        const reset = initialTransform(dimsRef.current.w, dimsRef.current.h);
        xfRef.current = reset; setXf(reset);
        e.preventDefault();
        return;
      }
      // 2–5: change zoom while keeping the viewport centre anchored — same
      // math the wheel uses with focal=(w/2, h/2), via applyZoom().
      const presetK = ZOOM_PRESETS[e.key];
      if (presetK !== undefined) {
        applyZoom(presetK);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyZoom]);

  const onPD = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1) {
      // Single pointer → drag/pan
      dragRef.current = { sx: e.clientX, sy: e.clientY, tx0: xfRef.current.tx, ty0: xfRef.current.ty };
      wasDragRef.current = false;
      downPosRef.current = { x: e.clientX, y: e.clientY };
    } else if (pointersRef.current.size === 2) {
      // Second pointer down → start pinch. Stop tracking pan so the gesture is purely zoom.
      dragRef.current = null;
      wasDragRef.current = true; // ensure no click fires after pinch
      const pts = Array.from(pointersRef.current.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      pinchRef.current = {
        initialDist: Math.hypot(dx, dy) || 1,
        initialK: xfRef.current.k,
        initialTx: xfRef.current.tx,
        initialTy: xfRef.current.ty,
      };
    }
  };
  const onPM = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      // Pinch: scale around the current midpoint between the two fingers.
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pts = Array.from(pointersRef.current.values()).slice(0, 2);
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy) || 1;
      const ratio = dist / pinchRef.current.initialDist;
      const newK = clamp(pinchRef.current.initialK * ratio, ZOOM_MIN, ZOOM_MAX);
      const fx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const fy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const kRatio = newK / pinchRef.current.initialK;
      const { tx, ty } = clampPan(
        fx - kRatio * (fx - pinchRef.current.initialTx),
        fy - kRatio * (fy - pinchRef.current.initialTy),
        newK, dims.w, dims.h,
      );
      const next = { k: newK, tx, ty };
      xfRef.current = next; setXf({ ...next });
      return;
    }

    if (!dragRef.current) return;
    if (!wasDragRef.current) {
      const ddx = Math.abs(e.clientX - downPosRef.current.x);
      const ddy = Math.abs(e.clientY - downPosRef.current.y);
      if (ddx + ddy > 5) wasDragRef.current = true;
    }
    const { k } = xfRef.current;
    const { tx, ty } = clampPan(
      dragRef.current.tx0 + e.clientX - dragRef.current.sx,
      dragRef.current.ty0 + e.clientY - dragRef.current.sy,
      k, dims.w, dims.h,
    );
    const next  = { k, tx, ty };
    xfRef.current = next; setXf({ ...next });
  };
  const onPU = (e: ReactPointerEvent<SVGSVGElement>) => {
    const wasPinching = pointersRef.current.size >= 2;
    pointersRef.current.delete(e.pointerId);

    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 1) {
      // Reseed drag origin from the remaining finger so pan resumes seamlessly.
      const remaining = Array.from(pointersRef.current.values())[0];
      dragRef.current = { sx: remaining.x, sy: remaining.y, tx0: xfRef.current.tx, ty0: xfRef.current.ty };
      wasDragRef.current = true; // post-pinch one-finger lift should not click
    } else if (pointersRef.current.size === 0) {
      // Click dispatch via pointerup: setPointerCapture on the SVG redirects
      // pointer events to the SVG, which can prevent the synthesized `click`
      // from firing on the underlying <path>. We resolve the path the user
      // released over via elementFromPoint and read data-topo-id.
      //
      // No-op when onCountryClick is not provided → legacy behaviour unchanged.
      if (
        onCountryClick &&
        !wasPinching &&
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
    }
  };

  if (loading || computed.length === 0) {
    return (
      <div ref={containerRef} className="map-container-inner">
        <div className="map-loading"><div className="spinner" /><span>Harita yükleniyor…</span></div>
      </div>
    );
  }

  const cssTransform = `translate(${xf.tx}px,${xf.ty}px) scale(${xf.k})`;

  // For ids shared by multiple features (e.g. Somaliland→Somalia), track the
  // primary feature (largest area) so we render labels once and mark extras.
  const maxAreaById = new Map<string, number>();
  computed.forEach(cf => {
    if ((maxAreaById.get(cf.id) ?? -1) < cf.area) maxAreaById.set(cf.id, cf.area);
  });

  const themeDef = MAP_THEMES[mapTheme];
  return (
    <div ref={containerRef} className={`map-container-inner map-theme-${mapTheme}`} style={themeDef.vars as React.CSSProperties}>
      <svg ref={svgRef} viewBox={`0 0 ${dims.w} ${dims.h}`} className="world-svg"
        style={{ width: "100%", height: "100%", cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
        aria-label="Dünya haritası"
        onPointerDown={onPD} onPointerMove={onPM} onPointerUp={onPU} onPointerCancel={onPU}
      >
        <rect width={dims.w} height={dims.h} fill="var(--ocean)" />
        <g style={{ transform: cssTransform, transformOrigin: "0 0" }}>
          {themeDef.imageUrl && (
            <image href={themeDef.imageUrl}
              x={0} y={(dims.h - dims.w / 2) / 2}
              width={dims.w} height={dims.w / 2}
              preserveAspectRatio="none"
              style={{ pointerEvents: "none" }}
            />
          )}
          {computed.map(cf => {
            const inScope   = activeIds.has(cf.id);
            const isGuessed = guessedISOs.has(cf.id);
            const isLast    = cf.id === lastGuessed;
            const isWrong   = wrongId === cf.id;
            const isSecondary = cf.area < (maxAreaById.get(cf.id) ?? cf.area);
            return (
              <path key={cf.id + cf.d.slice(1, 8)} d={cf.d}
                data-topo-id={cf.id}
                className={["country-path",!inScope?"out-of-scope":"",isGuessed?"guessed":"",isLast?"last":"",isWrong?"wheel-wrong":"",isSecondary?"merged-secondary":""].filter(Boolean).join(" ")}
                style={onCountryClick ? { cursor: "pointer" } : undefined}
              />
            );
          })}
          {showLabels && computed
            .filter(cf =>
              guessedISOs.has(cf.id) && cf.display && cf.cx !== 0
              && cf.area === maxAreaById.get(cf.id)
              && (ALWAYS_LABEL_IDS.has(cf.id) || cf.area >= visibleAreaMin(xf.k))
            )
            .map(cf => {
              const fontSize = labelScreenSize(cf.area, xf.k) / xf.k;
              return (
                <g key={"lbl-"+cf.id} transform={`translate(${cf.cx + (LABEL_OFFSET[cf.id]?.[0] ?? 0)},${cf.cy + (LABEL_OFFSET[cf.id]?.[1] ?? 0)})`}>
                  <text textAnchor="middle" dominantBaseline="central" fontSize={fontSize}
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
      {themeDef.attribution && <div className="map-attribution">{themeDef.attribution}</div>}
      <MapThemePicker active={mapTheme} onChange={setMapTheme} />
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
  // 0×0 sentinel: see WorldMap's dims state for why a desktop placeholder
  // would defeat the mobile initial-transform effect.
  const [dims2, setDims2]         = useState({ w: 0, h: 0 });
  const [loading2, setLoading2]   = useState(true);
  const [mapTheme, setMapTheme]   = useMapTheme();

  const xf2Ref  = useRef({ k: 1, tx: 0, ty: 0 });
  const [xf2, setXf2] = useState({ k: 1, tx: 0, ty: 0 });
  const drag2Ref = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const projDims2Ref = useRef({ w: 0, h: 0 });
  const didInit2Ref = useRef(false);
  const dims2Ref = useRef({ w: 0, h: 0 });
  dims2Ref.current = dims2;
  const pointers2Ref = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch2Ref = useRef<{ initialDist: number; initialK: number; initialTx: number; initialTy: number } | null>(null);

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

  // Apply the mobile-aware initial transform once dims is known.
  useEffect(() => {
    if (dims2.w === 0) return;
    if (didInit2Ref.current) return;
    didInit2Ref.current = true;
    const init = initialTransform(dims2.w, dims2.h);
    xf2Ref.current = init;
    setXf2(init);
  }, [dims2]);

  /* zoom */
  const applyZoom2 = useCallback((newK: number, focalX?: number, focalY?: number) => {
    const old = xf2Ref.current;
    const k   = clamp(newK, ZOOM_MIN, ZOOM_MAX);
    const fx  = focalX ?? dims2.w / 2;
    const fy  = focalY ?? dims2.h / 2;
    const ratio = k / old.k;
    const { tx, ty } = clampPan(fx - ratio*(fx-old.tx), fy - ratio*(fy-old.ty), k, dims2.w, dims2.h);
    const next  = { k, tx, ty };
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "0" || e.key === "1") {
        const reset = initialTransform(dims2Ref.current.w, dims2Ref.current.h);
        xf2Ref.current = reset; setXf2(reset);
        e.preventDefault();
        return;
      }
      const presetK = ZOOM_PRESETS[e.key];
      if (presetK !== undefined) {
        applyZoom2(presetK);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyZoom2]);

  const onPD2 = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    pointers2Ref.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers2Ref.current.size === 1) {
      drag2Ref.current = { sx: e.clientX, sy: e.clientY, tx0: xf2Ref.current.tx, ty0: xf2Ref.current.ty };
    } else if (pointers2Ref.current.size === 2) {
      drag2Ref.current = null;
      const pts = Array.from(pointers2Ref.current.values());
      pinch2Ref.current = {
        initialDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        initialK: xf2Ref.current.k,
        initialTx: xf2Ref.current.tx,
        initialTy: xf2Ref.current.ty,
      };
    }
  };
  const onPM2 = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers2Ref.current.has(e.pointerId)) return;
    pointers2Ref.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers2Ref.current.size >= 2 && pinch2Ref.current) {
      const rect = containerRef.current?.getBoundingClientRect(); if (!rect) return;
      const pts = Array.from(pointers2Ref.current.values()).slice(0, 2);
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const newK = clamp(pinch2Ref.current.initialK * (dist / pinch2Ref.current.initialDist), ZOOM_MIN, ZOOM_MAX);
      const fx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const fy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const r = newK / pinch2Ref.current.initialK;
      const { tx, ty } = clampPan(fx - r*(fx - pinch2Ref.current.initialTx), fy - r*(fy - pinch2Ref.current.initialTy), newK, dims2.w, dims2.h);
      const next = { k: newK, tx, ty };
      xf2Ref.current = next; setXf2({ ...next });
      return;
    }
    if (!drag2Ref.current) return;
    const { k } = xf2Ref.current;
    const { tx, ty } = clampPan(
      drag2Ref.current.tx0 + e.clientX - drag2Ref.current.sx,
      drag2Ref.current.ty0 + e.clientY - drag2Ref.current.sy,
      k, dims2.w, dims2.h,
    );
    const next  = { k, tx, ty };
    xf2Ref.current = next; setXf2({ ...next });
  };
  const onPU2 = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers2Ref.current.delete(e.pointerId);
    if (pointers2Ref.current.size < 2) pinch2Ref.current = null;
    if (pointers2Ref.current.size === 1) {
      const remaining = Array.from(pointers2Ref.current.values())[0];
      drag2Ref.current = { sx: remaining.x, sy: remaining.y, tx0: xf2Ref.current.tx, ty0: xf2Ref.current.ty };
    } else if (pointers2Ref.current.size === 0) {
      drag2Ref.current = null;
    }
  };

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

  /* Track largest feature per topoId to avoid duplicate labels (e.g. Somaliland→Somalia) */
  const maxAreaById2 = new Map<string, number>();
  computed2.forEach(cf => {
    if ((maxAreaById2.get(cf.id) ?? -1) < cf.area) maxAreaById2.set(cf.id, cf.area);
  });

  const cssTransform2 = `translate(${xf2.tx}px,${xf2.ty}px) scale(${xf2.k})`;
  const labelScale2   = 1 / xf2.k;

  const themeDef = MAP_THEMES[mapTheme];
  return (
    <div ref={containerRef} className={`map-container-inner map-theme-${mapTheme}`} style={themeDef.vars as React.CSSProperties}>
      <svg ref={svgRef} viewBox={`0 0 ${dims2.w} ${dims2.h}`} className="world-svg"
        style={{ width: "100%", height: "100%", cursor: drag2Ref.current ? "grabbing" : "grab", touchAction: "none" }}
        aria-label="Rota haritası"
        onPointerDown={onPD2} onPointerMove={onPM2} onPointerUp={onPU2} onPointerCancel={onPU2}
      >
        <rect width={dims2.w} height={dims2.h} fill="var(--ocean)" />
        <g style={{ transform: cssTransform2, transformOrigin: "0 0" }}>
          {themeDef.imageUrl && (
            <image href={themeDef.imageUrl}
              x={0} y={(dims2.h - dims2.w / 2) / 2}
              width={dims2.w} height={dims2.w / 2}
              preserveAspectRatio="none"
              style={{ pointerEvents: "none" }}
            />
          )}
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
              cf.area === maxAreaById2.get(cf.id) &&
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
      {themeDef.attribution && <div className="map-attribution">{themeDef.attribution}</div>}
      <MapThemePicker active={mapTheme} onChange={setMapTheme} />
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
  // 0×0 sentinel: see WorldMap's dims state for why a desktop placeholder
  // would defeat the mobile initial-transform effect.
  const [dims3, setDims3]         = useState({ w: 0, h: 0 });
  const [loading3, setLoading3]   = useState(true);
  const [mapTheme, setMapTheme]   = useMapTheme();

  const xf3Ref  = useRef({ k: 1, tx: 0, ty: 0 });
  const [xf3, setXf3] = useState({ k: 1, tx: 0, ty: 0 });
  const drag3Ref = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const proj3Ref = useRef({ w: 0, h: 0 });
  const didInit3Ref = useRef(false);
  const dims3Ref = useRef({ w: 0, h: 0 });
  dims3Ref.current = dims3;
  const pointers3Ref = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch3Ref = useRef<{ initialDist: number; initialK: number; initialTx: number; initialTy: number } | null>(null);

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

  // Apply the mobile-aware initial transform once dims is known. Skipped when
  // a region is set (the auto-fit effect below picks the framing instead).
  useEffect(() => {
    if (dims3.w === 0) return;
    if (region && region !== "world") return;
    if (didInit3Ref.current) return;
    didInit3Ref.current = true;
    const init = initialTransform(dims3.w, dims3.h);
    xf3Ref.current = init;
    setXf3(init);
  }, [dims3, region]);

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
    const r = k/old.k;
    const { tx, ty } = clampPan(_fx - r*(_fx-old.tx), _fy - r*(_fy-old.ty), k, dims3.w, dims3.h);
    const next = { k, tx, ty };
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "0" || e.key === "1") {
        const reset = initialTransform(dims3Ref.current.w, dims3Ref.current.h);
        xf3Ref.current = reset; setXf3(reset);
        e.preventDefault();
        return;
      }
      const presetK = ZOOM_PRESETS[e.key];
      if (presetK !== undefined) {
        applyZoom3(presetK);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyZoom3]);

 const onPD3 = (e: ReactPointerEvent<SVGSVGElement>) => {
  e.preventDefault();
  e.stopPropagation();

  svgRef.current?.setPointerCapture(e.pointerId);
  pointers3Ref.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers3Ref.current.size === 1) {
    drag3Ref.current = { sx:e.clientX, sy:e.clientY, tx0:xf3Ref.current.tx, ty0:xf3Ref.current.ty };
  } else if (pointers3Ref.current.size === 2) {
    drag3Ref.current = null;
    const pts = Array.from(pointers3Ref.current.values());
    pinch3Ref.current = {
      initialDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      initialK: xf3Ref.current.k,
      initialTx: xf3Ref.current.tx,
      initialTy: xf3Ref.current.ty,
    };
  }
  };
  const onPM3 = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers3Ref.current.has(e.pointerId)) return;
    pointers3Ref.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers3Ref.current.size >= 2 && pinch3Ref.current) {
      const rect = containerRef.current?.getBoundingClientRect(); if (!rect) return;
      const pts = Array.from(pointers3Ref.current.values()).slice(0, 2);
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const newK = clamp(pinch3Ref.current.initialK * (dist / pinch3Ref.current.initialDist), ZOOM_MIN, ZOOM_MAX);
      const fx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const fy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const r = newK / pinch3Ref.current.initialK;
      const { tx, ty } = clampPan(fx - r*(fx - pinch3Ref.current.initialTx), fy - r*(fy - pinch3Ref.current.initialTy), newK, dims3.w, dims3.h);
      const next = { k: newK, tx, ty };
      xf3Ref.current = next; setXf3({ ...next });
      return;
    }
    if (!drag3Ref.current) return;
    const { k } = xf3Ref.current;
    const { tx, ty } = clampPan(
      drag3Ref.current.tx0 + e.clientX - drag3Ref.current.sx,
      drag3Ref.current.ty0 + e.clientY - drag3Ref.current.sy,
      k, dims3.w, dims3.h,
    );
    const next = { k, tx, ty };
    xf3Ref.current = next; setXf3({...next});
  };
  const onPU3 = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers3Ref.current.delete(e.pointerId);
    if (pointers3Ref.current.size < 2) pinch3Ref.current = null;
    if (pointers3Ref.current.size === 1) {
      const remaining = Array.from(pointers3Ref.current.values())[0];
      drag3Ref.current = { sx: remaining.x, sy: remaining.y, tx0: xf3Ref.current.tx, ty0: xf3Ref.current.ty };
    } else if (pointers3Ref.current.size === 0) {
      drag3Ref.current = null;
    }
  };

  if (loading3 || computed3.length === 0) {
    return <div ref={containerRef} className="map-container-inner"><div className="map-loading"><div className="spinner"/><span>Harita yükleniyor…</span></div></div>;
  }

  const t3 = `translate(${xf3.tx}px,${xf3.ty}px) scale(${xf3.k})`;

  const maxAreaById3 = new Map<string, number>();
  computed3.forEach(cf => {
    if ((maxAreaById3.get(cf.id) ?? -1) < cf.area) maxAreaById3.set(cf.id, cf.area);
  });

  const themeDef = MAP_THEMES[mapTheme];
  return (
    <div ref={containerRef} className={`map-container-inner map-theme-${mapTheme}`} style={themeDef.vars as React.CSSProperties}>
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
          {themeDef.imageUrl && (
            <image href={themeDef.imageUrl}
              x={0} y={(dims3.h - dims3.w / 2) / 2}
              width={dims3.w} height={dims3.w / 2}
              preserveAspectRatio="none"
              style={{ pointerEvents: "none" }}
            />
          )}
          {computed3.map(cf => {
            const isMine = myTopoIds.has(cf.id);
            const isOpp  = oppTopoIds.has(cf.id);
            const isSecondary3 = cf.area < (maxAreaById3.get(cf.id) ?? cf.area);
            const cls = ["country-path", isMine ? "duel-mine" : isOpp ? "duel-opp" : "", isSecondary3 ? "merged-secondary" : ""].filter(Boolean).join(" ");
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

  // duplicate-label guard (Somaliland→Somalia, W. Sahara→Morocco share an id;
  // only the largest polygon for each id gets a label).
  if (cf.area < (maxAreaById3.get(cf.id) ?? cf.area)) return false;

  // Always-on for prominent mid-large countries; otherwise zoom-aware threshold.
  if (ALWAYS_LABEL_IDS.has(cf.id)) return true;
  if (cf.area < visibleAreaMin(xf3.k)) return false;

  return true;
})
              .map(cf => {
                // Screen-pixel target size, divided by k to compensate for the
                // <g> scale wrapping the labels. See labelScreenSize() docs.
                const fontSize = labelScreenSize(cf.area, xf3.k) / xf3.k;
                return (
                  <g key={"dl-" + cf.id} transform={`translate(${cf.cx + (LABEL_OFFSET[cf.id]?.[0] ?? 0)},${cf.cy + (LABEL_OFFSET[cf.id]?.[1] ?? 0)})`}>
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={fontSize}
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
      {themeDef.attribution && <div className="map-attribution">{themeDef.attribution}</div>}
      <MapThemePicker active={mapTheme} onChange={setMapTheme} />

      {/* Legend */}
      <div className="duel-legend">
        <span className="duel-legend-item duel-legend-mine">● Ben</span>
        <span className="duel-legend-item duel-legend-opp">● Rakip</span>
      </div>
    </div>
  );
}
