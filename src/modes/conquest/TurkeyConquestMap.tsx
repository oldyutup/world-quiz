/**
 * TurkeyConquestMap — stylised inline-SVG map for Türkiye Kuşatması.
 *
 * Seven polygons cover the outer Turkey silhouette (viewBox 900×385).
 * Each polygon is independently coloured by the owning player's colour,
 * highlighted when it is a legal action target, and flashes red on an
 * illegal click.  No gameplay logic lives here — all decisions are made
 * by the parent through props.
 *
 * Region-id → SVG polygon mapping:
 *   marmara           → NW trapezoid  (5,10  240,10  240,140  185,185  5,185)
 *   karadeniz         → N rectangle   (240,10  680,10  680,140  240,140)
 *   ege               → W rectangle   (5,185  185,185  185,310  5,310)
 *   ic_anadolu        → centre hex    (185,185  240,140  680,140  640,265  580,310  185,310)
 *   akdeniz           → S trapezoid   (5,310  185,310  580,310  600,375  5,375)
 *   dogu_anadolu      → E quad        (680,10  895,60  895,265  640,265  680,140)
 *   guneydogu_anadolu → SE pentagon   (640,265  895,265  895,375  600,375  580,310)
 *
 * Adjacent shared edges ensure zero gaps between polygons.
 */

import { useCallback } from "react";
import type {
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";

// ─── Region geometry ─────────────────────────────────────────────────────────

interface RegionDef {
  id:      ConquestRegionId;
  points:  string;
  labelX:  number;
  labelY:  number;
  label:   string;
}

const REGION_DEFS: RegionDef[] = [
  {
    id:     "marmara",
    points: "5,10 240,10 240,140 185,185 5,185",
    labelX: 113, labelY: 97,
    label:  "Marmara",
  },
  {
    id:     "karadeniz",
    points: "240,10 680,10 680,140 240,140",
    labelX: 460, labelY: 75,
    label:  "Karadeniz",
  },
  {
    id:     "ege",
    points: "5,185 185,185 185,310 5,310",
    labelX: 95, labelY: 248,
    label:  "Ege",
  },
  {
    id:     "ic_anadolu",
    points: "185,185 240,140 680,140 640,265 580,310 185,310",
    labelX: 415, labelY: 228,
    label:  "İç Anadolu",
  },
  {
    id:     "akdeniz",
    points: "5,310 185,310 580,310 600,375 5,375",
    labelX: 292, labelY: 344,
    label:  "Akdeniz",
  },
  {
    id:     "dogu_anadolu",
    points: "680,10 895,60 895,265 640,265 680,140",
    labelX: 786, labelY: 160,
    label:  "Doğu Anadolu",
  },
  {
    id:     "guneydogu_anadolu",
    points: "640,265 895,265 895,375 600,375 580,310",
    labelX: 748, labelY: 323,
    label:  "Güneydoğu",
  },
];

// ─── Colour palette ───────────────────────────────────────────────────────────

interface ColorTokens {
  fill:        string;
  stroke:      string;
  text:        string;
  legalFill:   string;
  legalStroke: string;
}

const COLOR_MAP: Record<string, ColorTokens> = {
  red:     { fill: "rgba(239,68,68,0.20)",   stroke: "rgba(239,68,68,0.58)",   text: "#fca5a5", legalFill: "rgba(239,68,68,0.38)",   legalStroke: "#ef4444" },
  blue:    { fill: "rgba(59,130,246,0.20)",   stroke: "rgba(59,130,246,0.58)",  text: "#93c5fd", legalFill: "rgba(59,130,246,0.38)",   legalStroke: "#3b82f6" },
  green:   { fill: "rgba(34,197,94,0.20)",    stroke: "rgba(34,197,94,0.58)",   text: "#86efac", legalFill: "rgba(34,197,94,0.38)",    legalStroke: "#22c55e" },
  yellow:  { fill: "rgba(234,179,8,0.20)",    stroke: "rgba(234,179,8,0.58)",   text: "#fde047", legalFill: "rgba(234,179,8,0.38)",    legalStroke: "#eab308" },
  purple:  { fill: "rgba(168,85,247,0.20)",   stroke: "rgba(168,85,247,0.58)",  text: "#d8b4fe", legalFill: "rgba(168,85,247,0.38)",   legalStroke: "#a855f7" },
  orange:  { fill: "rgba(249,115,22,0.20)",   stroke: "rgba(249,115,22,0.58)",  text: "#fdba74", legalFill: "rgba(249,115,22,0.38)",   legalStroke: "#f97316" },
  neutral: { fill: "rgba(148,163,184,0.07)",  stroke: "rgba(148,163,184,0.22)", text: "rgba(148,163,184,0.60)", legalFill: "rgba(148,163,184,0.20)", legalStroke: "rgba(148,163,184,0.70)" },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  regionStates:   ConquestRegionState[];
  players:        ConquestPlayer[];
  playerColors:   Record<string, ConquestPlayerColor>;
  legalTargetIds: Set<ConquestRegionId>;
  disabled?:      boolean;
  onRegionClick?: (id: ConquestRegionId) => void;
  flashRegionId?: ConquestRegionId | null;
}

export default function TurkeyConquestMap({
  regionStates,
  players,
  playerColors,
  legalTargetIds,
  disabled = false,
  onRegionClick,
  flashRegionId,
}: Props) {
  const stateById  = Object.fromEntries(regionStates.map(rs => [rs.regionId, rs]));
  const playerById = Object.fromEntries(players.map(p  => [p.id, p]));
  const interactive = !!onRegionClick && !disabled;

  const handleKey = useCallback((
    e: React.KeyboardEvent,
    id: ConquestRegionId,
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRegionClick?.(id);
    }
  }, [onRegionClick]);

  return (
    <div className="cq-turkey-map-wrap">
      <svg
        viewBox="0 0 900 385"
        preserveAspectRatio="xMidYMid meet"
        className="cq-turkey-map-svg"
        aria-label="Türkiye Kuşatması haritası"
        role="img"
      >
        {REGION_DEFS.map(rdef => {
          const rs      = stateById[rdef.id];
          const owner   = rs?.ownerPlayerId ? playerById[rs.ownerPlayerId] : null;
          const colorKey = owner ? (playerColors[owner.id] ?? "neutral") : "neutral";
          const c        = COLOR_MAP[colorKey] ?? COLOR_MAP.neutral;
          const isLegal  = legalTargetIds.has(rdef.id);
          const isFlash  = flashRegionId === rdef.id;
          const isDimmed = interactive && !isLegal;

          const fill     = isLegal ? c.legalFill   : c.fill;
          const stroke   = isLegal ? c.legalStroke : c.stroke;
          const strokeW  = isLegal ? 2.5 : 1.5;

          return (
            <g key={rdef.id}>
              {/* Main region polygon */}
              <polygon
                points={rdef.points}
                className="cq-map-region"
                data-interactive={interactive ? "" : undefined}
                data-legal={isLegal ? "" : undefined}
                style={{ fill, stroke, strokeWidth: strokeW, opacity: isDimmed ? 0.48 : 1 }}
                onClick={interactive ? () => onRegionClick!(rdef.id) : undefined}
                onKeyDown={interactive ? (e) => handleKey(e, rdef.id) : undefined}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? (isLegal ? 0 : -1) : undefined}
                aria-label={`${rdef.label}${owner ? ` — ${owner.name}` : " — Tarafsız"}${isLegal ? " (hedef)" : ""}`}
              />

              {/* Pulsing outline for legal targets.
                  fill/stroke/strokeWidth as SVG presentation attributes
                  (not inline style) so @keyframes cqMapPulse can override them. */}
              {isLegal && (
                <polygon
                  points={rdef.points}
                  className="cq-map-pulse-ring"
                  fill="none"
                  stroke={stroke}
                  strokeWidth={3}
                  aria-hidden="true"
                />
              )}

              {/* Flash overlay for illegal click (separate element avoids inline-style conflict) */}
              {isFlash && (
                <polygon
                  points={rdef.points}
                  className="cq-map-flash-overlay"
                  aria-hidden="true"
                />
              )}

              {/* Region name label */}
              <text
                x={rdef.labelX}
                y={rdef.labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className="cq-map-label"
                style={{ fill: c.text, pointerEvents: "none", userSelect: "none" }}
              >
                {rdef.label}
              </text>

              {/* Owner name (shown below region name when owned) */}
              {owner && (
                <text
                  x={rdef.labelX}
                  y={rdef.labelY + 17}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="cq-map-owner-label"
                  style={{ fill: c.text, pointerEvents: "none", userSelect: "none" }}
                >
                  {owner.name}
                </text>
              )}
            </g>
          );
        })}

        {/* Outer Turkey silhouette border */}
        <polygon
          points="5,10 680,10 895,60 895,375 5,375"
          fill="none"
          stroke="rgba(255,255,255,0.13)"
          strokeWidth={2}
          aria-hidden="true"
          style={{ pointerEvents: "none" }}
        />

        {/* Interior region dividers drawn on top for crispness */}
        <g
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={1}
          aria-hidden="true"
          style={{ pointerEvents: "none" }}
        >
          <line x1="240" y1="10"  x2="240" y2="140" />
          <line x1="240" y1="140" x2="680" y2="140" />
          <line x1="680" y1="10"  x2="680" y2="140" />
          <line x1="5"   y1="185" x2="185" y2="185" />
          <line x1="185" y1="185" x2="240" y2="140" />
          <line x1="185" y1="185" x2="185" y2="310" />
          <line x1="185" y1="310" x2="5"   y2="310" />
          <line x1="185" y1="310" x2="580" y2="310" />
          <line x1="580" y1="310" x2="640" y2="265" />
          <line x1="640" y1="265" x2="680" y2="140" />
          <line x1="640" y1="265" x2="895" y2="265" />
          <line x1="580" y1="310" x2="600" y2="375" />
        </g>
      </svg>
    </div>
  );
}
