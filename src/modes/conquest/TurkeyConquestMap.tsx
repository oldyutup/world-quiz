/**
 * TurkeyConquestMap — stylised grid SVG map for Türkiye Kuşatması.
 *
 * 24 regions arranged in a 6-column × 4-row grid (viewBox 900×370).
 * Each cell is an independent rect coloured by the owning player,
 * highlighted when it is a legal action target, and flashes on an
 * illegal click.  No gameplay logic lives here.
 *
 * Grid layout (col, row):
 *   Row 0: trakya(0) istanbul_kocaeli(1) bati_karadeniz(2) orta_karadeniz(3) dogu_karadeniz(4) kuzeydogu_anadolu(5)
 *   Row 1: kuzey_ege(0) guney_marmara(1) ic_bati_anadolu(2) ankara_cevre(3) orta_anadolu(4) erzurum_kars(5)
 *   Row 2: guney_ege(0) bati_akdeniz(1) konya_karaman(2) kapadokya(3) malatya_elazig(4) van_hakkari(5)
 *   Row 3: hatay_osmaniye(0) cukurova(1) firat_hatti(2) dicle_hatti(3) antep_kilis(4) mardin_sirnak(5)
 */

import { useCallback } from "react";
import type {
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";

// ─── Grid geometry ────────────────────────────────────────────────────────────

const CW = 146;   // cell width  (px in SVG units)
const CH = 86;    // cell height
const CX = 150;   // column step (CW + 4 gap)
const CY = 92;    // row step    (CH + 6 gap)
const MX = 2;     // left/right margin
const MY = 2;     // top/bottom margin

interface RegionDef {
  id:    ConquestRegionId;
  x:     number;
  y:     number;
  cx:    number;  // label centre x
  cy:    number;  // label centre y
  label: string;
}

function cell(
  col: number,
  row: number,
  id: ConquestRegionId,
  label: string,
): RegionDef {
  const x = col * CX + MX;
  const y = row * CY + MY;
  return { id, x, y, cx: x + CW / 2, cy: y + CH / 2, label };
}

const REGION_DEFS: RegionDef[] = [
  // Row 0 — Northern band
  cell(0, 0, "trakya",            "Trakya"),
  cell(1, 0, "istanbul_kocaeli",  "İstanbul"),
  cell(2, 0, "bati_karadeniz",    "Batı Kara."),
  cell(3, 0, "orta_karadeniz",    "Orta Kara."),
  cell(4, 0, "dogu_karadeniz",    "Doğu Kara."),
  cell(5, 0, "kuzeydogu_anadolu", "KD Anad."),
  // Row 1 — West + Central Anatolia
  cell(0, 1, "kuzey_ege",         "Kuzey Ege"),
  cell(1, 1, "guney_marmara",     "G. Marmara"),
  cell(2, 1, "ic_bati_anadolu",   "İç Batı"),
  cell(3, 1, "ankara_cevre",      "Ankara"),
  cell(4, 1, "orta_anadolu",      "Orta Anad."),
  cell(5, 1, "erzurum_kars",      "Erzurum"),
  // Row 2 — South Ege + South-Central + Far East
  cell(0, 2, "guney_ege",         "Güney Ege"),
  cell(1, 2, "bati_akdeniz",      "Batı Akd."),
  cell(2, 2, "konya_karaman",     "Konya"),
  cell(3, 2, "kapadokya",         "Kapadokya"),
  cell(4, 2, "malatya_elazig",    "Malatya"),
  cell(5, 2, "van_hakkari",       "Van"),
  // Row 3 — Southern band
  cell(0, 3, "hatay_osmaniye",    "Hatay"),
  cell(1, 3, "cukurova",          "Çukurova"),
  cell(2, 3, "firat_hatti",       "Fırat"),
  cell(3, 3, "dicle_hatti",       "Dicle"),
  cell(4, 3, "antep_kilis",       "Antep"),
  cell(5, 3, "mardin_sirnak",     "Mardin"),
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
        viewBox="0 0 900 370"
        preserveAspectRatio="xMidYMid meet"
        className="cq-turkey-map-svg"
        aria-label="Türkiye Kuşatması haritası"
        role="img"
      >
        {REGION_DEFS.map(rdef => {
          const rs       = stateById[rdef.id];
          const owner    = rs?.ownerPlayerId ? playerById[rs.ownerPlayerId] : null;
          const colorKey = owner ? (playerColors[owner.id] ?? "neutral") : "neutral";
          const c        = COLOR_MAP[colorKey] ?? COLOR_MAP.neutral;
          const isLegal  = legalTargetIds.has(rdef.id);
          const isFlash  = flashRegionId === rdef.id;
          const isDimmed = interactive && !isLegal;

          const fill    = isLegal ? c.legalFill   : c.fill;
          const stroke  = isLegal ? c.legalStroke : c.stroke;
          const strokeW = isLegal ? 2.5 : 1.5;

          // Shift label up slightly when owner name is shown below it.
          const labelY = owner ? rdef.cy - 9 : rdef.cy;

          return (
            <g key={rdef.id}>
              {/* Main region cell */}
              <rect
                x={rdef.x}
                y={rdef.y}
                width={CW}
                height={CH}
                rx={4}
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

              {/* Pulsing outline for legal targets */}
              {isLegal && (
                <rect
                  x={rdef.x}
                  y={rdef.y}
                  width={CW}
                  height={CH}
                  rx={4}
                  className="cq-map-pulse-ring"
                  fill="none"
                  stroke={stroke}
                  strokeWidth={3}
                  aria-hidden="true"
                />
              )}

              {/* Flash overlay for illegal click */}
              {isFlash && (
                <rect
                  x={rdef.x}
                  y={rdef.y}
                  width={CW}
                  height={CH}
                  rx={4}
                  className="cq-map-flash-overlay"
                  aria-hidden="true"
                />
              )}

              {/* Region name label */}
              <text
                x={rdef.cx}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className="cq-map-label"
                style={{ fill: c.text, pointerEvents: "none", userSelect: "none" }}
              >
                {rdef.label}
              </text>

              {/* Owner name shown below region label when owned */}
              {owner && (
                <text
                  x={rdef.cx}
                  y={rdef.cy + 10}
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

        {/* Outer border */}
        <rect
          x={MX}
          y={MY}
          width={6 * CX - (CX - CW)}
          height={4 * CY - (CY - CH)}
          rx={6}
          fill="none"
          stroke="rgba(255,255,255,0.13)"
          strokeWidth={2}
          aria-hidden="true"
          style={{ pointerEvents: "none" }}
        />
      </svg>
    </div>
  );
}
