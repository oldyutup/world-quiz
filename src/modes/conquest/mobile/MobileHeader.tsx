/**
 * MobileHeader — compact top bar for the Conquest mobile shell.
 *
 * Two-column layout (back / round-badge / spacer) so the badge stays
 * optically centred even with a 38px back button on the left.  Mode label
 * and map name are intentionally omitted on mobile: the lobby and the map
 * itself already supply that context, and every saved row is height we can
 * give back to the board.
 */

import { playSound } from "../../../lib/sound";

interface Props {
  roundNumber: number;
  totalRounds: number;
  onBack:      () => void;
  /** Opens / closes the bonus guide overlay.  Omitted when no bonuses are
   *  assigned for this match (legacy saves) so the slot collapses cleanly. */
  onHelp?:        () => void;
  helpActive?:    boolean;
}

export default function MobileHeader({
  roundNumber,
  totalRounds,
  onBack,
  onHelp,
  helpActive,
}: Props) {
  function handleBack() {
    playSound("click");
    onBack();
  }

  function handleHelp() {
    if (!onHelp) return;
    playSound("click");
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
      ) : (
        <div className="mcq-header-spacer" aria-hidden="true" />
      )}
    </header>
  );
}
