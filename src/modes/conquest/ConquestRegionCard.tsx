/**
 * ConquestRegionCard — a single territory tile on the Kuşatma board.
 *
 * The card is styled by a `data-color` attribute so CSS can apply the
 * correct color theming without inline styles.  This keeps the component
 * small and the colors centrally controlled from App.css.
 *
 * Click handling:
 *   - When `onClick` is provided the card renders as a <button> with the
 *     correct cursor/focus affordance.
 *   - `legal` adds a highlight ring (target is a valid action target).
 *   - `illegalFlash` momentarily flashes the card (parent toggles the prop
 *     after an invalid click).  Reverting the flash is the parent's job.
 *   - When no onClick is given the card renders as a div, preserving the
 *     original display-only behaviour for the lobby/preview screens.
 */

import type { ConquestPlayerColor, ConquestRegion } from "./types";

interface Props {
  region:         ConquestRegion;
  /** Null / undefined → region is neutral. */
  ownerColor?:    ConquestPlayerColor | null;
  ownerName?:     string;
  shielded?:      boolean;
  neighborCount:  number;
  /** When provided the card becomes interactive. */
  onClick?:       () => void;
  /** Highlight this card as a valid action target. */
  legal?:         boolean;
  /** Flash this card with a brief warning state (illegal click feedback). */
  illegalFlash?:  boolean;
  /** Disable interaction entirely (e.g. during round_result/finished). */
  disabled?:      boolean;
  /** Owner-only Pusu 🕳️ marker — true when the LOCAL viewer has armed an
   *  ambush on this region.  Opponents must NEVER receive this prop set,
   *  so the chip stays a strict owner-side intel. */
  myAmbushHere?:  boolean;
}

export default function ConquestRegionCard({
  region,
  ownerColor,
  ownerName,
  shielded = false,
  neighborCount,
  onClick,
  legal = false,
  illegalFlash = false,
  disabled = false,
  myAmbushHere = false,
}: Props) {
  const isOwned   = ownerColor != null && ownerName != null;
  const colorAttr = isOwned ? ownerColor : "neutral";
  const isInteractive = !!onClick && !disabled;

  const baseProps = {
    className: "cq-region-card",
    "data-color": colorAttr,
    "data-legal": legal ? "" : undefined,
    "data-illegal-flash": illegalFlash ? "" : undefined,
    "data-interactive": isInteractive ? "" : undefined,
    "aria-label": `${region.name} — ${isOwned ? ownerName : "Tarafsız"}${legal ? " (geçerli hedef)" : ""}`,
  } as const;

  const content = (
    <>
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
        {myAmbushHere && (
          <span className="cq-region-ambush" aria-label="Pusu kurulu (sana özel)" title="Pusu kurulu — yalnızca sana görünür">
            🕳️
          </span>
        )}
        {legal && (
          <span className="cq-region-legal-tag" aria-hidden="true">
            Hedef
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
    </>
  );

  if (isInteractive) {
    return (
      <button
        type="button"
        {...baseProps}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      {...baseProps}
      role="gridcell"
    >
      {content}
    </div>
  );
}
