/**
 * MobileHeader — compact top bar for the Conquest mobile shell.
 *
 * Two-column layout (back / round-badge / spacer) so the badge stays
 * optically centred even with a 38px back button on the left.  Mode label
 * and map name are intentionally omitted on mobile: the lobby and the map
 * itself already supply that context, and every saved row is height we can
 * give back to the board.
 */

import { useState } from "react";
import { playSound } from "../../../lib/sound";
import ConquestVolumeControl from "../ConquestVolumeControl";

interface Props {
  roundNumber: number;
  totalRounds: number;
  onBack:      () => void;
  /** Opens / closes the bonus guide overlay.  Omitted when no bonuses are
   *  assigned for this match (legacy saves) so the slot collapses cleanly. */
  onHelp?:        () => void;
  helpActive?:    boolean;
  /** Called when the volume popover opens — use to close bonus guide. */
  onVolumeOpen?:  () => void;
  /** Account-level Gold balance (own profile).  Rendered as a tiny chip;
   *  omitted when undefined so legacy callers stay byte-identical. */
  accountGold?:   number;
}

export default function MobileHeader({
  roundNumber,
  totalRounds,
  onBack,
  onHelp,
  helpActive,
  onVolumeOpen,
  accountGold,
}: Props) {
  const [closeVolumeKey, setCloseVolumeKey] = useState(0);

  function handleBack() {
    playSound("click");
    onBack();
  }

  function handleHelp() {
    if (!onHelp) return;
    playSound("click");
    setCloseVolumeKey(k => k + 1);
    onHelp();
  }

  return (
    <header className="mcq-header" role="banner">
      <button
        type="button"
        className="mcq-header-back"
        onClick={handleBack}
        aria-label="Lobiye Dön"
        title="Lobiye Dön"
      >
        ←
      </button>
      <div className="mcq-header-center">
        <span
          className="mcq-header-round"
          aria-label={`Tur ${roundNumber} bölü ${totalRounds}`}
        >
          Tur {roundNumber} / {totalRounds}
        </span>
      </div>
      <div className="mcq-header-actions">
        {accountGold !== undefined && (
          <span
            className="cq-gold-chip cq-gold-chip--mobile"
            title="Hesap Gold bakiyen"
            aria-label={`Hesap Gold: ${accountGold}`}
          >
            <span className="cq-gold-chip-icon" aria-hidden="true">🟡</span>
            <span className="cq-gold-chip-value">{accountGold}g</span>
          </span>
        )}
        <ConquestVolumeControl variant="mobile" closeKey={closeVolumeKey} onOpen={onVolumeOpen} />
        {onHelp ? (
          <button
            type="button"
            className="mcq-header-help"
            onClick={handleHelp}
            aria-label="Bonus rehberi"
            aria-pressed={helpActive ? true : false}
            title="Bonus rehberi"
          >
            ?
          </button>
        ) : null}
      </div>
    </header>
  );
}
