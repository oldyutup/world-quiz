/**
 * ConquestRegionCard — a single territory tile on the Kuşatma board.
 *
 * The card is styled by a `data-color` attribute so CSS can apply the
 * correct color theming without inline styles.  This keeps the component
 * small and the colors centrally controlled from App.css.
 *
 * Phase-4 scope: display-only.  No click actions yet.  Shield icon is
 * rendered when `shielded=true` but does nothing — gameplay hooks come later.
 */

import type { ConquestPlayerColor, ConquestRegion } from "./types";

interface Props {
  region:        ConquestRegion;
  /** Null / undefined → region is neutral. */
  ownerColor?:   ConquestPlayerColor | null;
  ownerName?:    string;
  shielded?:     boolean;
  neighborCount: number;
}

export default function ConquestRegionCard({
  region,
  ownerColor,
  ownerName,
  shielded = false,
  neighborCount,
}: Props) {
  const isOwned   = ownerColor != null && ownerName != null;
  const colorAttr = isOwned ? ownerColor : "neutral";

  return (
    <div
      className="cq-region-card"
      data-color={colorAttr}
      role="gridcell"
      aria-label={`${region.name} — ${isOwned ? ownerName : "Tarafsız"}`}
    >
      <div className="cq-region-card-top">
        <span className="cq-region-dot" aria-hidden="true" />
        <span className="cq-region-name">
          {region.displayLabel ?? region.name}
        </span>
        {region.emoji && (
          <span className="cq-region-emoji" aria-hidden="true">
            {region.emoji}
          </span>
        )}
      </div>

      <div className="cq-region-meta">
        <span className="cq-region-neighbor-count">
          {neighborCount} komşu
        </span>
        {shielded && (
          <span className="cq-region-shield" aria-label="Kalkan aktif">
            🛡
          </span>
        )}
      </div>

      <div
        className="cq-region-owner"
        data-neutral={!isOwned ? "" : undefined}
        aria-label={isOwned ? `Sahip: ${ownerName}` : "Tarafsız bölge"}
      >
        {isOwned ? ownerName : "Tarafsız"}
      </div>
    </div>
  );
}
