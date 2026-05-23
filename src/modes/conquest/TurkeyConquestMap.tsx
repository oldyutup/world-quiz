/**
 * TurkeyConquestMap — real province SVG map for Türkiye Kuşatması.
 *
 * Renders all 81 Turkey province paths, grouped by conquest region.
 * Province path data: ali-han/Turkey-SVG-Map (MIT License).
 * viewBox: 0 0 1005 490.
 *
 * Interaction fires at the conquest-region level (24 regions), not at the
 * individual province level.  All provinces in a region share the same owner
 * colour, legal-target glow and flash overlay.
 */

import { useCallback } from "react";
import type {
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";
import { TURKEY_PROVINCES } from "./maps/turkey-provinces";

// ─── Province groups (module-level constant, not recomputed per render) ───────

const PROVINCES_BY_REGION: Record<string, typeof TURKEY_PROVINCES> =
  TURKEY_PROVINCES.reduce(
    (acc, p) => { (acc[p.conquestRegionId] ??= []).push(p); return acc; },
    {} as Record<string, typeof TURKEY_PROVINCES>,
  );

// ─── Region label text ────────────────────────────────────────────────────────

const REGION_LABELS: Record<string, string> = {
  trakya:             "Trakya",
  istanbul_kocaeli:   "İstanbul",
  guney_marmara:      "G. Marmara",
  bati_karadeniz:     "Batı Kara.",
  orta_karadeniz:     "Orta Kara.",
  dogu_karadeniz:     "Doğu Kara.",
  kuzeydogu_anadolu:  "KD Anad.",
  kuzey_ege:          "Kuzey Ege",
  guney_ege:          "Güney Ege",
  bati_akdeniz:       "Batı Akd.",
  cukurova:           "Çukurova",
  ic_bati_anadolu:    "İç Batı",
  ankara_cevre:       "Ankara",
  konya_karaman:      "Konya",
  kapadokya:          "Kapadokya",
  orta_anadolu:       "Orta Anad.",
  erzurum_kars:       "Erzurum",
  van_hakkari:        "Van",
  malatya_elazig:     "Malatya",
  firat_hatti:        "Fırat",
  dicle_hatti:        "Dicle",
  antep_kilis:        "Antep",
  hatay_osmaniye:     "Hatay",
  mardin_sirnak:      "Mardin",
};

// ─── Region label positions in the 1005×490 SVG coordinate space ─────────────

const REGION_LABEL_POS: Record<string, { x: number; y: number }> = {
  trakya:             { x:  68, y: 150 },
  istanbul_kocaeli:   { x: 200, y: 148 },
  guney_marmara:      { x: 188, y: 218 },
  bati_karadeniz:     { x: 312, y:  90 },
  orta_karadeniz:     { x: 462, y:  84 },
  dogu_karadeniz:     { x: 638, y:  92 },
  kuzeydogu_anadolu:  { x: 848, y: 132 },
  kuzey_ege:          { x: 105, y: 268 },
  guney_ege:          { x: 128, y: 368 },
  bati_akdeniz:       { x: 280, y: 390 },
  cukurova:           { x: 480, y: 402 },
  ic_bati_anadolu:    { x: 318, y: 262 },
  ankara_cevre:       { x: 448, y: 198 },
  konya_karaman:      { x: 436, y: 328 },
  kapadokya:          { x: 572, y: 298 },
  orta_anadolu:       { x: 572, y: 222 },
  erzurum_kars:       { x: 790, y: 195 },
  van_hakkari:        { x: 878, y: 318 },
  malatya_elazig:     { x: 678, y: 268 },
  firat_hatti:        { x: 608, y: 382 },
  dicle_hatti:        { x: 745, y: 375 },
  antep_kilis:        { x: 596, y: 432 },
  hatay_osmaniye:     { x: 530, y: 445 },
  mardin_sirnak:      { x: 812, y: 425 },
};

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
    regionId: ConquestRegionId,
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRegionClick?.(regionId);
    }
  }, [onRegionClick]);

  // Pre-compute per-region display state once per render.
  const regionEntries = Object.entries(PROVINCES_BY_REGION).map(([regionId, provinces]) => {
    const rid      = regionId as ConquestRegionId;
    const rs       = stateById[regionId];
    const owner    = rs?.ownerPlayerId ? playerById[rs.ownerPlayerId] : null;
    const colorKey = owner ? (playerColors[owner.id] ?? "neutral") : "neutral";
    const c        = COLOR_MAP[colorKey] ?? COLOR_MAP.neutral;
    const isLegal  = legalTargetIds.has(rid);
    const isFlash  = flashRegionId === regionId;
    const isDimmed = interactive && !isLegal;
    const fill     = isLegal ? c.legalFill   : c.fill;
    const stroke   = isLegal ? c.legalStroke : c.stroke;
    const labelPos = REGION_LABEL_POS[regionId] ?? { x: 0, y: 0 };
    const label    = REGION_LABELS[regionId]   ?? regionId;
    return { rid, regionId, provinces, owner, c, isLegal, isFlash, isDimmed, fill, stroke, labelPos, label };
  });

  return (
    <div className="cq-turkey-map-wrap">
      <svg
        viewBox="0 0 1005 490"
        preserveAspectRatio="xMidYMid meet"
        className="cq-turkey-map-svg"
        aria-label="Türkiye Kuşatması haritası"
        role="img"
      >
        {/* ── Layer 1: base province paths ─────────────────────── */}
        {regionEntries.map(({ rid, regionId, provinces, owner, isLegal, isDimmed, fill, stroke }) =>
          provinces.map((province, idx) => (
            <path
              key={province.id}
              d={province.d}
              className="cq-map-region"
              data-interactive={interactive ? "" : undefined}
              data-legal={isLegal ? "" : undefined}
              style={{
                fill,
                stroke,
                strokeWidth: 0.6,
                opacity: isDimmed ? 0.45 : 1,
              }}
              onClick={interactive ? () => onRegionClick!(rid) : undefined}
              onKeyDown={interactive ? (e) => handleKey(e, rid) : undefined}
              role={interactive ? "button" : undefined}
              // Only the first province in each region is a keyboard tab stop.
              tabIndex={interactive ? (isLegal && idx === 0 ? 0 : -1) : undefined}
              aria-label={`${province.name} (${REGION_LABELS[regionId] ?? regionId})${owner ? ` — ${owner.name}` : " — Tarafsız"}${isLegal ? " (hedef)" : ""}`}
            />
          ))
        )}

        {/* ── Layer 2: legal-target pulse rings ────────────────── */}
        {regionEntries
          .filter(r => r.isLegal)
          .flatMap(({ provinces, c }) =>
            provinces.map(province => (
              <path
                key={`pulse-${province.id}`}
                d={province.d}
                className="cq-map-pulse-ring"
                fill="none"
                stroke={c.legalStroke}
                strokeWidth={2}
                aria-hidden="true"
              />
            ))
          )}

        {/* ── Layer 3: illegal-click flash overlays ────────────── */}
        {regionEntries
          .filter(r => r.isFlash)
          .flatMap(({ provinces }) =>
            provinces.map(province => (
              <path
                key={`flash-${province.id}`}
                d={province.d}
                className="cq-map-flash-overlay"
                aria-hidden="true"
              />
            ))
          )}

        {/* ── Layer 4: conquest-region labels (24, always on top) ─ */}
        {regionEntries.map(({ regionId, owner, c, labelPos, label }) => {
          const labelY = owner ? labelPos.y - 7 : labelPos.y;
          return (
            <g key={`lbl-${regionId}`} aria-hidden="true" style={{ pointerEvents: "none" }}>
              <text
                x={labelPos.x}
                y={labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className="cq-map-label"
                style={{ fill: c.text, userSelect: "none" }}
              >
                {label}
              </text>
              {owner && (
                <text
                  x={labelPos.x}
                  y={labelPos.y + 9}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="cq-map-owner-label"
                  style={{ fill: c.text, userSelect: "none" }}
                >
                  {owner.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
