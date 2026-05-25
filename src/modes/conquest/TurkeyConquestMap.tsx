/**
 * TurkeyConquestMap — merged-region SVG map for Türkiye Kuşatması.
 *
 * Renders 24 conquest-region paths produced by unioning the underlying 81
 * province shapes (see scripts/build-turkey-regions.ts).  No province
 * subdivisions are visible — each region is one clean shape.
 *
 * viewBox: 0 0 1005 490 (matches the source province data).
 *
 * Visual layers (back → front):
 *  1  fills – one path per region (fill + region-coloured border stroke,
 *             evenodd handles non-contiguous regions like Istanbul or KD-Anadolu)
 *  2  pulse – legal-target animated pulse rings (one per legal region)
 *  3  flash – illegal-click flash overlay (one path, the flashing region)
 *  4  label – region labels with dark text-outline for readability
 */

import { useCallback } from "react";
import type {
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";
import { TURKEY_CONQUEST_REGION_PATHS } from "./maps/turkey-regions";
import { getRegionPoints } from "./regionPoints";
import { REGION_BONUSES } from "./regionBonuses";

// Per-region offset (in SVG units) for the point badge, relative to label
// position. Default = badge sits just above the region label. Override only
// where the default would collide with another label or the map edge.
const REGION_BADGE_OFFSET: Record<string, { dx: number; dy: number }> = {
  trakya:           { dx: -2, dy: -26 },
  istanbul_kocaeli: { dx: 34,  dy: -1 },
  kuzeydogu_anadolu:{ dx: 0,   dy: -14 },
  guney_marmara: { dx: 0, dy: -24 },
  kuzey_ege: { dx: 0, dy: -24 },
  dogu_karadeniz: { dx: 0, dy: -24 },
  orta_karadeniz: { dx: 0, dy: -24 },
  bati_karadeniz: { dx: 0, dy: -24 },
  ic_bati_anadolu: { dx: 0, dy: -18 },
  ankara_cevre: { dx: 0, dy: -18 },
};
const DEFAULT_BADGE_OFFSET = { dx: 0, dy: -14 };

// ─── Terrain texture underlay ─────────────────────────────────────────────────
// One bitmap stamped through every region path via an SVG <pattern>. The
// shape of "Türkiye" is therefore always the union of the region SVG paths —
// guaranteed pixel-perfect with the foreground map. Swap the PNG to retune
// the look; no code change needed.
const TERRAIN_IMAGE_HREF    = "/assets/backgrounds/turkey-terrain-texture.png?v=1779635172";
const TERRAIN_PATTERN_ID    = "cqTurkeyTerrainImage";
const MAP_VIEWBOX_W         = 1005;
const MAP_VIEWBOX_H         = 490;

// ─── Region label text ────────────────────────────────────────────────────────

const REGION_LABELS: Record<string, string> = {
  trakya:             "Trakya",
  istanbul_kocaeli:   "İstanbul",
  guney_marmara:      "G. Marmara",
  bati_karadeniz:     "Batı Kara.",
  orta_karadeniz:     "Orta Kara.",
  dogu_karadeniz:     "Doğu Kara.",
  kuzeydogu_anadolu:  "KD Anadolu",
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
  kars: "Kars",
};

// ─── Region label positions in the 1005×490 SVG coordinate space ─────────────

const REGION_LABEL_POS: Record<string, { x: number; y: number }> = {
  trakya:             { x:  90, y:  56 },
  istanbul_kocaeli:   { x: 190, y: 85 },
  guney_marmara:      { x: 130, y: 155 },
  bati_karadeniz:     { x: 378, y:  68 },
  orta_karadeniz:     { x: 508, y: 110 },
  dogu_karadeniz:     { x: 720, y: 132 },
  kuzeydogu_anadolu:  { x: 710, y: 186 },
  kars:               { x: 915, y: 176 },
  kuzey_ege:          { x: 112, y: 243 },
  guney_ege:          { x: 132, y: 320 },
  bati_akdeniz:       { x: 235, y: 345 },
  cukurova:           { x: 462, y: 362 },
  ic_bati_anadolu:    { x: 255, y: 205 },
  ankara_cevre:       { x: 380, y: 165 },
  konya_karaman:      { x: 352, y: 298 },
  kapadokya:          { x: 490, y: 270 },
  orta_anadolu:       { x: 555, y: 195 },
  erzurum_kars:       { x: 820, y: 172 },
  van_hakkari:        { x: 906, y: 258 },
  malatya_elazig:     { x: 678, y: 268 },
  firat_hatti:        { x: 648, y: 320 },
  dicle_hatti:        { x: 785, y: 285 },
  antep_kilis:        { x: 610, y: 362 },
  hatay_osmaniye:     { x: 552, y: 386 },
  mardin_sirnak:      { x: 840, y: 330 },
};

// ─── Colour palette ───────────────────────────────────────────────────────────

interface ColorTokens {
  fill:         string;
  regionBorder: string;
  text:         string;
  legalFill:    string;
  legalStroke:  string;
}

const COLOR_MAP: Record<string, ColorTokens> = {
  red:     { fill: "rgba(239,68,68,0.28)",   regionBorder: "rgba(239,68,68,0.88)",   text: "#fca5a5", legalFill: "rgba(239,68,68,0.52)",   legalStroke: "#ef4444" },
  blue:    { fill: "rgba(59,130,246,0.28)",   regionBorder: "rgba(59,130,246,0.88)",  text: "#93c5fd", legalFill: "rgba(59,130,246,0.52)",   legalStroke: "#3b82f6" },
  green:   { fill: "rgba(34,197,94,0.28)",    regionBorder: "rgba(34,197,94,0.88)",   text: "#86efac", legalFill: "rgba(34,197,94,0.52)",    legalStroke: "#22c55e" },
  yellow:  { fill: "rgba(234,179,8,0.28)",    regionBorder: "rgba(234,179,8,0.88)",   text: "#fde047", legalFill: "rgba(234,179,8,0.52)",    legalStroke: "#eab308" },
  purple:  { fill: "rgba(168,85,247,0.28)",   regionBorder: "rgba(168,85,247,0.88)",  text: "#d8b4fe", legalFill: "rgba(168,85,247,0.52)",   legalStroke: "#a855f7" },
  orange:  { fill: "rgba(249,115,22,0.28)",   regionBorder: "rgba(249,115,22,0.88)",  text: "#fdba74", legalFill: "rgba(249,115,22,0.52)",   legalStroke: "#f97316" },
  neutral: { fill: "rgba(148,163,184,0.15)",  regionBorder: "rgba(148,196,228,0.72)", text: "rgba(203,213,225,0.82)", legalFill: "rgba(148,163,184,0.34)", legalStroke: "rgba(165,215,245,0.96)" },
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
  const stateById   = Object.fromEntries(regionStates.map((rs) => [rs.regionId, rs]));
  const playerById  = Object.fromEntries(players.map((p) => [p.id, p]));
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
  const regionEntries = TURKEY_CONQUEST_REGION_PATHS.map(({ id, d }) => {
    const rid       = id as ConquestRegionId;
    const rs        = stateById[id];
    const owner     = rs?.ownerPlayerId ? playerById[rs.ownerPlayerId] : null;
    const colorKey  = owner ? (playerColors[owner.id] ?? "neutral") : "neutral";
    const c         = COLOR_MAP[colorKey] ?? COLOR_MAP.neutral;
    const isLegal   = legalTargetIds.has(rid);
    const isFlash   = flashRegionId === id;
    const isDimmed  = interactive && !isLegal;
    const isShielded = !!rs?.shielded;          // open shield (İstanbul)
    const fill      = isLegal ? c.legalFill   : c.fill;
    const stroke    = isLegal ? c.legalStroke : c.regionBorder;
    const labelPos  = REGION_LABEL_POS[id] ?? { x: 0, y: 0 };
    const label     = REGION_LABELS[id]    ?? id;
    return { rid, id, d, owner, c, isLegal, isFlash, isDimmed, isShielded, fill, stroke, labelPos, label };
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
        {/* ── Defs: terrain bitmap pattern, sized to the SVG viewBox so it
             stamps once across the whole map and gets clipped by each region
             path. Drop a new PNG at TERRAIN_IMAGE_HREF to retune the look. */}
        <defs>
          <pattern
            id={TERRAIN_PATTERN_ID}
            patternUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={MAP_VIEWBOX_W}
            height={MAP_VIEWBOX_H}
          >
            <image
              href={TERRAIN_IMAGE_HREF}
              x="0"
              y="0"
              width={MAP_VIEWBOX_W}
              height={MAP_VIEWBOX_H}
              preserveAspectRatio="xMidYMid slice"
            />
          </pattern>
        </defs>

        {/* ── Layer 0: terrain image underlay (purely visual; never intercepts clicks) ── */}
        <g className="cq-terrain-image-underlay" pointerEvents="none" aria-hidden="true">
          {regionEntries.map(({ id, d }) => (
            <path
              key={`terrain-img-${id}`}
              d={d}
              className="cq-region-terrain-image"
              fill={`url(#${TERRAIN_PATTERN_ID})`}
              fillRule="evenodd"
            />
          ))}
        </g>


        {/* ── Layer 1: region fills + borders (single path per region) ── */}
        {regionEntries.map(({ rid, id, d, owner, isLegal, isDimmed, fill, stroke, label }) => (
          <path
            key={`region-${id}`}
            d={d}
            className="cq-map-region"
            fillRule="evenodd"
            data-interactive={interactive ? "" : undefined}
            data-legal={isLegal ? "" : undefined}
            style={{
              fill,
              stroke,
              opacity: isDimmed ? 0.45 : 1,
            }}
            onClick={
  interactive
    ? () => {
        console.log("Tıklanan bölge:", id, "rid:", rid, "label:", label);
        onRegionClick!(rid);
      }
    : undefined
}
            onKeyDown={interactive ? (e) => handleKey(e, rid) : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? (isLegal ? 0 : -1) : undefined}
            aria-label={`${REGION_LABELS[id] ?? id}${owner ? ` — ${owner.name}` : " — Tarafsız"}${isLegal ? " (hedef)" : ""}`}
          />
        ))}

        {/* ── Layer 2: legal-target pulse rings ──────────────────────── */}
        {regionEntries
          .filter((r) => r.isLegal)
          .map(({ id, d, c }) => (
            <path
              key={`pulse-${id}`}
              d={d}
              className="cq-map-pulse-ring"
              fillRule="evenodd"
              fill="none"
              stroke={c.legalStroke}
              strokeWidth={2}
              aria-hidden="true"
            />
          ))}

        {/* ── Layer 3: illegal-click flash overlay ───────────────────── */}
        {regionEntries
          .filter((r) => r.isFlash)
          .map(({ id, d }) => (
            <path
              key={`flash-${id}`}
              d={d}
              className="cq-map-flash-overlay"
              fillRule="evenodd"
              aria-hidden="true"
            />
          ))}

        {/* ── Layer 4: region labels (always on top) ─────────────────── */}
        {regionEntries.map(({ id, owner, c, labelPos, label }) => {
          const labelY = owner ? labelPos.y - 7 : labelPos.y;
          return (
            <g key={`lbl-${id}`} aria-hidden="true" style={{ pointerEvents: "none" }}>
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

        {/* ── Layer 4a: open-shield overlay (İstanbul bonus) ──────── */}
        <g className="cq-map-shield-layer" pointerEvents="none" aria-hidden="true">
          {regionEntries
            .filter(r => r.isShielded)
            .map(({ id, d }) => (
              <path
                key={`shield-${id}`}
                d={d}
                className="cq-map-shield-overlay"
                fillRule="evenodd"
                fill="none"
                strokeWidth={3}
              />
            ))}
        </g>

        {/* ── Layer 4b: bonus region icons (decorative; never intercepts clicks) ── */}
        <g className="cq-map-bonus-layer" pointerEvents="none" aria-hidden="true">
          {regionEntries.map(({ id, labelPos }) => {
            const bonus = REGION_BONUSES[id];
            if (!bonus) return null;
            // Anchor the bonus glyph to the right of the point badge so they
            // never overlap; identical offset behaviour as the points badge.
            const off = REGION_BADGE_OFFSET[id] ?? DEFAULT_BADGE_OFFSET;
            const cx  = labelPos.x + off.dx + 18;
            const cy  = labelPos.y + off.dy;
            return (
              <text
                key={`bonus-${id}`}
                x={cx}
                y={cy + 0.5}
                textAnchor="middle"
                dominantBaseline="middle"
                className="cq-map-bonus-icon"
                style={{ fontSize: 11, userSelect: "none" }}
              >
                {bonus.icon}
              </text>
            );
          })}
        </g>

        {/* ── Layer 5: region point badges (decorative; never intercepts clicks) ── */}
        <g className="cq-map-points-layer" pointerEvents="none" aria-hidden="true">
          {regionEntries.map(({ id, labelPos }) => {
            const points = getRegionPoints(id);
            if (!points) return null;
            const off  = REGION_BADGE_OFFSET[id] ?? DEFAULT_BADGE_OFFSET;
            const cx   = labelPos.x + off.dx;
            const cy   = labelPos.y + off.dy;
            return (
              <g key={`pts-${id}`} className="cq-map-point-badge">
                <circle cx={cx} cy={cy} r={7.5} className="cq-map-point-badge-ring" />
                <text
                  x={cx}
                  y={cy + 0.5}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="cq-map-point-badge-text"
                >
                  {points}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
